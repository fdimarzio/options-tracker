// scripts/backfill-stock-transactions.js
// Backfill: pulls all non-option transactions from Schwab + ETrade into stock_transactions.
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

// Schwab types to fetch — excludes TRADE (options) which live in contracts table;
// TRADE is included here only for EQUITY buy/sell parsing (options are skipped by the parser).
const SCHWAB_TX_TYPES = [
  "TRADE",
  "DIVIDEND_OR_INTEREST",
  "JOURNAL",
  "RECEIVE_AND_DELIVER",
  "ELECTRONIC_FUND",
  "WIRE_IN",
  "WIRE_OUT",
].join(",");

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
    new URLSearchParams({ types: SCHWAB_TX_TYPES, startDate: startUTC, endDate: endUTC });

  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`Schwab transactions: ${r.status} ${await r.text()}`);
  const data = await r.json();
  return Array.isArray(data) ? data : (data?.transactions ?? []);
}

function schwabIsoDate(tx) {
  const d = (tx.tradeDate ?? tx.time)?.slice(0, 10) ?? null;
  return d ? new Date(d + "T16:00:00Z").toISOString() : null;
}

function parseSchwabTx(tx) {
  const id   = String(tx.activityId ?? tx.transactionId ?? "");
  const items = tx.transferItems ?? [];
  const net   = tx.netAmount ?? 0;
  const desc  = tx.description ?? null;
  const descU = (desc ?? "").toUpperCase();

  const base = {
    schwab_transaction_id: id,
    net_amount:  net,
    trade_date:  schwabIsoDate(tx),
    account:     SCHWAB_ACCOUNT_LABEL,
    description: desc,
    raw:         tx,
  };

  switch (tx.type) {
    case "TRADE": {
      // Only capture EQUITY trades — option trades live in contracts table
      const eqItem = items.find(i => i.instrument?.assetType === "EQUITY");
      if (!eqItem) return null;
      const qty = eqItem.amount ?? 0;
      if (qty === 0) return null;
      return {
        ...base,
        symbol:           eqItem.instrument.symbol?.toUpperCase() ?? null,
        transaction_type: qty > 0 ? "BUY" : "SELL",
        asset_type:       "EQUITY",
        quantity:         Math.abs(qty),
        price:            eqItem.price ?? null,
      };
    }

    case "DIVIDEND_OR_INTEREST": {
      // Determine subtype from description and net amount
      let txType;
      if (net < 0 || descU.includes("TAX") || descU.includes("WITHHOLD") || descU.includes("BACKUP")) {
        txType = "TAX_WITHHOLDING";
      } else if (descU.includes("INTEREST") || descU.includes("MONEY MARKET") || descU.includes("MARGIN INT")) {
        txType = "INTEREST";
      } else {
        txType = "DIVIDEND";
      }
      // Extract underlying symbol from equity instrument if present
      const eqItem = items.find(i => i.instrument?.assetType === "EQUITY");
      const symbol = eqItem?.instrument?.symbol?.toUpperCase()
        ?? (txType === "INTEREST" ? "INTEREST" : "CASH");
      return {
        ...base,
        symbol, transaction_type: txType, asset_type: "CASH",
        quantity: null, price: null,
      };
    }

    case "JOURNAL":
      return {
        ...base,
        symbol: "CASH", transaction_type: "JOURNAL", asset_type: "CASH",
        quantity: null, price: null,
      };

    case "RECEIVE_AND_DELIVER": {
      const eqItem = items.find(i => i.instrument?.assetType === "EQUITY");
      if (eqItem) {
        const qty = eqItem.amount ?? 0;
        return {
          ...base,
          symbol:           eqItem.instrument.symbol?.toUpperCase() ?? "CASH",
          transaction_type: qty >= 0 ? "TRANSFER_IN" : "TRANSFER_OUT",
          asset_type:       "EQUITY",
          quantity:         Math.abs(qty),
          price:            eqItem.price ?? null,
        };
      }
      // Cash-based receive/deliver
      return {
        ...base,
        symbol: "CASH", transaction_type: net >= 0 ? "TRANSFER_IN" : "TRANSFER_OUT",
        asset_type: "CASH", quantity: null, price: null,
      };
    }

    case "ELECTRONIC_FUND":
      // ACH — direction determined by net amount
      return {
        ...base,
        symbol: "CASH", transaction_type: net >= 0 ? "DEPOSIT" : "WITHDRAWAL",
        asset_type: "CASH", quantity: null, price: null,
      };

    case "WIRE_IN":
      return {
        ...base,
        symbol: "CASH", transaction_type: "DEPOSIT",
        asset_type: "CASH", quantity: null, price: null,
      };

    case "WIRE_OUT":
      return {
        ...base,
        symbol: "CASH", transaction_type: "WITHDRAWAL",
        asset_type: "CASH", quantity: null, price: null,
      };

    default:
      return null;
  }
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

async function fetchEtradeTransactionsPaginated(accountIdKey, startFmt, endFmt, consumerKey, usedSecret, tokens) {
  const allTxs = [];
  let marker   = null;
  let page     = 1;

  do {
    const params = { startDate: startFmt, endDate: endFmt, count: 50 };
    if (marker) params.marker = marker;

    const data   = await etradeGet(
      `/v1/accounts/${accountIdKey}/transactions`,
      params, consumerKey, usedSecret, tokens.accessToken, tokens.accessTokenSecret
    );
    const resp   = data?.TransactionListResponse ?? {};
    const txList = resp.Transaction ?? [];
    allTxs.push(...(Array.isArray(txList) ? txList : [txList]));

    marker = resp.marker ?? null;
    if (marker) console.log(`  page ${page} → ${txList.length} tx, fetching next page...`);
    page++;
  } while (marker);

  return allTxs;
}

function fmtEtradeDate(d) {
  const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${String(et.getMonth() + 1).padStart(2, "0")}${String(et.getDate()).padStart(2, "0")}${et.getFullYear()}`;
}

function etradeIsoDate(tx) {
  if (!tx.transactionDate) return null;
  const d = new Date(tx.transactionDate).toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);
  return new Date(d + "T16:00:00Z").toISOString();
}

function parseEtradeTx(tx, accountName) {
  const id   = String(tx.transactionId);
  const b    = tx.brokerage ?? {};
  const prod = b.product    ?? {};
  const net  = tx.amount    ?? 0;
  const desc = tx.description ?? null;
  const descU = (desc ?? "").toUpperCase();
  const txType = tx.transactionType ?? "";

  const base = {
    etrade_transaction_id: id,
    net_amount:  net,
    trade_date:  etradeIsoDate(tx),
    account:     accountName,
    description: desc,
    raw:         tx,
  };

  // ── Equity buy / sell ──────────────────────────────────────────────────────
  if (prod.securityType === "EQ" && (txType === "Bought" || txType === "Sold")) {
    return {
      ...base,
      symbol:           prod.symbol?.toUpperCase() ?? null,
      transaction_type: txType === "Bought" ? "BUY" : "SELL",
      asset_type:       "EQUITY",
      quantity:         Math.abs(b.quantity ?? 0),
      price:            b.price ?? null,
    };
  }

  // ── Dividend ───────────────────────────────────────────────────────────────
  if (txType === "Dividend" || txType === "Dividends" || txType === "DIVIDEND") {
    const isTax = net < 0 || descU.includes("TAX") || descU.includes("WITHHOLD");
    return {
      ...base,
      symbol:           prod.symbol?.toUpperCase() ?? "CASH",
      transaction_type: isTax ? "TAX_WITHHOLDING" : "DIVIDEND",
      asset_type:       "CASH", quantity: null, price: null,
    };
  }

  // ── Tax withholding (explicit type) ───────────────────────────────────────
  if (txType === "Tax Withheld" || txType === "Tax Withholding" || descU.includes("TAX WITHHELD")) {
    return {
      ...base,
      symbol:           prod.symbol?.toUpperCase() ?? "CASH",
      transaction_type: "TAX_WITHHOLDING",
      asset_type:       "CASH", quantity: null, price: null,
    };
  }

  // ── Interest ───────────────────────────────────────────────────────────────
  if (txType === "Interest" || txType === "Interest Income" || txType === "INTEREST"
      || txType === "Money Market Interest" || txType === "Money Market"
      || descU.includes("INTEREST") || descU.includes("MONEY MARKET")) {
    return {
      ...base,
      symbol:           prod.symbol?.toUpperCase() ?? "INTEREST",
      transaction_type: net < 0 ? "TAX_WITHHOLDING" : "INTEREST",
      asset_type:       "CASH", quantity: null, price: null,
    };
  }

  // ── Journal / adjustment ──────────────────────────────────────────────────
  if (txType === "Journal" || txType === "Journaling" || txType === "Adjustment") {
    return {
      ...base,
      symbol: "CASH", transaction_type: "JOURNAL",
      asset_type: "CASH", quantity: null, price: null,
    };
  }

  // ── Stock transfer (assignment / exercise / ACAT) ─────────────────────────
  if (txType === "Transfer" || txType === "Receipt" || txType === "Delivery"
      || txType === "Stock Receipt" || txType === "Stock Delivery") {
    if (prod.securityType === "EQ" && prod.symbol) {
      return {
        ...base,
        symbol:           prod.symbol.toUpperCase(),
        transaction_type: net >= 0 ? "TRANSFER_IN" : "TRANSFER_OUT",
        asset_type:       "EQUITY",
        quantity:         Math.abs(b.quantity ?? 0),
        price:            b.price ?? null,
      };
    }
    return {
      ...base,
      symbol: "CASH", transaction_type: net >= 0 ? "TRANSFER_IN" : "TRANSFER_OUT",
      asset_type: "CASH", quantity: null, price: null,
    };
  }

  // ── Deposit / withdrawal ──────────────────────────────────────────────────
  if (txType === "Deposit" || txType === "Wire transfer" || txType === "Electronic transfer"
      || txType === "ACH" || txType === "Check") {
    return {
      ...base,
      symbol: "CASH", transaction_type: net >= 0 ? "DEPOSIT" : "WITHDRAWAL",
      asset_type: "CASH", quantity: null, price: null,
    };
  }

  if (txType === "Withdrawal") {
    return {
      ...base,
      symbol: "CASH", transaction_type: "WITHDRAWAL",
      asset_type: "CASH", quantity: null, price: null,
    };
  }

  // Unknown — skip; run with DEBUG=1 to see what's being skipped
  if (process.env.DEBUG === "1") {
    console.log(`  [skip] ETrade transactionType="${txType}" securityType="${prod.securityType}" amount=${net} desc="${desc}"`);
  }
  return null;
}

// ── Tally helper ──────────────────────────────────────────────────────────────
function tally(rows) {
  const counts = {};
  for (const r of rows) counts[r.transaction_type] = (counts[r.transaction_type] ?? 0) + 1;
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([t,n])=>`${t}:${n}`).join("  ");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== Stock Transaction Backfill (${START_DATE} → today) ===\n`);

  // ── Schwab ──────────────────────────────────────────────────────────────────
  let schwabCount = 0;
  try {
    console.log("[ Schwab ] Fetching access token from Supabase...");
    const token = await getSchwabToken();

    console.log(`[ Schwab ] Fetching transactions (types: ${SCHWAB_TX_TYPES})...`);
    const rawTxs = await fetchSchwabTransactions(token);
    console.log(`[ Schwab ] ${rawTxs.length} raw transactions retrieved`);

    const rows = rawTxs.map(parseSchwabTx).filter(Boolean);
    console.log(`[ Schwab ] ${rows.length} parsed  |  ${tally(rows)}`);

    if (rows.length) {
      await sbUpsert("stock_transactions", rows, "schwab_transaction_id");
      schwabCount = rows.length;
      console.log(`[ Schwab ] ✓ Upserted ${schwabCount} rows`);
    } else {
      console.log("[ Schwab ] No transactions to import");
    }
  } catch (e) {
    console.error("[ Schwab ] ERROR:", e.message);
  }

  // ── ETrade ──────────────────────────────────────────────────────────────────
  let etradeCount = 0;
  try {
    console.log("\n[ ETrade ] Fetching tokens from Supabase...");
    const tokens = await getEtradeTokens();
    const consumerKey = process.env.ETRADE_CONSUMER_KEY ?? process.env.VITE_ETRADE_CONSUMER_KEY;
    const usedSecret  = process.env.VITE_ETRADE_CONSUMER_SECRET ?? process.env.ETRADE_CONSUMER_SECRET;
    if (!consumerKey || !usedSecret) throw new Error("ETRADE_CONSUMER_KEY / VITE_ETRADE_CONSUMER_SECRET not in .env.local");

    console.log("[ ETrade ] Fetching account list...");
    const acctData = await etradeGet("/v1/accounts/list", {}, consumerKey, usedSecret, tokens.accessToken, tokens.accessTokenSecret);
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
        const txList = await fetchEtradeTransactionsPaginated(acct.accountIdKey, startFmt, endFmt, consumerKey, usedSecret, tokens);
        const parsed = txList.map(tx => parseEtradeTx(tx, accountName)).filter(Boolean);
        console.log(`[ ETrade ] ${accountName}: ${txList.length} raw → ${parsed.length} parsed  |  ${tally(parsed)}`);
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
      console.log(`[ ETrade ] ✓ Upserted ${etradeCount} rows`);
    } else {
      console.log("[ ETrade ] No transactions to import");
    }
  } catch (e) {
    console.error("[ ETrade ] ERROR:", e.message);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n=== Done ===`);
  console.log(`  Schwab:  ${schwabCount} records`);
  console.log(`  ETrade:  ${etradeCount} records`);
  console.log(`  Total:   ${schwabCount + etradeCount} records upserted into stock_transactions\n`);
  console.log(`Tip: run with DEBUG=1 to log skipped ETrade transaction types.\n`);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
