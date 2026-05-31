// api/auto-import.js
// Auto-imports Schwab + ETrade transactions, commits exact/partial matches,
// logs anomalies to import_anomalies table, sends Pushover alerts.
// Also serves anomaly CRUD via ?action=anomalies|dismiss|resolve

import crypto from "crypto";

const SUPABASE_URL  = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY  = process.env.VITE_SUPABASE_ANON_KEY;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY; // service key for token rows
const SCHWAB_BASE   = "https://api.schwabapi.com";
const APP_URL       = "https://options-tracker-five.vercel.app";
const CUTOVER_DATE  = "2026-05-10";

// ── Supabase helpers ──────────────────────────────────────────────────────────
const sbHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };
const svcHeaders = { apikey: SUPABASE_SVC_KEY, Authorization: `Bearer ${SUPABASE_SVC_KEY}`, "Content-Type": "application/json" }; // service key — token rows only

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
  return r.json();
}

async function sbPost(table, body, prefer = "resolution=ignore-duplicates") {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST", headers: { ...sbHeaders, Prefer: prefer }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sbPost ${table}: ${await r.text()}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

async function sbPatch(table, id, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: "PATCH", headers: { ...sbHeaders, Prefer: "return=representation" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sbPatch ${table}: ${await r.text()}`);
  return r.json();
}

async function sbUpsert(table, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sbUpsert ${table}: ${await r.text()}`);
  return r.json().catch(() => null);
}

// ── Fetch nearest option_snapshot to a given timestamp ───────────────────────
// Returns entry/exit context fields ready to spread onto a contract row.
// Wraps in try/catch so a snapshot miss never blocks the import.
async function fetchNearestSnapshot(symbol, strike, expiry, optType, timestamp, prefix = "entry") {
  try {
    if (!symbol || !strike || !expiry || !optType || !timestamp) return {};
    // Normalise opt_type to what option_snapshots stores ("call" / "put")
    const snapOptType = optType === "Put" ? "put" : "call";
    // Query ±4 hours around the timestamp to catch pre/post market imports
    const ts   = new Date(timestamp);
    const from = new Date(ts.getTime() - 4 * 3600000).toISOString();
    const to   = new Date(ts.getTime() + 4 * 3600000).toISOString();
    const qs   = new URLSearchParams({
      symbol:      `eq.${symbol.toUpperCase()}`,
      strike:      `eq.${parseFloat(strike)}`,
      expiry:      `eq.${expiry}`,
      opt_type:    `eq.${snapOptType}`,
      snapshot_at: `gte.${from}`,
      // Use PostgREST range filter for upper bound
    });
    const path = `option_snapshots?symbol=eq.${encodeURIComponent(symbol.toUpperCase())}&strike=eq.${parseFloat(strike)}&expiry=eq.${expiry}&opt_type=eq.${snapOptType}&snapshot_at=gte.${from}&snapshot_at=lte.${to}&order=snapshot_at.asc&limit=500&select=id,snapshot_at,iv,delta,theta,vega,bid,ask,dte,stock_price,stock_change_pct,otm_pct,vix,rsi14,sma20,sma50,sma200,sma_alignment,trend_regime`;
    const rows = await sbGet(path);
    if (!Array.isArray(rows) || !rows.length) {
      console.log(`[auto-import] no snapshot found for ${symbol} ${optType} $${strike} ${expiry} near ${timestamp}`);
      return {};
    }
    // Pick the row closest in time to the target timestamp
    const tgt = ts.getTime();
    const best = rows.reduce((a, b) =>
      Math.abs(new Date(a.snapshot_at).getTime() - tgt) <= Math.abs(new Date(b.snapshot_at).getTime() - tgt) ? a : b
    );
    const p = prefix;
    const result = {
      [`${p}_snapshot_id`]:       best.id,
      [`${p}_iv`]:                best.iv             ?? null,
      [`${p}_delta`]:             best.delta          ?? null,
      [`${p}_bid`]:               best.bid            ?? null,
      [`${p}_ask`]:               best.ask            ?? null,
      [`${p}_dte`]:               best.dte            ?? null,
      [`${p}_stock_price`]:       best.stock_price    ?? null,
      [`${p}_stock_chg_pct`]:     best.stock_change_pct ?? null,
      [`${p}_otm_pct`]:           best.otm_pct        ?? null,
      [`${p}_vix`]:               best.vix            ?? null,
      [`${p}_rsi14`]:             best.rsi14          ?? null,
      [`${p}_trend_regime`]:      best.trend_regime   ?? null,
    };
    // entry-only: exit columns don't include full SMA set
    if (p === "entry") {
      result[`${p}_theta`]         = best.theta         ?? null;
      result[`${p}_vega`]          = best.vega          ?? null;
      result[`${p}_sma20`]         = best.sma20         ?? null;
      result[`${p}_sma50`]         = best.sma50         ?? null;
      result[`${p}_sma200`]        = best.sma200        ?? null;
      result[`${p}_sma_alignment`] = best.sma_alignment ?? null;
    }
    return result;
  } catch (e) {
    console.warn(`[auto-import] fetchNearestSnapshot failed for ${symbol} ${strike} ${expiry}:`, e.message);
    return {};
  }
}

// ── Schwab token ──────────────────────────────────────────────────────────────
async function getValidToken() {
  // Use service key — schwab_tokens is protected from anon access
  const res  = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_tokens`, { headers: svcHeaders });
  const rows = await res.json();
  const t    = rows?.[0]?.cols;
  if (!t?.accessToken) throw new Error("No Schwab tokens");
  if (t.accessTokenExpiresAt > Date.now() + 120000) return t.accessToken;
  if (!t.refreshToken || t.refreshTokenExpiresAt < Date.now()) throw new Error("Refresh token expired");
  const creds = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString("base64");
  const tr    = await fetch("https://api.schwabapi.com/v1/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken }),
  });
  const n = await tr.json();
  if (!n.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(n)}`);
  // Write back with service key
  await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
    method: "POST",
    headers: { ...svcHeaders, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: "schwab_tokens", cols: { ...t, accessToken: n.access_token, refreshToken: n.refresh_token || t.refreshToken, accessTokenExpiresAt: Date.now() + (n.expires_in * 1000) }, updated_at: new Date().toISOString() }),
  });
  return n.access_token;
}

// ── ETrade helpers ────────────────────────────────────────────────────────────
const ETRADE_BASE     = "https://api.etrade.com";
const ETRADE_ACCOUNTS = { "227156917": "ETrade 6917", "227418222": "ETrade 8222" };
const ETRADE_TX_MAP   = { "Sold Short": "STO", "Sold": "STO", "Bought To Open": "BTO", "Bought To Cover": "BTC", "Bought": "BTC", "Sold To Close": "STC", "Option Assigned": "ASSIGNED", "Expired": "EXPIRED", "Option Expired": "EXPIRED" };

