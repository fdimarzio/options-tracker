// scripts/backfill-stock-transactions.js
// One-time backfill: pulls equity transactions from Schwab + ETrade into stock_transactions.
// Run: node --env-file=.env.local scripts/backfill-stock-transactions.js

import crypto from "crypto";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SCHWAB_BASE  = "https://api.schwabapi.com";
const ETRADE_BASE  = "https://api.etrade.com";

const SCHWAB_ACCOUNT_HASH  = "757F62A9417DA1B75005EAC7370D033ABF819061E60384AA3B0F68A0AAE94961";
const SCHWAB_ACCOUNT_LABEL = "Schwab 3866";

const ETRADE_ACCOUNT_NAMES = {
  "227156917": "ETrade 6917",
  "227418222": "ETrade 8222",
};

const START_DATE = "2026-01-01";

// ── Supabase ──────────────────────────────────────────────────────────────────
async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbUpsert(table, rows, conflictCol) {
  if (!rows.length) return;
  const url = `${SUPABASE_URL}/rest/v1/${table}${conflictCol ? `?on_conflict=${conflictCol}` : ""}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase upsert ${table}: ${r.status} ${await r.text()}`);
}

// ── Schwab ────────────────────────────────────────────────────────────────────
async function getSchwabToken() {
  const rows = await sbGet("col_prefs?select=cols&id=eq.schwab_tokens");
  const t = rows?.[0]?.cols;
  if (!t?.accessToken) throw new Error("No Schwab token in col_prefs — ensure market-refresh has run today");
  if (t.accessTokenExpiresAt < Date.now() + 30000) throw new Error("Schwab access token is expired — trigger a market-refresh first");
  return t.accessToken;
}

async function fetchSchwabTransactions(token) {
  const today    = new Date();
  const startUTC = START_DATE + "T05:00:00.000Z";
  const endUTC   = today.toISOString();

  const url = `${SCHWAB_BASE}/trader/v1/accounts/${SCHWAB_ACCOUNT_HASH}/transactions?` +
    new URLSearchParams({ types: "TRADE", startDate: startUTC, endDate: endUTC });

  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`Schwab transactions: ${r.status} ${await r.text()}`);
  const data = await r.json();
  return Array.isArray(data) ? data : (data?.transactions ?? []);
}

function parseSchwabEquityTx(tx) {
  const items  = tx.transferItems ?? [];
  const eqItem = items.find(i => i.instrument?.assetType === "EQUITY");
  if (!eqItem) return null;

  const qty = eqItem.amount ?? 0;
  if (qty === 0) return null;

  const tradeDate = tx.tradeDate
    ? tx.tradeDate.slice(0, 10)
    : tx.time?.slice(0, 10) ?? null;

  return {
    schwab_transaction_id: String(tx.activityId ?? tx.transactionId ?? ""),
    symbol:           eqItem.instrument?.symbol?.toUpperCase() ?? null,
    transaction_type: qty > 0 ? "BUY" : "SELL",
    asset_type:       "EQUITY",
    quantity:         Math.abs(qty),
    price:            eqItem.price ?? null,
    net_amount:       tx.netAmount ?? 0,
    trade_date:       tradeDate ? new Date(tradeDate + "T16:00:00Z").toISOString() : null,
    account:          SCHWAB_ACCOUNT_LABEL,
    description:      tx.description ?? null,
    raw:              tx,
  };
}

// ── ETrade ────────────────────────────────────────────────────────────────────
function pctEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g, "%21").replace(/'/g, "%27")
    .replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\*/g, "%2A");
}

function buildEtradeAuthHeader(method, url, consumerKey, consumerSecret, accessToken, accessTokenSecret, queryParams = {}) {
  const oauthParams = {
    oauth_consumer_key:     consumerKey,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_nonce:            crypto.randomBytes(16).toString("hex"),
    oauth_version:          "1.0",
    oauth_token:            accessToken,
  };
  const allParams   = { ...oauthParams, ...queryParams };
  const paramString = Object.keys(allParams).sort()
    .map(k => `${pctEncode(k)}=${pctEncode(allParams[k])}`).join("&");
  const baseString  = [method, pctEncode(url), pctEncode(paramString)].join("&");
  const signingKey  = `${pctEncode(consumerSecret)}&${pctEncode(accessTokenSecret)}`;
  oauthParams.oauth_signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
  return "OAuth " + Object.keys(oauthParams)
    .map(k => `${pctEncode(k)}="${pctEncode(oauthParams[k])}"`)
    .join(", ");
}

