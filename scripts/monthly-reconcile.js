// scripts/monthly-reconcile.js
// Automatic MONTHLY reconciliation of the app's records against BOTH Schwab and
// ETrade, across ALL transaction types the app stores. Runs unattended once a
// month (.github/workflows/monthly-reconcile.yml). Goal: Frank no longer has to
// remember to reconcile manually — he only hears from this job when something
// doesn't tie.
//
// What it does each run:
//   1. Pick the target month (default: the just-finished calendar month).
//   2. For each broker account statement on disk (statements/schwab*,
//      statements/etrade-*), parse the month's statement into broker records.
//   3. Pull the app's records for that month — stock_transactions (all types)
//      and contracts (option opens/closes) — from Supabase (read-only).
//   4. Reconcile each account with api/_lib/reconcileEngine.js.
//   5. Store a reconciliation_runs history row (summary + discrepancies).
//   6. Diff against the previously reconciled state; alert via Pushover ONLY
//      when something needs attention AND it changed since last run. Stay quiet
//      when everything reconciles cleanly (watchdog-style transition alerting).
//   7. Write a heartbeat so the Watchdog can see this job ran.
//
// Run: node --env-file=.env.local scripts/monthly-reconcile.js [--month YYYY-MM]
//
// SAFETY: this job only READS broker statements and app records and IDENTIFIES
// discrepancies. It performs NO UPDATE/DELETE on any transaction, contract, or
// economically meaningful row — it never "fixes the books to balance". Its only
// writes are the reconciliation_runs history row, its dedup state in col_prefs,
// and its ecosystem_heartbeat row. It never touches broker credentials/tokens
// or places/modifies any trade.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  reconcile,
  diffReconciliations,
  summarizeForAlert,
  extractStatementTxns,
  normalizeBroker,
  canonicalType,
} from "../api/_lib/reconcileEngine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATEMENTS_DIR = path.join(__dirname, "..", "statements");
const STATE_ID = "monthly_reconcile_state";
const AGENT = "monthly-reconcile";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const PUSHOVER_API_TOKEN = process.env.PUSHOVER_API_TOKEN;
const PUSHOVER_USER_KEY = process.env.PUSHOVER_USER_KEY;

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** "YYYY-MM" of the calendar month before `now`. */
export function previousMonth(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** First day of a month and first day of the next month, as YYYY-MM-DD. */
export function monthBounds(month) {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const next = new Date(Date.UTC(y, m, 1)); // m is 1-based → Date month m = next month
  const end = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`;
  return { start, end };
}

/**
 * Discover broker statement account directories. Covers Schwab AND every ETrade
 * account folder (statements/etrade-8222, statements/etrade-6917, …) — the old
 * reconcile-statements.js looked only for a single "statements/etrade" that
 * never existed, so ETrade went entirely unreconciled.
 */
export function discoverStatementDirs(statementsDir = STATEMENTS_DIR, fsImpl = fs) {
  if (!fsImpl.existsSync(statementsDir)) return [];
  return fsImpl
    .readdirSync(statementsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => /^(schwab|etrade)/i.test(name))
    .map((name) => ({ account: name, broker: normalizeBroker(name), dir: path.join(statementsDir, name) }))
    .sort((a, b) => a.account.localeCompare(b.account));
}

/** Map an app `contracts` row to a canonical option transaction for the engine. */
export function contractToCanonical(c) {
  return {
    broker: normalizeBroker(c.account),
    account: c.account ?? null,
    date: c.date_exec,
    type: canonicalType(c.opt_type),
    symbol: c.stock,
    net_amount: c.premium,
    schwab_transaction_id: c.schwab_transaction_id ?? null,
    raw: c,
  };
}

// ── Supabase REST (read app records; write only history/state/heartbeat) ──────

function headers() {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };
}

async function sbGet(pathStr) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathStr}`, { headers: headers() });
  if (!r.ok) throw new Error(`Supabase GET ${pathStr}: ${r.status}`);
  return r.json();
}

async function sbInsert(table, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...headers(), Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`Supabase INSERT ${table}: ${r.status}`);
}