function buildOAuthHeader(method, url, accessToken, accessTokenSecret, params = {}) {
  const consumerKey    = process.env.ETRADE_CONSUMER_KEY;
  const consumerSecret = process.env.ETRADE_CONSUMER_SECRET;
  const nonce          = crypto.randomBytes(16).toString("hex");
  const timestamp      = Math.floor(Date.now() / 1000).toString();
  const oauthParams    = { oauth_consumer_key: consumerKey, oauth_nonce: nonce, oauth_signature_method: "HMAC-SHA1", oauth_timestamp: timestamp, oauth_token: accessToken, oauth_version: "1.0" };
  const allParams      = { ...oauthParams, ...params };
  const sortedParams   = Object.keys(allParams).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`).join("&");
  const baseString     = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(sortedParams)}`;
  const signingKey     = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(accessTokenSecret)}`;
  const signature      = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
  const headerParams   = { ...oauthParams, oauth_signature: signature };
  return "OAuth " + Object.keys(headerParams).sort().map(k => `${encodeURIComponent(k)}="${encodeURIComponent(headerParams[k])}"`).join(", ");
}

async function etradeGet(path, queryParams = {}) {
  // Use service key — etrade_tokens is protected from anon access
  const etr  = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.etrade_tokens`, { headers: svcHeaders });
  const rows = await etr.json();
  const t    = rows?.[0]?.cols;
  if (!t?.accessToken || !t?.accessTokenSecret) throw new Error("No ETrade tokens");
  const urlBase    = `${ETRADE_BASE}${path}`;
  const qs         = Object.keys(queryParams).length ? "?" + new URLSearchParams(queryParams).toString() : "";
  const authHeader = buildOAuthHeader("GET", urlBase, t.accessToken, t.accessTokenSecret, queryParams);
  const res        = await fetch(urlBase + qs, { headers: { Authorization: authHeader, Accept: "application/json" } });
  const text       = await res.text();
  if (text.trim().startsWith("<")) throw new Error(`ETrade XML (${res.status}) — token expired`);
  const data = JSON.parse(text);
  if (!res.ok) throw new Error(`ETrade ${res.status}: ${data?.Error?.message || text.slice(0, 200)}`);
  return data;
}

