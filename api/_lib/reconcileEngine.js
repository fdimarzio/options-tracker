// api/_lib/reconcileEngine.js
// Broker- and transaction-type-agnostic reconciliation core for the monthly
// broker reconciliation job (scripts/monthly-reconcile.js) and, later, any
// other reconciliation path. PURE: no network, no filesystem, no Supabase —
// it takes normalized app records and authoritative broker records in, and
// returns a classified result out. That keeps it exhaustively unit-testable.
//
// It generalizes the two one-off reconcilers already in the repo:
//   • reconcile.cjs            — Schwab OPTIONS contracts, static JSON, SQL out
//   • scripts/reconcile-statements.js — Schwab EQUITY statement vs DB, text out
// into one engine that covers BOTH brokers (Schwab + ETrade) and ALL
// transaction types the app's transaction model stores (equity buy/sell,
// dividends, interest, deposits/withdrawals, journals, transfers, tax, fees,
// and the option opens/closes/expirations/assignments/exercises).
//
// SAFETY: this module only IDENTIFIES discrepancies. It never emits anything
// that mutates economically meaningful transaction history — no UPDATE/DELETE,
// no auto-"fix to balance". That rule lives in the task and is enforced by the
// runner; the engine simply classifies.

// ── Normalization ───────────────────────────────────────────────────────────

/** Map a broker/account string to a canonical broker name. */
export function normalizeBroker(accountOrBroker) {
  const s = String(accountOrBroker ?? "").trim().toLowerCase();
  if (!s) return "Unknown";
  if (s.includes("etrade") || s.includes("e*trade") || s.includes("e-trade")) return "ETrade";
  if (s.includes("schwab")) return "Schwab";
  return "Unknown";
}