async function sbUpsert(table, row, onConflict) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}${onConflict ? `?on_conflict=${onConflict}` : ""}`, {
    method: "POST",
    headers: { ...headers(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row),
  }).catch(() => {});
}

async function notify(title, message, priority = 0) {
  if (!PUSHOVER_API_TOKEN || !PUSHOVER_USER_KEY) return;
  await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: PUSHOVER_API_TOKEN, user: PUSHOVER_USER_KEY, title, message, priority }),
  }).catch(() => {});
}

async function heartbeat(status, notes) {
  const now = new Date().toISOString();
  await sbUpsert(
    "ecosystem_heartbeat",
    { agent_name: AGENT, last_run_at: now, status, notes: String(notes).slice(0, 200), updated_at: now },
    "agent_name"
  );
}

// pdf-parse is CommonJS; import it the same way reconcile-statements.js does.
async function parsePDF(filePath) {
  const mod = await import("pdf-parse");
  const pdfParse = mod.default ?? mod;
  const buf = fs.readFileSync(filePath);
  const data = await pdfParse(buf);
  return data.text;
}

// ── Orchestration ─────────────────────────────────────────────────────────────

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    process.exit(1);
  }

  const monthArg = process.argv.find((a) => a.startsWith("--month="));
  const month = monthArg ? monthArg.split("=")[1] : previousMonth();
  const { start, end } = monthBounds(month);
  console.log(`[monthly-reconcile] month=${month} window ${start} → ${end}`);

  const dirs = discoverStatementDirs();
  if (!dirs.length) {
    console.log("[monthly-reconcile] no statement directories found — nothing to reconcile");
    await heartbeat("ok", "no statement directories");
    return;
  }

  // App records for the month (read-only).
  const stockTxns = await sbGet(
    `stock_transactions?select=id,schwab_transaction_id,symbol,transaction_type,trade_date,net_amount,account&trade_date=gte.${start}T00:00:00Z&trade_date=lt.${end}T00:00:00Z&order=trade_date.asc&limit=10000`
  );
  const contracts = await sbGet(
    `contracts?select=id,stock,opt_type,strike,expires,premium,date_exec,schwab_transaction_id,account&date_exec=gte.${start}&date_exec=lt.${end}&order=date_exec.asc&limit=10000`
  );
  const appTxnsAll = [...stockTxns, ...contracts.map(contractToCanonical)];

  const scopes = [];
  const coverageGaps = [];

  for (const { account, broker, dir } of dirs) {
    const pdf = path.join(dir, `${month}.pdf`);
    const label = `${broker} (${account})`;
    if (!fs.existsSync(pdf)) {
      coverageGaps.push(`${label}: no ${month}.pdf statement on disk`);
      continue;
    }
    let brokerTxns, extract;
    try {
      const text = await parsePDF(pdf);
      extract = extractStatementTxns(text, { broker, month });
      brokerTxns = extract.txns;
    } catch (e) {
      coverageGaps.push(`${label}: statement parse failed — ${e.message}`);
      continue;
    }
    // Honesty guard: a non-empty statement that yields zero recognized
    // transactions means the extractor doesn't understand this broker's format
    // yet — surface it as a gap instead of a false "clean".
    if (extract.lineCount > 0 && brokerTxns.length === 0) {
      coverageGaps.push(`${label}: statement has ${extract.lineCount} lines but 0 recognized transactions (format not yet supported)`);
      continue;
    }

    const appTxns = appTxnsAll.filter((t) => normalizeBroker(t.account ?? t.broker) === broker);
    const result = reconcile({ appTxns, brokerTxns, amountToleranceCents: 1 });
    scopes.push({ label, account, broker, result, summary: result.summary, discrepancyRefs: result.discrepancyRefs });
    console.log(
      `  ${result.summary.clean ? "clean" : "FLAG "} ${label}: ` +
        `${result.summary.matched} matched, ${result.summary.missingFromApp} stmt-only, ` +
        `${result.summary.missingFromBroker} app-only, ${result.summary.amountMismatches} amt-mismatch`
    );
  }

  // Current vs previously reconciled state (stored in col_prefs, watchdog-style).
  const currRefs = scopes.flatMap((s) => s.discrepancyRefs.map((r) => `${s.account}::${r}`));
  const prefRows = await sbGet(`col_prefs?select=cols&id=eq.${STATE_ID}`).catch(() => []);
  const prevRefs = (prefRows && prefRows[0] && prefRows[0].cols && prefRows[0].cols.discrepancyRefs) || [];
  const diff = diffReconciliations(prevRefs, currRefs);
  const alert = summarizeForAlert(scopes, diff);

  // Store history row (identify-only; never mutates transactions).
  await sbInsert("reconciliation_runs", {
    month,
    ran_at: new Date().toISOString(),
    clean: scopes.every((s) => s.summary.clean) && coverageGaps.length === 0,
    summary: {
      scopes: scopes.map((s) => ({ account: s.account, broker: s.broker, ...s.summary })),
      coverageGaps,
      totals: {
        missingFromApp: scopes.reduce((n, s) => n + s.summary.missingFromApp, 0),
        missingFromBroker: scopes.reduce((n, s) => n + s.summary.missingFromBroker, 0),
        amountMismatches: scopes.reduce((n, s) => n + s.summary.amountMismatches, 0),
      },
    },
    discrepancies: scopes.flatMap((s) => s.discrepancyRefs.map((r) => `${s.label} | ${r}`)),
  }).catch((e) => console.error("[monthly-reconcile] history insert failed:", e.message));

  // Alert policy: speak up when there are discrepancies OR a coverage gap, but
  // only when something CHANGED since last run (new discrepancy / gap). Quiet
  // when everything reconciles cleanly and nothing is new.
  const hasGaps = coverageGaps.length > 0;
  const shouldAlert = (alert.needsAttention || hasGaps) && (diff.changed || prefRows.length === 0 || hasGaps);
  if (shouldAlert) {
    const body = [alert.message, hasGaps ? `\nCoverage gaps:\n${coverageGaps.map((g) => `• ${g}`).join("\n")}` : ""]
      .filter(Boolean)
      .join("\n");
    await notify(alert.title, `${month}\n${body}`, alert.needsAttention ? 1 : 0);
    console.log(`[monthly-reconcile] alerted: ${alert.title}`);
  } else {
    console.log("[monthly-reconcile] clean / unchanged — staying quiet");
  }

  await sbUpsert("col_prefs", {
    id: STATE_ID,
    cols: { discrepancyRefs: currRefs, month, updated_at: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  });

  await heartbeat(alert.needsAttention || hasGaps ? "warn" : "ok", `${month}: ${currRefs.length} open discrepancy ref(s), ${coverageGaps.length} gap(s)`);
}

// Only run when invoked directly — importing for tests must be side-effect free.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error("[monthly-reconcile] fatal:", e.message);
    process.exit(1);
  });
}