function fmtEtradeDate(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${m}${String(d.getFullYear())}${day}`.slice(0, 2) + String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}
function fmtDate(d) {
  const dt = new Date(d);
  return `${String(dt.getMonth()+1).padStart(2,"0")}${String(dt.getFullYear())}${String(dt.getDate()).padStart(2,"0")}`;
}

// ── Live quote fetch for tickers missing from stocksData ─────────────────────
async function fetchLivePrice(symbol, token) {
  try {
    const url = `${SCHWAB_BASE}/marketdata/v1/quotes?symbols=${encodeURIComponent(symbol)}&fields=quote&indicative=false`;
    const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    const q    = data?.[symbol]?.quote;
    return q?.lastPrice || q?.mark || q?.bidPrice || null;
  } catch(e) {
    console.warn(`[auto-import] fetchLivePrice failed for ${symbol}:`, e.message);
    return null;
  }
}

// ── Parsers ───────────────────────────────────────────────────────────────────
function parseSchwabTx(tx, stocksData, accountNumber) {
  const items   = tx.transferItems || [];
  const optItem = items.find(i => i.instrument?.assetType === "OPTION");
  if (!optItem) return null;
  const inst    = optItem.instrument;
  const effect  = optItem.positionEffect;
  const netAmt  = tx.netAmount || 0;
  const desc    = (tx.description || "").toUpperCase();

  let optType;
  if (effect === "OPENING") {
    optType = netAmt > 0 ? "STO" : "BTO";
  } else if (netAmt === 0 || desc.includes("EXPIR")) {
    // Zero-value closing = expired worthless
    optType = "EXPIRED";
  } else {
    optType = netAmt < 0 ? "BTC" : "STC";
  }

  const symbol   = inst.underlyingSymbol || inst.symbol?.slice(0, 6).trim();
  const dateExec = new Date(tx.tradeDate || tx.time).toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);
  return {
    schwab_transaction_id: String(tx.activityId),
    stock:    symbol?.toUpperCase(),
    type:     inst.putCall === "CALL" ? "Call" : "Put",
    opt_type: optType,
    strike:   inst.strikePrice,
    expires:  inst.expirationDate?.slice(0, 10),
    qty:      Math.abs(optItem.amount || 0),
    premium:  Math.round(netAmt * 100) / 100,
    date_exec: dateExec,
    account:  accountNumber ? `Schwab ${String(accountNumber).slice(-4)}` : "Schwab",
    price_at_execution: stocksData?.[symbol?.toUpperCase()]?.currentPrice || null,
    raw: tx,
  };
}

function parseEtradeTx(tx, stocksData) {
  const br      = tx.brokerage;
  const prod    = br?.product;
  if (!prod || prod.securityType !== "OPTN") return null;

  // For ambiguous "Bought" and "Sold" types, use description to determine opening vs closing
  let optType = ETRADE_TX_MAP[tx.transactionType];
  if (!optType) return null;
  if (tx.transactionType === "Bought") {
    const isOpening = tx.description?.toUpperCase().includes("OPENING");
    optType = isOpening ? "BTO" : "BTC";
  } else if (tx.transactionType === "Sold") {
    const isClosing = tx.description?.toUpperCase().includes("CLOSING");
    optType = isClosing ? "STC" : "STO";
  }
  const symbol   = prod.symbol?.toUpperCase();
  const expiryYY = String(prod.expiryYear).padStart(2, "0").slice(-2);
  const expires  = `20${expiryYY}-${String(prod.expiryMonth).padStart(2,"0")}-${String(prod.expiryDay).padStart(2,"0")}`;
  const dateExec = new Date(tx.transactionDate).toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);
  const account  = ETRADE_ACCOUNTS[String(tx.accountId)] || `ETrade ${String(tx.accountId).slice(-4)}`;
  return {
    schwab_transaction_id: `etrade_${tx.transactionId}`,
    stock:    symbol,
    type:     prod.callPut === "CALL" ? "Call" : "Put",
    opt_type: optType,
    strike:   prod.strikePrice,
    expires,
    qty:      Math.abs(br.quantity || 0),
    premium:  Math.round((tx.amount || 0) * 100) / 100,
    date_exec: dateExec,
    account,
    exercised: optType === "ASSIGNED" ? "Yes" : "No",
    price_at_execution: stocksData?.[symbol]?.currentPrice || null,
    raw: tx,
  };
}

// ── Match closer to open contract ─────────────────────────────────────────────
function matchToOpen(parsed, openContracts) {
  if (!["BTC","STC","ASSIGNED","EXPIRED"].includes(parsed.opt_type)) return { matchId: null, matchConfidence: null };
  const candidates = openContracts.filter(c =>
    c.stock?.toUpperCase() === parsed.stock?.toUpperCase() &&
    c.type   === parsed.type &&
    +c.strike === +parsed.strike &&
    c.expires === parsed.expires
  );
  if (!candidates.length) return { matchId: null, matchConfidence: "unmatched" };
  // Prefer same account + exact qty
  const sameAcctExact = candidates.find(c => c.account === parsed.account && +c.qty === +parsed.qty);
  if (sameAcctExact) return { matchId: sameAcctExact.id, matchConfidence: "exact" };
  // Exact qty any account (only if unique)
  const exactQty = candidates.filter(c => +c.qty === +parsed.qty);
  if (exactQty.length === 1) return { matchId: exactQty[0].id, matchConfidence: "exact" };
  // Same account any qty
  const sameAcct = candidates.filter(c => c.account === parsed.account);
  if (sameAcct.length) {
    const best = sameAcct.reduce((a,b) => Math.abs(+a.qty - +parsed.qty) < Math.abs(+b.qty - +parsed.qty) ? a : b);
    return { matchId: best.id, matchConfidence: "partial" };
  }
  // Fallback closest qty
  const best = candidates.reduce((a,b) => Math.abs(+a.qty - +parsed.qty) < Math.abs(+b.qty - +parsed.qty) ? a : b);
  return { matchId: best.id, matchConfidence: "partial" };
}

// ── Check if a BTC/STC transaction was already handled by a trade_order ───────
// Returns true if we should skip creating a new orphan row
async function alreadyHandledByTradeOrder(parsed) {
  if (!["BTC","STC"].includes(parsed.opt_type)) return false;
  try {
    const orders = await sbGet(
      `trade_orders?ticker=eq.${parsed.stock}&strike=eq.${parsed.strike}&opt_type=eq.BTC&status=in.(filled,submitted)&account=eq.${encodeURIComponent(parsed.account)}&limit=5`
    );
    if (!Array.isArray(orders) || !orders.length) return false;
    // Match by qty and approximate date
    const match = orders.find(o =>
      +o.qty === +parsed.qty &&
      Math.abs(new Date(o.filled_at || o.created_at) - new Date(parsed.date_exec)) < 2 * 86400000
    );
    if (match) {
      console.log(`[auto-import] skipping orphan BTC — already handled by trade_order ${match.id}`);
      return true;
    }
  } catch(e) { console.warn("[auto-import] alreadyHandledByTradeOrder check failed:", e.message); }
  return false;
}

// ── Commit a transaction to contracts table ───────────────────────────────────
async function commitTx(parsed, matchId, openContracts, stocksData, committedClosers = {}) {

  // ── BTC/STC split fill merge: if a same-day closer for same stock/strike/expires/account
  // already exists in this batch (in-memory), merge into it instead of inserting a new row.
  // This handles Schwab split fills where one BTC order executes in multiple fills.
  if (["BTC","STC"].includes(parsed.opt_type)) {
    const normalizeExp = e => { if (!e) return ""; const d = new Date(e); return isNaN(d) ? String(e) : d.toISOString().slice(0,10); };
    const closerKey = `${parsed.stock?.toUpperCase()}|${parsed.opt_type}|${parseFloat(parsed.strike)}|${normalizeExp(parsed.expires)}|${parsed.account}|${parsed.date_exec}`;
    const existingCloser = committedClosers[closerKey];
    if (existingCloser) {
      // Merge this fill into the already-committed closer row
      const newQty     = (+existingCloser.qty || 0) + (+parsed.qty || 0);
      const newPremium = Math.round(((+existingCloser.premium || 0) + (+parsed.premium || 0)) * 100) / 100;
      const daysHeld   = existingCloser.parent?.date_exec
        ? Math.ceil((new Date(parsed.date_exec) - new Date(existingCloser.parent.date_exec)) / 86400000)
        : null;
      const profit     = existingCloser.parent
        ? Math.round(((+existingCloser.parent.premium || 0) + newPremium) * 100) / 100
        : null;
      const profitPct  = profit != null && existingCloser.parent?.premium
        ? Math.round((profit / Math.abs(+existingCloser.parent.premium)) * 10000) / 10000
        : null;
      await sbPatch("contracts", existingCloser.id, {
        qty:     newQty,
        premium: newPremium,
        ...(profit    != null ? { profit }     : {}),
        ...(profitPct != null ? { profit_pct: profitPct } : {}),
        ...(daysHeld  != null ? { days_held: daysHeld }  : {}),
        notes: `Split fill merged: +${parsed.qty} @ $${parsed.premium} (tx: ${parsed.schwab_transaction_id})`,
      });
      // Update in-memory tracker
      existingCloser.qty     = newQty;
      existingCloser.premium = newPremium;
      // Also update parent cost_to_close on STO row
      if (existingCloser.parent) {
        await sbPatch("contracts", existingCloser.parent.id, {
          cost_to_close: Math.abs(newPremium),
          ...(profit    != null ? { profit }     : {}),
          ...(profitPct != null ? { profit_pct: profitPct } : {}),
        });
      }
      console.log(`[auto-import] BTC split fill merged: ${parsed.stock} $${parsed.strike} ${parsed.expires} qty +${parsed.qty} into contract ${existingCloser.id} (total qty now ${newQty})`);
      return true;
    }
  }

  // ── Partial fill merge: if opening order (STO/BTO) matches an existing open
  // contract on same stock + opt_type + strike + expires + account + date_exec,
  // merge into it (add qty, sum premium) instead of creating a duplicate row
  if (["STO","BTO"].includes(parsed.opt_type)) {
    const normalizeExp = e => { if (!e) return ""; const d = new Date(e); return isNaN(d) ? String(e) : d.toISOString().slice(0,10); };
    const existing = openContracts.find(c =>
      c.stock?.toUpperCase()    === parsed.stock?.toUpperCase() &&
      c.opt_type                === parsed.opt_type &&
      parseFloat(c.strike)      === parseFloat(parsed.strike) &&
      normalizeExp(c.expires)   === normalizeExp(parsed.expires) &&
      // Flexible account match — handles "Schwab" vs "Schwab 3866" mismatch
      (c.account                === parsed.account ||
       (c.account?.startsWith("Schwab") && parsed.account?.startsWith("Schwab")) ||
       (c.account?.startsWith("ETrade") && parsed.account?.startsWith("ETrade")) ||
       (c.account?.startsWith("Etrade") && parsed.account?.startsWith("Etrade"))) &&
      c.date_exec               === parsed.date_exec &&
      c.status                  === "Open"
    );
    if (existing) {
      // Guard: don't merge if this transaction was already merged into this contract
      const alreadyMerged = existing.notes?.includes(String(parsed.schwab_transaction_id));
      if (alreadyMerged) {
        console.log(`[auto-import] skipping already-merged tx ${parsed.schwab_transaction_id} into contract ${existing.id}`);
        return;
      }
      // Guard: if existing contract qty >= incoming qty, this is a re-issued ETrade partial
      // for fills already counted — skip to avoid inflating qty
      if (+existing.qty >= +parsed.qty) {
        console.log(`[auto-import] skipping re-issued ETrade partial: ${parsed.stock} ${parsed.opt_type} $${parsed.strike} ${parsed.expires} ${parsed.account} — existing qty ${existing.qty} >= incoming qty ${parsed.qty}`);
        return;
      }
      const newQty     = (+existing.qty || 0) + (+parsed.qty || 0);
      const newPremium = Math.round(((+existing.premium || 0) + (+parsed.premium || 0)) * 100) / 100;
      await sbPatch("contracts", existing.id, {
        qty:                    newQty,
        premium:                newPremium,
        schwab_transaction_id:  existing.schwab_transaction_id, // keep original
        notes:                  `Partial fill merged: ${parsed.qty} @ $${parsed.premium} on ${parsed.date_exec} (tx: ${parsed.schwab_transaction_id})`,
      });
      // Update in-memory openContracts so subsequent logic sees the merged state
      existing.qty     = newQty;
      existing.premium = newPremium;
      console.log(`[auto-import] partial fill merged: ${parsed.stock} ${parsed.opt_type} $${parsed.strike} ${parsed.expires} qty ${existing.qty - (+parsed.qty||0)}+${parsed.qty}=${newQty}`);
      return true;
    }
  }

  // Insert the transaction
  const row = {
    schwab_transaction_id: parsed.schwab_transaction_id,
    stock:    parsed.stock,
    type:     parsed.type,
    opt_type: parsed.opt_type === "ASSIGNED" ? "BTC" : parsed.opt_type,
    strike:   +parsed.strike,
    expires:  parsed.expires,
    qty:      +parsed.qty,
    // Enforce sign: BTO/BTC = cash out (negative), STO/STC = cash in (positive)
    premium:  ["BTO","BTC"].includes(parsed.opt_type) ? -Math.abs(parsed.premium || 0)
            : ["STO","STC"].includes(parsed.opt_type) ?  Math.abs(parsed.premium || 0)
            : parsed.premium,
    date_exec: parsed.date_exec,
    account:  parsed.account,
    status:   ["BTC","STC","ASSIGNED"].includes(parsed.opt_type) ? "Closed" : "Open",
    price_at_execution: parsed.price_at_execution,
    exercised: parsed.exercised || "No",
    created_via: "Auto Import",
    parent_id: matchId || null,
  };

  let inserted;
  try {
    inserted = await sbPost("contracts", row, "resolution=ignore-duplicates,return=representation");
  } catch(e) {
    if (e.message?.includes("23505")) {
      console.log(`[auto-import] skipping duplicate insert (unique constraint): ${parsed.stock} ${parsed.opt_type} $${parsed.strike} ${parsed.expires} ${parsed.account}`);
      return;
    }
    throw e;
  }
  const insertedId = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;
  if (!insertedId) return; // Already existed

  // ── Stamp entry context snapshot onto new STO/BTO ────────────────────────
  if (["STO","BTO"].includes(parsed.opt_type) && insertedId) {
    try {
      const entryCtx = await fetchNearestSnapshot(
        parsed.stock, parsed.strike, parsed.expires, parsed.type,
        parsed.date_exec || new Date().toISOString(), "entry"
      );
      if (Object.keys(entryCtx).length) {
        await sbPatch("contracts", insertedId, entryCtx);
        console.log(`[auto-import] entry snapshot stamped on contract ${insertedId} (snapshot ${entryCtx.entry_snapshot_id})`);
      }
    } catch(e) { console.warn("[auto-import] entry snapshot stamp failed:", e.message); }
  }

  // ── KEY FIX: push newly inserted STO/BTO into openContracts immediately so
  // subsequent transactions in the same batch can find and merge into it,
  // preventing duplicate rows from same-batch partial fills
  if (["STO","BTO"].includes(parsed.opt_type)) {
    openContracts.push({
      id:        insertedId,
      stock:     parsed.stock,
      type:      parsed.type,
      opt_type:  parsed.opt_type,
      strike:    String(parsed.strike),
      expires:   parsed.expires,
      qty:       +parsed.qty,
      premium:   parsed.premium,
      account:   parsed.account,
      date_exec: parsed.date_exec,
      status:    "Open",
      notes:     null,
      schwab_transaction_id: parsed.schwab_transaction_id,
    });
    console.log(`[auto-import] new open added to in-memory list: ${parsed.stock} ${parsed.opt_type} $${parsed.strike} qty ${parsed.qty} @ ${parsed.account}`);
  }

  // ── Track newly inserted BTC/STC so subsequent split fills can merge into it
  if (["BTC","STC"].includes(parsed.opt_type)) {
    const normalizeExp = e => { if (!e) return ""; const d = new Date(e); return isNaN(d) ? String(e) : d.toISOString().slice(0,10); };
    const closerKey = `${parsed.stock?.toUpperCase()}|${parsed.opt_type}|${parseFloat(parsed.strike)}|${normalizeExp(parsed.expires)}|${parsed.account}|${parsed.date_exec}`;
    const parent = matchId ? openContracts.find(c => c.id === matchId) : null;
    committedClosers[closerKey] = {
      id:      insertedId,
      qty:     +parsed.qty,
      premium: +parsed.premium,
      parent,
    };
    console.log(`[auto-import] closer tracked for split fill detection: ${closerKey}`);
  }

  // If closer, update parent
  if (matchId && ["BTC","STC","ASSIGNED"].includes(parsed.opt_type)) {
    const parent = openContracts.find(c => c.id === matchId);
    if (parent) {
      const costToClose  = Math.abs(parsed.premium || 0);
      const parentPrem   = Math.abs(+parent.premium || 0);
      const closeQty     = +parsed.qty || 1;
      const parentQty    = +parent.qty || closeQty;
      const isPartial    = closeQty < parentQty;
      const proratedPrem = parentPrem * (closeQty / parentQty);
      const parentWasSell = parent.opt_type === "STO" || parent.opt_type === "STC";
      const profit       = Math.round((parentWasSell ? proratedPrem - costToClose : costToClose - proratedPrem) * 100) / 100;
      const profitPct    = proratedPrem > 0 ? Math.round((profit / proratedPrem) * 10000) / 10000 : null;
      const daysHeld     = parent.date_exec ? Math.ceil((new Date(parsed.date_exec) - new Date(parent.date_exec)) / 86400000) : null;

      if (isPartial) {
        const remainingQty  = parentQty - closeQty;
        const remainingPrem = Math.round(parentPrem * (remainingQty / parentQty) * 100) / 100;
        const closedPrem    = Math.round(parentPrem * (closeQty / parentQty) * 100) / 100;

        // ── Close the original row for the qty that was actually closed ────────
        await sbPatch("contracts", matchId, {
          qty:           closeQty,
          premium:       (parent.opt_type === "STO" || parent.opt_type === "BTO") ? closedPrem : -closedPrem,
          status:        "Closed",
          cost_to_close: costToClose,
          close_date:    parsed.date_exec,
          profit,
          profit_pct:    profitPct,
          days_held:     daysHeld,
          closed_by_id:  insertedId,
          notes:         `Partial close: ${closeQty} of ${parentQty} on ${parsed.date_exec}`,
        });

        // ── Stamp exit context snapshot on closed row ─────────────────────
        try {
          const exitCtx = await fetchNearestSnapshot(
            parsed.stock, parsed.strike, parsed.expires, parsed.type,
            parsed.date_exec || new Date().toISOString(), "exit"
          );
          if (Object.keys(exitCtx).length) {
            await sbPatch("contracts", matchId, exitCtx);
            console.log(`[auto-import] exit snapshot stamped on partial close ${matchId} (snapshot ${exitCtx.exit_snapshot_id})`);
          }
        } catch(e) { console.warn("[auto-import] exit snapshot stamp (partial) failed:", e.message); }

        // ── Insert a new open row for the remaining qty ────────────────────────
        const remainingRow = {
          stock:       parent.stock,
          type:        parent.type,
          opt_type:    parent.opt_type,
          strike:      parent.strike,
          expires:     parent.expires,
          qty:         remainingQty,
          premium:     (parent.opt_type === "STO" || parent.opt_type === "BTO") ? remainingPrem : -remainingPrem,
          status:      "Open",
          date_exec:   parent.date_exec,
          account:     parent.account,
          broker:      parent.broker || null,
          strategy:    parent.strategy || null,
          notes:       `Remaining ${remainingQty} of ${parentQty} after partial close ${parsed.date_exec}`,
          created_via: "Auto Import",
        };
        const newOpenRow = await sbPost("contracts", remainingRow, "resolution=ignore-duplicates,return=representation");
        const newOpenId  = Array.isArray(newOpenRow) ? newOpenRow[0]?.id : newOpenRow?.id;

        // ── Carry entry context from closed parent onto new open row ──────
        if (newOpenId) {
          try {
            const entryCtx = await fetchNearestSnapshot(
              parent.stock, parent.strike, parent.expires, parent.type,
              parent.date_exec || new Date().toISOString(), "entry"
            );
            if (Object.keys(entryCtx).length) {
              await sbPatch("contracts", newOpenId, entryCtx);
              console.log(`[auto-import] entry snapshot carried to remaining open row ${newOpenId}`);
            }
          } catch(e) { console.warn("[auto-import] entry snapshot carry failed:", e.message); }
        }

        // Update in-memory: replace the closed parent with the new open row
        if (newOpenId) {
          parent.id      = newOpenId;
          parent.qty     = remainingQty;
          parent.premium = remainingRow.premium;
          parent.status  = "Open";
          parent.notes   = remainingRow.notes;
        }
        console.log(`[auto-import] partial close: ${parent.stock} ${parent.opt_type} $${parent.strike} — closed ${closeQty}, remaining ${remainingQty}, profit $${profit}`);
      } else {
        await sbPatch("contracts", matchId, {
          closed_by_id:         insertedId,
          status:               "Closed",
          cost_to_close:        costToClose,
          close_date:           parsed.date_exec,
          profit,
          profit_pct:           profitPct,
          days_held:            daysHeld,
          stock_price_at_close: parsed.price_at_execution || null,
        });

        // ── Stamp exit context snapshot ───────────────────────────────────
        try {
          const exitCtx = await fetchNearestSnapshot(
            parsed.stock, parsed.strike, parsed.expires, parsed.type,
            parsed.date_exec || new Date().toISOString(), "exit"
          );
          if (Object.keys(exitCtx).length) {
            await sbPatch("contracts", matchId, exitCtx);
            console.log(`[auto-import] exit snapshot stamped on contract ${matchId} (snapshot ${exitCtx.exit_snapshot_id})`);
          }
        } catch(e) { console.warn("[auto-import] exit snapshot stamp failed:", e.message); }

        // ── Mark any submitted trade_orders for this contract as filled ──────
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/trade_orders?contract_id=eq.${matchId}&status=in.(submitted,pending_approval,dry_run_approved)`, {
            method: "PATCH",
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify({ status: "filled", filled_at: parsed.date_exec }),
          });
          console.log(`[auto-import] trade_orders marked filled for contract ${matchId}`);
        } catch(e) { console.warn("[auto-import] trade_order fill update failed:", e.message); }

        // ── Write signal_outcome to close the learning loop ──────────────────
        // Find most recent decision_log entry for this contract (via signal_log)
        try {
          const decisionRows = await sbGet(`decision_log?contract_id=eq.${matchId}&order=created_at.desc&limit=1`);
          const dec = Array.isArray(decisionRows) ? decisionRows[0] : null;
          const signalId = dec?.signal_id ?? null;

          if (signalId || matchId) {
            // Determine signal quality
            const profitPctNum = profitPct != null ? +profitPct * 100 : null;
            const signalQuality = profitPctNum == null ? "neutral"
              : profitPctNum >= 50 ? "good"
              : profitPctNum >= 0  ? "neutral"
              : "bad";

            await fetch(`${SUPABASE_URL}/rest/v1/signal_outcomes`, {
              method: "POST",
              headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
              body: JSON.stringify({
                signal_id:           signalId,
                contract_id:         matchId,
                decision:            dec?.decision ?? "unknown",
                decision_notes:      dec?.notes ?? null,
                outcome_profit:      profit,
                outcome_profit_pct:  profitPct,
                outcome_days_held:   daysHeld,
                outcome_exercised:   false,
                outcome_close_method: parsed.opt_type === "BTC" ? "app" : "manual",
                outcome_closed_at:   parsed.date_exec,
                signal_quality:      signalQuality,
                created_at:          new Date().toISOString(),
              }),
            });
            console.log(`[auto-import] signal_outcome written for contract ${matchId} — profit: $${profit} (${profitPctNum?.toFixed(1)}%) quality: ${signalQuality}`);
          }
        } catch(e) { console.warn("[auto-import] signal_outcome write failed:", e.message); }
      }
    }
  }
  return true;
}