async function getEtradeTokens() {
  // Try Supabase first, fall back to env vars
  try {
    const rows = await sbGet("col_prefs?select=cols&id=eq.etrade_tokens");
    const t    = rows?.[0]?.cols;
    if (t?.accessToken && t?.accessTokenSecret) {
      console.log("[ ETrade ] Using tokens from Supabase col_prefs");
      return t;
    }
  } catch (e) {
    console.warn("[ ETrade ] Supabase token read failed:", e.message);
  }
  // Fall back to env vars
  const accessToken       = process.env.ETRADE_ACCESS_TOKEN;
  const accessTokenSecret = process.env.ETRADE_ACCESS_TOKEN_SECRET;
  if (accessToken && accessTokenSecret) {
    console.log("[ ETrade ] Using tokens from .env.local");
    return { accessToken, accessTokenSecret };
  }
  throw new Error("No ETrade tokens found in Supabase or .env.local");
}

async function etradeGet(path, queryParams, consumerKey, consumerSecret, accessToken, accessTokenSecret) {
  const urlBase    = `${ETRADE_BASE}${path}`;
  const qs         = queryParams && Object.keys(queryParams).length ? "?" + new URLSearchParams(queryParams).toString() : "";
  const authHeader = buildEtradeAuthHeader("GET", urlBase, consumerKey, consumerSecret, accessToken, accessTokenSecret, queryParams ?? {});
  const r          = await fetch(urlBase + qs, { headers: { Authorization: authHeader, Accept: "application/json" } });
  const text       = await r.text();
  if (!text.trim()) return {};
  if (text.trim().startsWith("<")) throw new Error(`ETrade returned XML (${r.status}): ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  if (!r.ok) throw new Error(`ETrade ${r.status}: ${data?.Error?.message ?? text.slice(0, 200)}`);
  return data;
}

function fmtEtradeDate(d) {
  const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${String(et.getMonth() + 1).padStart(2, "0")}${String(et.getDate()).padStart(2, "0")}${et.getFullYear()}`;
}

function parseEtradeEquityTx(tx, accountName) {
  const b    = tx.brokerage ?? {};
  const prod = b.product    ?? {};

  // Equity only, buys/sells only
  if (prod.securityType !== "EQ") return null;
  if (!["Bought", "Sold"].includes(tx.transactionType)) return null;

  const tradeDate = tx.transactionDate
    ? new Date(tx.transactionDate).toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10)
    : null;

  const qty    = Math.abs(b.quantity ?? 0);
  const price  = b.price ?? null;
  const amount = tx.amount ?? 0;

  return {
    etrade_transaction_id: String(tx.transactionId),
    symbol:           prod.symbol?.toUpperCase() ?? null,
    transaction_type: tx.transactionType === "Bought" ? "BUY" : "SELL",
    asset_type:       "EQUITY",
    quantity:         qty,
    price,
    net_amount:       amount,
    trade_date:       tradeDate ? new Date(tradeDate + "T16:00:00Z").toISOString() : null,
    account:          accountName,
    description:      tx.description ?? null,
    raw:              tx,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== Stock Transaction Backfill (${START_DATE} → today) ===\n`);

  // ── Schwab ──────────────────────────────────────────────────────────────────
  let schwabCount = 0;
  try {
    console.log("[ Schwab ] Fetching access token from Supabase...");
    const token = await getSchwabToken();

    console.log("[ Schwab ] Fetching transactions...");
    const rawTxs = await fetchSchwabTransactions(token);
    console.log(`[ Schwab ] ${rawTxs.length} raw transactions retrieved`);

    const rows = rawTxs.map(parseSchwabEquityTx).filter(Boolean);
    console.log(`[ Schwab ] ${rows.length} equity transactions parsed`);

    if (rows.length) {
      await sbUpsert("stock_transactions", rows, "schwab_transaction_id");
      schwabCount = rows.length;
      console.log(`[ Schwab ] ✓ Upserted ${schwabCount} rows into stock_transactions`);
    } else {
      console.log("[ Schwab ] No equity transactions to import");
    }
  } catch (e) {
    console.error("[ Schwab ] ERROR:", e.message);
  }

  // ── ETrade ──────────────────────────────────────────────────────────────────
  let etradeCount = 0;
  try {
    console.log("\n[ ETrade ] Fetching tokens from Supabase...");
    const tokens     = await getEtradeTokens();
    const consumerKey = process.env.ETRADE_CONSUMER_KEY ?? process.env.VITE_ETRADE_CONSUMER_KEY;
    // Production app may have been authorized with the VITE_ secret (different value in .env.local)
    const consumerSecret = process.env.ETRADE_CONSUMER_SECRET ?? process.env.VITE_ETRADE_CONSUMER_SECRET;
    if (!consumerKey || !consumerSecret) throw new Error("ETRADE_CONSUMER_KEY / ETRADE_CONSUMER_SECRET not in .env.local");

    // Try both consumer secrets — the one that matches what was used to authorize wins
    const altSecret = process.env.VITE_ETRADE_CONSUMER_SECRET ?? process.env.ETRADE_CONSUMER_SECRET;
    let acctData, usedSecret = consumerSecret;
    console.log("[ ETrade ] Fetching account list...");
    try {
      acctData = await etradeGet("/v1/accounts/list", {}, consumerKey, consumerSecret, tokens.accessToken, tokens.accessTokenSecret);
    } catch (e) {
      if (e.message.includes("signature_invalid") && altSecret && altSecret !== consumerSecret) {
        console.log("[ ETrade ] Primary secret failed — retrying with VITE_ secret...");
        acctData   = await etradeGet("/v1/accounts/list", {}, consumerKey, altSecret, tokens.accessToken, tokens.accessTokenSecret);
        usedSecret = altSecret;
        console.log("[ ETrade ] VITE_ secret worked");
      } else { throw e; }
    }
    const accounts = acctData?.AccountListResponse?.Accounts?.Account ?? [];
    if (!accounts.length) throw new Error("No ETrade accounts found");
    console.log(`[ ETrade ] ${accounts.length} account(s): ${accounts.map(a => ETRADE_ACCOUNT_NAMES[String(a.accountId)] ?? a.accountId).join(", ")}`);

    const startDate = new Date(START_DATE + "T12:00:00");
    const endDate   = new Date();
    const startFmt  = fmtEtradeDate(startDate);
    const endFmt    = fmtEtradeDate(endDate);
    console.log(`[ ETrade ] Date range: ${startFmt} → ${endFmt}`);

    const allRows = [];
    for (const acct of accounts) {
      const accountName = ETRADE_ACCOUNT_NAMES[String(acct.accountId)] ?? `ETrade ${String(acct.accountId).slice(-4)}`;
      try {
        const data   = await etradeGet(
          `/v1/accounts/${acct.accountIdKey}/transactions`,
          { startDate: startFmt, endDate: endFmt },
          consumerKey, usedSecret, tokens.accessToken, tokens.accessTokenSecret
        );
        const txList = data?.TransactionListResponse?.Transaction ?? [];
        const parsed = txList.map(tx => parseEtradeEquityTx(tx, accountName)).filter(Boolean);
        console.log(`[ ETrade ] ${accountName}: ${txList.length} raw → ${parsed.length} equity tx`);
        allRows.push(...parsed);
      } catch (e) {
        if (e.message?.includes("204")) {
          console.log(`[ ETrade ] ${accountName}: no transactions in range`);
        } else {
          console.warn(`[ ETrade ] ${accountName} failed:`, e.message);
        }
      }
    }

    if (allRows.length) {
      await sbUpsert("stock_transactions", allRows, "etrade_transaction_id");
      etradeCount = allRows.length;
      console.log(`[ ETrade ] ✓ Upserted ${etradeCount} rows into stock_transactions`);
    } else {
      console.log("[ ETrade ] No equity transactions to import");
    }
  } catch (e) {
    console.error("[ ETrade ] ERROR:", e.message);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n=== Done ===`);
  console.log(`  Schwab:  ${schwabCount} records`);
  console.log(`  ETrade:  ${etradeCount} records`);
  console.log(`  Total:   ${schwabCount + etradeCount} records upserted into stock_transactions\n`);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