/** cents, integer — avoids float comparison drift. null stays null. */
export function normalizeAmountCents(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(/[$,]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** YYYY-MM-DD from ISO, MM/DD/YYYY, or a Date. null stays null. */
export function normalizeDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const mdY = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdY) return `${mdY[3]}-${mdY[1].padStart(2, "0")}-${mdY[2].padStart(2, "0")}`;
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function normalizeSymbol(v) {
  const s = String(v ?? "").trim().toUpperCase();
  return s || "CASH";
}

// Canonical transaction-type vocabulary. Kept aligned with the types the app's
// importer writes (api/auto-import.js, scripts/backfill-stock-transactions.js):
// BUY SELL DIVIDEND INTEREST DEPOSIT WITHDRAWAL JOURNAL TRANSFER_IN TRANSFER_OUT
// TAX_WITHHOLDING REINVEST FEE, plus the option legs and lifecycle events.
const TYPE_SYNONYMS = {
  buy: "BUY", bought: "BUY", purchase: "BUY",
  sell: "SELL", sold: "SELL", sale: "SELL",
  dividend: "DIVIDEND", div: "DIVIDEND", "qualified dividend": "DIVIDEND",
  interest: "INTEREST",
  deposit: "DEPOSIT", wire: "DEPOSIT", "ach deposit": "DEPOSIT", contribution: "DEPOSIT",
  withdrawal: "WITHDRAWAL", "ach withdrawal": "WITHDRAWAL", distribution: "WITHDRAWAL",
  journal: "JOURNAL",
  transfer_in: "TRANSFER_IN", transfer_out: "TRANSFER_OUT", transfer: "TRANSFER_IN",
  tax_withholding: "TAX_WITHHOLDING", "tax withholding": "TAX_WITHHOLDING", tax: "TAX_WITHHOLDING",
  reinvest: "REINVEST", reinvestment: "REINVEST",
  fee: "FEE", commission: "FEE",
  sto: "OPTION_STO", bto: "OPTION_BTO", stc: "OPTION_STC", btc: "OPTION_BTC",
  expired: "OPTION_EXPIRED", expiration: "OPTION_EXPIRED",
  assigned: "ASSIGNMENT", assignment: "ASSIGNMENT",
  exercise: "EXERCISE", exercised: "EXERCISE",
};

export function canonicalType(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "OTHER";
  if (TYPE_SYNONYMS[s]) return TYPE_SYNONYMS[s];
  // already canonical?
  const upper = s.toUpperCase();
  const known = new Set(Object.values(TYPE_SYNONYMS));
  if (known.has(upper)) return upper;
  // substring fallbacks for noisy statement descriptions
  for (const [k, v] of Object.entries(TYPE_SYNONYMS)) {
    if (s.includes(k)) return v;
  }
  return "OTHER";
}

/**
 * Normalize an app or broker record into the engine's canonical shape.
 * Accepts the loose field names used across the app's two transaction stores
 * (stock_transactions and contracts) and broker/statement records.
 */
export function normalizeTxn(raw = {}) {
  const broker = normalizeBroker(raw.broker ?? raw.brokerage ?? raw.account);
  const date = normalizeDate(
    raw.date ?? raw.trade_date ?? raw.tradeDate ?? raw.date_exec ?? raw.settlementDate
  );
  const type = canonicalType(raw.type ?? raw.transaction_type ?? raw.opt_type ?? raw.activityType);
  const symbol = normalizeSymbol(raw.symbol ?? raw.stock ?? raw.ticker);
  const amountCents = normalizeAmountCents(
    raw.amountCents != null ? raw.amountCents / 100 : (raw.net_amount ?? raw.netAmount ?? raw.amount ?? raw.premium)
  );
  const brokerTxnId =
    raw.brokerTxnId ?? raw.schwab_transaction_id ?? raw.schwabTransactionId ?? raw.transactionId ?? null;
  return {
    broker,
    account: raw.account ?? null,
    date,
    type,
    symbol,
    amountCents,
    brokerTxnId: brokerTxnId != null ? String(brokerTxnId) : null,
    raw,
  };
}

/** Strict match key: date, type, symbol, amount (cents). */
export function matchKey(t) {
  return [t.date, t.type, t.symbol, t.amountCents].join("|");
}

/** Amount-agnostic key: same economic event, premium/amount may differ. */
export function fuzzyKey(t) {
  return [t.date, t.type, t.symbol].join("|");
}

function ref(t) {
  const amt = t.amountCents == null ? "?" : (t.amountCents / 100).toFixed(2);
  return `${t.date ?? "?"} ${t.type} ${t.symbol} $${amt}${t.brokerTxnId ? ` #${t.brokerTxnId}` : ""}`;
}

// ── Reconcile ────────────────────────────────────────────────────────────────

/**
 * Reconcile app records against authoritative broker records for one scope
 * (typically one broker account, one month).
 *
 * Matching passes, each consuming from a pool so duplicates pair up 1:1:
 *   1. broker transaction id (when both sides carry one)
 *   2. strict key   (date|type|symbol|amount)
 *   3. fuzzy key    (date|type|symbol) — within amountToleranceCents → matched
 *      (records the amount delta); beyond tolerance → amount mismatch.
 *
 * Returns matched / missingFromApp (on the broker, absent from the app) /
 * missingFromBroker (in the app, not on the broker statement) / amountMismatches,
 * plus a summary with `clean` = nothing needs attention.
 */
export function reconcile({ appTxns = [], brokerTxns = [], amountToleranceCents = 0 } = {}) {
  const app = appTxns.map(normalizeTxn);
  const brk = brokerTxns.map(normalizeTxn);

  const matched = [];
  const amountMismatches = [];
  const usedApp = new Set();
  const usedBrk = new Set();

  const indexBy = (arr, keyFn, usedSet) => {
    const m = new Map();
    arr.forEach((t, i) => {
      if (usedSet.has(i)) return;
      const k = keyFn(t);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(i);
    });
    return m;
  };

  const consume = (keyFn, onPair) => {
    const brkIdx = indexBy(brk, keyFn, usedBrk);
    for (let ai = 0; ai < app.length; ai++) {
      if (usedApp.has(ai)) continue;
      const k = keyFn(app[ai]);
      const bucket = brkIdx.get(k);
      while (bucket && bucket.length) {
        const bi = bucket.shift();
        if (usedBrk.has(bi)) continue;
        usedApp.add(ai);
        usedBrk.add(bi);
        onPair(ai, bi);
        break;
      }
    }
  };

  // Pass 1 — broker transaction id (only entries that actually carry one).
  consume(
    (t) => (t.brokerTxnId ? `ID|${t.brokerTxnId}` : `ID|__none__${Math.random()}`),
    (ai, bi) => matched.push({ app: app[ai], broker: brk[bi], via: "broker_txn_id" })
  );

  // Pass 2 — strict key.
  consume(matchKey, (ai, bi) => matched.push({ app: app[ai], broker: brk[bi], via: "exact" }));

  // Pass 3 — fuzzy key; classify by amount delta.
  consume(fuzzyKey, (ai, bi) => {
    const a = app[ai], b = brk[bi];
    const diff =
      a.amountCents != null && b.amountCents != null ? Math.abs(a.amountCents - b.amountCents) : null;
    if (diff == null || diff <= amountToleranceCents) {
      matched.push({ app: a, broker: b, via: "fuzzy", amountDeltaCents: diff ?? null });
    } else {
      amountMismatches.push({ app: a, broker: b, diffCents: diff });
    }
  });

  const missingFromBroker = app.filter((_, i) => !usedApp.has(i)); // in app, not on statement
  const missingFromApp = brk.filter((_, i) => !usedBrk.has(i)); // on statement, not in app

  const summary = {
    appCount: app.length,
    brokerCount: brk.length,
    matched: matched.length,
    missingFromApp: missingFromApp.length,
    missingFromBroker: missingFromBroker.length,
    amountMismatches: amountMismatches.length,
    clean: missingFromApp.length === 0 && missingFromBroker.length === 0 && amountMismatches.length === 0,
  };

  return {
    matched,
    missingFromApp,
    missingFromBroker,
    amountMismatches,
    summary,
    // Stable, serializable fingerprint of what needs attention — used to diff
    // against the previously reconciled state so alerts only fire on changes.
    discrepancyRefs: [
      ...missingFromApp.map((t) => `MISSING_FROM_APP|${ref(t)}`),
      ...missingFromBroker.map((t) => `MISSING_FROM_BROKER|${ref(t)}`),
      ...amountMismatches.map((m) => `AMOUNT|${ref(m.app)}|vs|${ref(m.broker)}`),
    ].sort(),
  };
}

// ── Diff against previously reconciled state ─────────────────────────────────

/**
 * Compare the previous run's discrepancy fingerprint with the current one.
 * prevRefs / currRefs are arrays of discrepancyRefs strings.
 */
export function diffReconciliations(prevRefs = [], currRefs = []) {
  const prev = new Set(prevRefs);
  const curr = new Set(currRefs);
  const newDiscrepancies = currRefs.filter((r) => !prev.has(r));
  const resolved = prevRefs.filter((r) => !curr.has(r));
  return { newDiscrepancies, resolved, changed: newDiscrepancies.length > 0 || resolved.length > 0 };
}

// ── Alert summarization (pure; runner owns the actual send + dedup) ──────────

/**
 * Decide whether an alert is warranted and build its text. `needsAttention`
 * is false when every scope reconciled cleanly → the runner stays quiet.
 * When discrepancies exist but none are NEW since last run, `isNew` is false so
 * the runner can suppress a repeat (watchdog-style transition-only alerting).
 */
export function summarizeForAlert(scopes = [], diff = { newDiscrepancies: [], resolved: [] }) {
  const dirty = scopes.filter((s) => !s.summary.clean);
  const needsAttention = dirty.length > 0;
  const totalDisc = scopes.reduce(
    (n, s) => n + s.summary.missingFromApp + s.summary.missingFromBroker + s.summary.amountMismatches,
    0
  );
  const lines = [];
  for (const s of dirty) {
    lines.push(
      `• ${s.label}: ${s.summary.missingFromApp} on statement not in app, ` +
        `${s.summary.missingFromBroker} in app not on statement, ` +
        `${s.summary.amountMismatches} amount mismatch(es)`
    );
  }
  if (diff.resolved && diff.resolved.length) lines.push(`(${diff.resolved.length} previously-flagged item(s) now resolved)`);
  return {
    needsAttention,
    isNew: (diff.newDiscrepancies || []).length > 0,
    title: needsAttention
      ? `🧾 Reconciliation: ${totalDisc} item(s) need review`
      : `✅ Reconciliation clean`,
    message: lines.join("\n") || "All broker accounts reconcile cleanly.",
  };
}

// ── Statement extraction (heuristic; generalizes reconcile-statements.js) ─────

// Broker monthly statements are the authoritative source. This extractor
// generalizes the single-broker, equity-only line heuristic already in
// scripts/reconcile-statements.js to all transaction types. It is intentionally
// conservative: lines it cannot confidently classify are returned in `unparsed`
// so the runner can surface a COVERAGE GAP for that statement rather than
// silently pretending a format parsed cleanly. The per-broker regexes still
// need validation against each broker's real statement layout before that
// broker's reconciliation is trusted — same caveat the original carried.
const STATEMENT_LINE =
  /^(\d{1,2}\/\d{1,2}\/\d{4})\s+(Bought|Sold|Buy|Sell|Dividend|Interest|Wire|Journal|Transfer|Deposit|Withdrawal|Fee|Commission|Reinvest|Assigned|Assignment|Exercise[d]?|Expired|Expiration)\b(.*)$/i;

export function extractStatementTxns(text, { broker = "Unknown", month = null } = {}) {
  const txns = [];
  const unparsed = [];
  const recognizedTypes = {};
  const lines = String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const m = line.match(STATEMENT_LINE);
    if (!m) {
      // Only treat date-leading lines as candidate transactions worth flagging.
      if (/^\d{1,2}\/\d{1,2}\/\d{4}\s/.test(line)) unparsed.push(line);
      continue;
    }
    const [, dateStr, rawType, rest] = m;
    const date = normalizeDate(dateStr);
    if (month && date && !date.startsWith(month)) continue;
    const type = canonicalType(rawType);
    recognizedTypes[type] = (recognizedTypes[type] || 0) + 1;
    const symMatch = rest.match(/\b([A-Z]{1,5})\b/);
    const amtMatch = rest.match(/-?\$?[\d,]+\.\d{2}/g);
    txns.push({
      broker,
      date,
      transaction_type: type,
      symbol: symMatch ? symMatch[1] : "CASH",
      net_amount: amtMatch ? amtMatch[amtMatch.length - 1].replace(/[$,]/g, "") : null,
      source: "statement",
    });
  }

  return { txns, unparsed, recognizedTypes, lineCount: lines.length };
}