// ── Pushover ──────────────────────────────────────────────────────────────────
async function sendPushover(title, message, url, priority = 0) {
  const token = process.env.PUSHOVER_API_TOKEN;
  const user  = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return;
  await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, user, title, message, url: url || `${APP_URL}/?tab=import`, url_title: "Review in App", priority, sound: priority >= 1 ? "cashregister" : "pushover" }),
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const secret   = process.env.CRON_SECRET;
  const provided = req.headers["x-cron-secret"] || req.query.secret;
  if (secret && provided !== secret) return res.status(401).json({ error: "Unauthorized" });

  const action = req.query.action || "run";

  // ── GET anomalies ───────────────────────────────────────────────────────────
  if (action === "anomalies") {
    const rows = await sbGet(`import_anomalies?dismissed=eq.false&resolved=eq.false&order=created_at.desc&limit=100`);
    return res.status(200).json({ ok: true, anomalies: rows });
  }

  // ── POST dismiss ────────────────────────────────────────────────────────────
  if (action === "dismiss" && req.method === "POST") {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "Missing id" });
    await sbPatch("import_anomalies", id, { dismissed: true, dismissed_at: new Date().toISOString() });
    return res.status(200).json({ ok: true });
  }

  // ── POST resolve — manually link anomaly to a parent contract ───────────────
  if (action === "resolve" && req.method === "POST") {
    const { id, parentId } = req.body;
    if (!id || !parentId) return res.status(400).json({ error: "Missing id or parentId" });

    const anomalies = await sbGet(`import_anomalies?id=eq.${id}`);
    const anomaly   = anomalies?.[0];
    if (!anomaly) return res.status(404).json({ error: "Anomaly not found" });

    // Load open contracts for matching
    const openContracts = await sbGet(`contracts?select=id,stock,type,opt_type,strike,expires,qty,account,premium,date_exec,trade_rule,notes,status,schwab_transaction_id&status=eq.Open`);

    // Commit the anomaly transaction with the specified parent
    await commitTx(anomaly, parentId, openContracts, {});

    // Mark anomaly resolved
    await sbPatch("import_anomalies", id, { resolved: true, resolved_at: new Date().toISOString(), resolved_contract_id: parentId });

    return res.status(200).json({ ok: true });
  }

  // ── RUN auto-import pipeline ────────────────────────────────────────────────
  try {
    const today = new Date().toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);

    // Load stocks_data for price at execution
    const sdRows     = await sbGet(`col_prefs?select=cols&id=eq.stocks_data`);
    const stocksData = sdRows?.[0]?.cols || {};

    // Load existing IDs to skip already-committed transactions
    const [existingContracts, existingPending, closerContractsRaw] = await Promise.all([
      sbGet(`contracts?select=schwab_transaction_id,stock,opt_type,strike,expires,account,premium,qty,date_exec,notes&schwab_transaction_id=not.is.null&date_exec=gte.${CUTOVER_DATE}`),
      sbGet(`pending_transactions?select=schwab_transaction_id`),
      // Also load STC/BTC closer rows (which may have no schwab_transaction_id) for composite fingerprinting
      sbGet(`contracts?select=stock,opt_type,strike,expires,account,premium,qty,date_exec&opt_type=in.(STC,BTC)&date_exec=gte.${CUTOVER_DATE}`),
    ]);
    const closerContracts = Array.isArray(closerContractsRaw) ? closerContractsRaw : [];
    const existingIds = new Set([
      ...existingContracts.map(r => String(r.schwab_transaction_id)),
      ...existingPending.map(r => String(r.schwab_transaction_id)),
    ]);
    // Composite fingerprint for ETrade (whose transaction IDs change between fetches)
    // Normalize strike (always float string) and expires (always YYYY-MM-DD) to avoid mismatch
    const normalizeExpires = e => { if (!e) return ""; const d = new Date(e); return isNaN(d) ? String(e) : d.toISOString().slice(0,10); };
    const normalizeStrike  = s => String(parseFloat(s));
    const makeFingerprint  = r => `${r.stock}|${r.opt_type}|${normalizeStrike(r.strike)}|${normalizeExpires(r.expires)}|${r.account}|${Math.round(Math.abs(+r.premium)*100)}|${r.qty}|${r.date_exec}`;
    const existingFingerprints = new Set([
      ...existingContracts.map(makeFingerprint),
      ...closerContracts.map(makeFingerprint),  // include STC/BTC rows without tx IDs
    ]);
    // Also add fingerprints for each individual partial fill already merged into a contract.
    // A merged contract has notes like "Partial fill merged: 1 @ $77.34 on 2026-05-14 (tx: 12345)"
    // We reconstruct the original partial fill fingerprint so it won't be re-imported.
    existingContracts.forEach(r => {
      if (!r.notes?.includes("Partial fill merged:")) return;
      // Parse each merged partial: "N @ $P on DATE"
      const mergePattern = /(\d+(?:\.\d+)?)\s*@\s*\$(\d+(?:\.\d+)?)\s+on\s+([\d-]+)/g;
      let m;
      while ((m = mergePattern.exec(r.notes)) !== null) {
        const [, qty, premium, date] = m;
        const fp = `${r.stock}|${r.opt_type}|${normalizeStrike(r.strike)}|${normalizeExpires(r.expires)}|${r.account}|${Math.round(Math.abs(+premium)*100)}|${qty}|${date}`;
        existingFingerprints.add(fp);
        // Also add with Schwab account variants
        if (r.account?.startsWith("Schwab")) {
          existingFingerprints.add(`${r.stock}|${r.opt_type}|${normalizeStrike(r.strike)}|${normalizeExpires(r.expires)}|Schwab|${Math.round(Math.abs(+premium)*100)}|${qty}|${date}`);
        }
      }
    });

    // Load open contracts for matching
    const openContracts = await sbGet(`contracts?select=id,stock,type,opt_type,strike,expires,qty,account,premium,date_exec,trade_rule,notes,status,schwab_transaction_id&status=eq.Open`);

    // ── Fetch Schwab ──────────────────────────────────────────────────────────
    const schwabTxs = [];
    try {
      const token    = await getValidToken();
      const accts    = await fetch(`${SCHWAB_BASE}/trader/v1/accounts/accountNumbers`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }).then(r => r.json());
      const startUTC = new Date(today + "T05:00:00.000Z").toISOString();
      const endUTC   = new Date(new Date(today + "T05:00:00.000Z").getTime() + 86400000).toISOString();
      for (const acct of (Array.isArray(accts) ? accts : [])) {
        if (!acct.hashValue) continue;
        const txData = await fetch(`${SCHWAB_BASE}/trader/v1/accounts/${acct.hashValue}/transactions?types=TRADE&startDate=${startUTC}&endDate=${endUTC}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }).then(r => r.json());
        const txList = Array.isArray(txData) ? txData : (txData?.transactions ?? []);
        txList.forEach(tx => {
          const p = parseSchwabTx(tx, stocksData, acct.accountNumber);
          if (p) schwabTxs.push(p);
          else if ((tx.description || "").toUpperCase().includes("EXPIR")) {
            console.log("[auto-import] Schwab EXPIRY raw:", JSON.stringify({ type: tx.type, desc: tx.description, netAmount: tx.netAmount, items: tx.transferItems?.map(i => ({ effect: i.positionEffect, assetType: i.instrument?.assetType, symbol: i.instrument?.underlyingSymbol })) }));
          }
        });
      }
    } catch(e) { console.warn("[auto-import] Schwab fetch failed:", e.message); }

    // ── Fetch ETrade ──────────────────────────────────────────────────────────
    const etradeTxs = [];
    try {
      const acctData = await etradeGet("/v1/accounts/list");
      const eAccts   = acctData?.AccountListResponse?.Accounts?.Account || [];
      for (const acct of eAccts) {
        try {
          const fromD = new Date(); fromD.setDate(fromD.getDate() - 1);
          const fmtD  = d => `${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}${d.getFullYear()}`;
          const data  = await etradeGet(`/v1/accounts/${acct.accountIdKey}/transactions`, {
            startDate: fmtD(fromD),
            endDate:   fmtD(new Date()),
          });
          const txList = data?.TransactionListResponse?.Transaction || [];
          txList.forEach(tx => { const p = parseEtradeTx(tx, stocksData); if (p) etradeTxs.push(p); });
        } catch(e) { if (!e.message?.includes("204")) console.warn(`[auto-import] ETrade ${acct.accountIdKey}:`, e.message); }
      }
    } catch(e) { console.warn("[auto-import] ETrade fetch failed:", e.message); }

    // ── Backfill price_at_execution for new tickers not yet in stocksData ────
    // Collect all distinct symbols missing a price, fetch live quotes in one batch
    const missingPriceSymbols = [...new Set(
      [...schwabTxs, ...etradeTxs]
        .filter(t => t.price_at_execution == null && t.stock && ["STO","BTO"].includes(t.opt_type))
        .map(t => t.stock)
    )];
    if (missingPriceSymbols.length) {
      try {
        const batchToken = await getValidToken();
        const qUrl  = `${SCHWAB_BASE}/marketdata/v1/quotes?symbols=${missingPriceSymbols.join(",")}&fields=quote&indicative=false`;
        const qRes  = await fetch(qUrl, { headers: { Authorization: `Bearer ${batchToken}`, Accept: "application/json" } });
        const qData = qRes.ok ? await qRes.json() : {};
        missingPriceSymbols.forEach(sym => {
          const q     = qData?.[sym]?.quote;
          const price = q?.lastPrice || q?.mark || q?.bidPrice || null;
          if (!price) return;
          console.log(`[auto-import] live price fallback: ${sym} = $${price}`);
          [...schwabTxs, ...etradeTxs].forEach(t => {
            if (t.stock === sym && t.price_at_execution == null) t.price_at_execution = price;
          });
        });
      } catch(e) { console.warn("[auto-import] live price backfill failed:", e.message); }
    }

    // ── Process all transactions ──────────────────────────────────────────────
    console.log(`[auto-import] schwabTxs: ${schwabTxs.length}, etradeTxs: ${etradeTxs.length}, existingIds: ${existingIds.size}`);
    if (etradeTxs.length) console.log(`[auto-import] ETrade txs:`, JSON.stringify(etradeTxs.map(t => ({ id: t.schwab_transaction_id, stock: t.stock, opt_type: t.opt_type, date_exec: t.date_exec, premium: t.premium }))));
    if (schwabTxs.length) console.log(`[auto-import] Schwab txs:`, JSON.stringify(schwabTxs.map(t => ({ id: t.schwab_transaction_id, stock: t.stock, opt_type: t.opt_type, date_exec: t.date_exec, premium: t.premium }))));
    const allTxs   = [...schwabTxs, ...etradeTxs].filter(t => {
      const passDate     = t.date_exec >= CUTOVER_DATE;
      const passExisting = !existingIds.has(String(t.schwab_transaction_id));
      const fingerprint  = makeFingerprint(t);
      const passFingerprint = !existingFingerprints.has(fingerprint);
      if (!passDate) console.log(`[auto-import] filtered by date: ${t.schwab_transaction_id} ${t.date_exec} < ${CUTOVER_DATE}`);
      if (!passExisting) console.log(`[auto-import] filtered as existing id: ${t.schwab_transaction_id}`);
      if (!passFingerprint) console.log(`[auto-import] filtered as existing fingerprint: ${fingerprint}`);
      return passDate && passExisting && passFingerprint;
    });
    if (!allTxs.length) return res.status(200).json({ ok: true, committed: 0, anomalies: 0, reason: "no new transactions" });

    const committed       = [];
    const anomalies       = [];
    const committedClosers = {}; // tracks BTC/STC inserts for split fill merging

    for (const tx of allTxs) {
      // Handle EXPIRED — close the matching STO/BTO with full profit/loss
      if (tx.opt_type === "EXPIRED") {
        const { matchId } = matchToOpen(tx, openContracts);
        if (matchId) {
          const parent = openContracts.find(c => c.id === matchId);
          if (parent) {
            const isSell   = parent.opt_type === "STO";
            const profit   = isSell
              ? Math.round(Math.abs(+parent.premium) * 100) / 100
              : Math.round(-Math.abs(+parent.premium) * 100) / 100;
            const daysHeld = parent.date_exec
              ? Math.ceil((new Date(tx.date_exec) - new Date(parent.date_exec)) / 86400000)
              : null;
            await sbPatch("contracts", matchId, {
              status:        "Closed",
              close_date:    tx.date_exec,
              cost_to_close: 0,
              profit,
              profit_pct:    isSell ? 1.0 : -1.0,
              days_held:     daysHeld,
              notes:         `Auto-closed: expired worthless on ${tx.date_exec}`,
            });
            committed.push({ ...tx, _expiredParentId: matchId });
            // Remove from openContracts so subsequent matches don't see it
            const idx = openContracts.findIndex(c => c.id === matchId);
            if (idx !== -1) openContracts.splice(idx, 1);
            console.log(`[auto-import] expired worthless: ${tx.stock} $${tx.strike} ${tx.type} ${tx.expires} (${tx.account})`);
          }
        } else {
          // No match found — log as anomaly for manual review
          anomalies.push({ ...tx, anomaly_type: "unmatched_expiry", notes: `No matching open contract for expired ${tx.stock} $${tx.strike} ${tx.type} ${tx.expires}`, raw: tx.raw });
        }
        continue;
      }

      // Skip ASSIGNED — always goes to anomaly report for manual review
      if (tx.opt_type === "ASSIGNED") {
        anomalies.push({ ...tx, anomaly_type: "assigned", notes: "Option assigned/exercised — requires manual review", raw: tx.raw });
        continue;
      }

      const { matchId, matchConfidence } = matchToOpen(tx, openContracts);

      if (matchConfidence === "unmatched") {
        // Check if this BTC was already handled by a Skynet trade_order — skip if so
        const handled = await alreadyHandledByTradeOrder(tx);
        if (handled) continue;
        // Unmatched closer — log as anomaly
        anomalies.push({ ...tx, anomaly_type: "unmatched_close", notes: `No matching open contract found for ${tx.opt_type} ${tx.stock} $${tx.strike} ${tx.type} ${tx.expires}`, raw: tx.raw });
        continue;
      }

      // Auto-commit exact and partial matches, and all opens
      try {
        const wasCommitted = await commitTx(tx, matchId, openContracts, stocksData, committedClosers);
        if (wasCommitted) committed.push(tx);
        // Update openContracts in memory so subsequent matches see updated state
        if (matchId && !["STO","BTO"].includes(tx.opt_type)) {
          const idx = openContracts.findIndex(c => c.id === matchId);
          if (idx !== -1) {
            const closeQty  = +tx.qty;
            const parentQty = +openContracts[idx].qty;
            if (closeQty >= parentQty) openContracts.splice(idx, 1); // fully closed
            else openContracts[idx].qty = parentQty - closeQty;      // partial
          }
        }
      } catch(e) {
        console.error("[auto-import] commitTx failed:", e.message);
        anomalies.push({ ...tx, anomaly_type: "commit_error", notes: e.message, raw: tx.raw });
      }
    }

    // ── Save anomalies ────────────────────────────────────────────────────────
    if (anomalies.length) {
      const anomalyRows = anomalies.map(a => ({
        schwab_transaction_id: a.schwab_transaction_id,
        stock:        a.stock,
        type:         a.type,
        opt_type:     a.opt_type,
        strike:       +a.strike,
        expires:      a.expires,
        qty:          +a.qty,
        premium:      a.premium,
        date_exec:    a.date_exec,
        account:      a.account,
        anomaly_type: a.anomaly_type,
        notes:        a.notes,
        dismissed:    false,
        resolved:     false,
        raw:          a.raw,
      }));

      // Build composite fingerprint for each anomaly — ETrade IDs are unstable
      const anomalyFingerprint = a => `${a.stock}|${a.opt_type}|${a.strike}|${a.expires}|${a.account}|${Math.round(Math.abs(+a.premium)*100)}|${a.qty}|${a.date_exec}|${a.anomaly_type}`;

      // Load existing anomalies (including dismissed/resolved) to build fingerprint set
      const existingAnomalies = await sbGet(`import_anomalies?select=stock,opt_type,strike,expires,account,premium,qty,date_exec,anomaly_type,schwab_transaction_id`);
      const existingIds = new Set(existingAnomalies.map(r => r.schwab_transaction_id));
      const existingFingerprints = new Set(existingAnomalies.map(anomalyFingerprint));

      const trulyNewAnomalies = anomalyRows.filter(a =>
        !existingIds.has(a.schwab_transaction_id) &&
        !existingFingerprints.has(anomalyFingerprint(a))
      );

      // Save — ignore dupes via unique constraint
      for (const row of anomalyRows) {
        // Skip if already exists by fingerprint (even if ID differs)
        if (existingFingerprints.has(anomalyFingerprint(row))) continue;
        try {
          await sbPost("import_anomalies", row, "resolution=ignore-duplicates");
        } catch(e) {
          if (!e.message?.includes("23505")) {
            console.warn("[auto-import] anomaly save error:", e.message);
          }
        }
      }

      // Only notify about genuinely new anomalies
      if (trulyNewAnomalies.length) {
        const msg = trulyNewAnomalies.map(a => `⚠ ${a.anomaly_type}: ${a.stock} $${a.strike} ${a.type} ${a.expires} (${a.account})`).join("\n");
        await sendPushover("⚠ Import Anomalies Detected", msg, `${APP_URL}/?tab=import`, 1);
      }
    }

    // ── Push notification for committed ──────────────────────────────────────
    if (committed.length) {
      const opens  = committed.filter(t => ["STO","BTO"].includes(t.opt_type));
      const closes = committed.filter(t => ["BTC","STC"].includes(t.opt_type));
      let msg = `${committed.length} transaction${committed.length > 1 ? "s" : ""} auto-committed.`;
      if (opens.length)  msg += `\n📤 ${opens.length} open${opens.length > 1 ? "s" : ""}`;
      if (closes.length) msg += `\n✅ ${closes.length} close${closes.length > 1 ? "s" : ""}`;
      await sendPushover("📥 Auto-Import Complete", msg, `${APP_URL}/?tab=contracts`, 0);
    }

    // ── Ecosystem heartbeat ──────────────────────────────────────────────────────
    const now = new Date().toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/ecosystem_heartbeat`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ agent_name: "auto-import", last_run_at: now, status: "ok", notes: `${committed.length} committed, ${anomalies.length} anomalies`, updated_at: now }),
    }).catch(e => console.warn("[heartbeat] write failed:", e.message));

    return res.status(200).json({
      ok: true,
      committed: committed.length,
      anomalies: anomalies.length,
      debug: { schwabTxs: schwabTxs.length, etradeTxs: etradeTxs.length, allTxs: allTxs.length, existingIds: existingIds.size },
      time: now,
    });

  } catch(err) {
    console.error("[auto-import]", err.message);
    await fetch(`${SUPABASE_URL}/rest/v1/ecosystem_heartbeat`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ agent_name: "auto-import", last_run_at: new Date().toISOString(), status: "error", notes: err.message, updated_at: new Date().toISOString() }),
    }).catch(()=>{});
    await sendPushover("❌ Auto-Import Failed", err.message, `${APP_URL}/?tab=import`, 1).catch(()=>{});
    return res.status(500).json({ error: err.message });
  }
}
