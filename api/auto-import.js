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
const CUTOVER_DATE  = "2026-05-10"; // TODO: move to col_prefs so it can be updated without a deploy

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
const ETRADE_ACCOUNTS = { "227156917": "ETrade 6917", "227418222": "ETrade 8222" }; // TODO: load from col_prefs or env so account IDs aren't hardcoded
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
  const settlementDate = tx.settlementDate
    ? new Date(tx.settlementDate).toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10)
    : null;
  return {
    schwab_transaction_id: String(tx.activityId),
    order_id: tx.orderId != null ? String(tx.orderId) : null,
    stock:    symbol?.toUpperCase(),
    type:     inst.putCall === "CALL" ? "Call" : "Put",
    opt_type: optType,
    strike:   inst.strikePrice,
    expires:  inst.expirationDate?.slice(0, 10),
    qty:      Math.abs(optItem.amount || 0),
    premium:  Math.round(netAmt * 100) / 100,
    date_exec: dateExec,
    settlement_date: settlementDate,
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
    order_id: null, // ETrade fills don't share a comparable parent-order id in this payload
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

// ── Equity / non-option parsers ───────────────────────────────────────────────

// Maps Schwab transaction types to stock_transactions.transaction_type values
const SCHWAB_EQUITY_TYPE_MAP = {
  DIVIDEND:            "DIVIDEND",
  INTEREST:            "INTEREST",
  TRANSFER:            "TRANSFER",
  JOURNAL:             "TRANSFER",
  WIRE_IN:             "TRANSFER",
  WIRE_OUT:            "TRANSFER",
  ACH_RECEIPT:         "TRANSFER",
  ACH_DISBURSEMENT:    "TRANSFER",
  MARGIN_INTEREST:     "INTEREST",
  OTHER:               "OTHER",
};

function parseSchwabEquityTx(tx, accountNumber) {
  const items   = tx.transferItems || [];
  // Skip options — already handled by parseSchwabTx
  if (items.find(i => i.instrument?.assetType === "OPTION")) return null;

  const netAmt   = tx.netAmount || 0;
  const type     = tx.type || "";
  const desc     = tx.description || "";
  const dateExec = new Date(tx.tradeDate || tx.time).toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);
  const settlementDate = tx.settlementDate
    ? new Date(tx.settlementDate).toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10)
    : null;

  let txType;
  if (type === "TRADE") {
    // Equity buy or sell — must have a recognisable equity item
    const equityItem = items.find(i => ["EQUITY","ETF","MUTUAL_FUND"].includes(i.instrument?.assetType));
    if (!equityItem) return null;
    txType = netAmt < 0 ? "BUY" : "SELL";
  } else {
    txType = SCHWAB_EQUITY_TYPE_MAP[type] ?? "OTHER";
  }

  const equityItem = items.find(i => i.instrument?.symbol);
  const symbol     = equityItem?.instrument?.symbol?.trim().toUpperCase() || null;
  const quantity   = equityItem ? Math.abs(equityItem.amount || 0) || null : null;
  const price      = equityItem?.price || (quantity && netAmt ? Math.round(Math.abs(netAmt / quantity) * 10000) / 10000 : null);

  return {
    schwab_transaction_id: String(tx.activityId),
    symbol,
    transaction_type: txType,
    asset_type:       type === "TRADE" ? "EQUITY" : type,
    quantity:         quantity || null,
    price:            price    || null,
    net_amount:       Math.round(netAmt * 100) / 100,
    trade_date:       new Date(tx.tradeDate || tx.time).toISOString(),
    settlement_date:  settlementDate,
    account:          accountNumber ? `Schwab ${String(accountNumber).slice(-4)}` : "Schwab",
    description:      desc,
  };
}

// ETrade transaction types that are NOT options
const ETRADE_EQUITY_TYPE_MAP = {
  "Bought":        "BUY",
  "Sold":          "SELL",
  "Dividend":      "DIVIDEND",
  "Interest":      "INTEREST",
  "Transfer":      "TRANSFER",
  "Journal":       "TRANSFER",
  "Wire":          "TRANSFER",
  "Contribution":  "TRANSFER",
  "Distribution":  "TRANSFER",
  "Fee":           "FEE",
  "Tax":           "FEE",
  "Other":         "OTHER",
};

function parseEtradeEquityTx(tx) {
  const br   = tx.brokerage;
  const prod = br?.product;
  // Skip options — already handled by parseEtradeTx
  if (prod?.securityType === "OPTN") return null;

  const txType = ETRADE_EQUITY_TYPE_MAP[tx.transactionType];
  if (!txType) return null;

  const symbol   = prod?.symbol?.toUpperCase() || null;
  const dateExec = new Date(tx.transactionDate).toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);
  const account  = ETRADE_ACCOUNTS[String(tx.accountId)] || `ETrade ${String(tx.accountId).slice(-4)}`;
  const qty      = br?.quantity ? Math.abs(br.quantity) : null;
  const price    = br?.price    ? Math.round(Math.abs(br.price) * 10000) / 10000 : null;

  return {
    schwab_transaction_id: `etrade_${tx.transactionId}`,
    symbol,
    transaction_type: txType,
    asset_type:       prod?.securityType || (["DIVIDEND","INTEREST"].includes(txType) ? txType : "EQUITY"),
    quantity:         qty   || null,
    price:            price || null,
    net_amount:       Math.round((tx.amount || 0) * 100) / 100,
    trade_date:       new Date(tx.transactionDate).toISOString(),
    settlement_date:  null, // ETrade doesn't provide settlement date
    account,
    description:      tx.description || "",
  };
}

// ── Auto-resolve option assignments ──────────────────────────────────────────
// Finds the matching open STO/BTO, closes it with cost_to_close=0 (full premium
// kept for STO, full loss for BTO), marks exercised=true, logs a resolved anomaly
// row for audit trail, and sends a 🎯 Pushover. Falls back to pending anomaly
// if no matching open contract is found.
async function handleAssignment(parsed) {
  const { stock, strike, expires, account, date_exec } = parsed;

  // Find matching open contract — same stock/strike/expiry, STO or BTO, no parent
  const candidates = await sbGet(
    `contracts?stock=eq.${encodeURIComponent(stock)}&strike=eq.${strike}&expires=eq.${expires}&opt_type=in.(STO,BTO)&status=eq.Open&parent_id=is.null&select=id,stock,strike,expires,premium,qty,opt_type,type,account,date_exec`
  );

  const parent = Array.isArray(candidates)
    ? (candidates.find(c => c.account === account) || candidates[0])
    : null;

  if (parent) {
    const isSTO    = parent.opt_type === "STO";
    const profit   = isSTO
      ? Math.round(Math.abs(+parent.premium) * 100) / 100
      : Math.round(-Math.abs(+parent.premium) * 100) / 100;
    const daysHeld = parent.date_exec
      ? Math.ceil((new Date(date_exec) - new Date(parent.date_exec)) / 86400000)
      : null;

    await sbPatch("contracts", parent.id, {
      status:        "Closed",
      cost_to_close: 0,
      close_date:    date_exec,
      profit,
      profit_pct:    isSTO ? 1.0 : -1.0,
      exercised:     true,
      days_held:     daysHeld,
      notes:         `Auto-resolved: option assigned/exercised on ${date_exec}`,
    });

    // Log resolved anomaly for audit trail (not shown as pending in UI)
    try {
      await sbPost("import_anomalies", {
        schwab_transaction_id: parsed.schwab_transaction_id,
        stock, strike: +strike, expires, account, date_exec,
        opt_type:           "ASSIGNED",
        type:               parsed.type,
        qty:                +parsed.qty,
        premium:            0,
        anomaly_type:       "assigned",
        raw_description:    parsed.description || "Option Assigned",
        broker:             parsed.broker || (account?.startsWith("ETrade") ? "ETrade" : "Schwab"),
        resolved:           true,
        resolved_at:        new Date().toISOString(),
        resolved_parent_id: parent.id,
        dismissed:          false,
        notes:              `Auto-resolved → contract #${parent.id} closed. Profit: $${profit.toFixed(2)}`,
        raw:                parsed.raw || null,
      }, "resolution=ignore-duplicates");
    } catch(e) { console.warn("[handleAssignment] anomaly log failed:", e.message); }

    await sendPushover(
      `🎯 ${stock} $${strike} ${parsed.type} Assigned`,
      `Contract #${parent.id} closed automatically.\n${isSTO ? `💰 Profit: +$${profit.toFixed(2)} (full premium kept)` : `📉 Loss: $${profit.toFixed(2)} (BTO exercised)`}\nAccount: ${parent.account}\nExpiry: ${expires}`,
      `${APP_URL}/?tab=contracts`,
      0,
      "cashregister"
    );

    // ── Task #43: Wheel strategy auto-classification ──────────────────────────
    // When a put gets assigned, link all open STO contracts on the same stock
    // into a Wheel strategy group.
    try {
      if (isSTO && parent.opt_type === "STO") {
        // Find or create a strategy_group_id for this wheel
        let groupId = parent.strategy_group_id;
        if (!groupId) {
          // Use parent.id as a stable group identifier (first contract in the wheel)
          groupId = parent.id;
        }
        // Mark the assigned contract as Wheel
        await sbPatch("contracts", parent.id, { strategy: "Wheel", strategy_group_id: groupId, strategy_type: "wheel" });
        // Also mark any other open STOs on this stock that aren't already in a wheel
        const openSTOs = await sbGet(`contracts?stock=eq.${encodeURIComponent(stock)}&opt_type=eq.STO&status=eq.Open&strategy_group_id=is.null&select=id`);
        for (const c of (Array.isArray(openSTOs) ? openSTOs : [])) {
          await sbPatch("contracts", c.id, { strategy: "Wheel", strategy_group_id: groupId, strategy_type: "wheel" });
        }
        console.log(`[auto-import] Wheel strategy tagged on ${stock} group ${groupId}`);
      }
    } catch(e) { console.warn("[handleAssignment] Wheel tagging failed:", e.message); }

    // ── Task #55: Capture assignment as stock_transactions row ────────────────
    try {
      const sharesQty   = (+parsed.qty || 0) * 100;
      const assignPrice = +strike;
      const netAmt      = assignPrice * sharesQty;
      await sbPost("stock_transactions", {
        contract_id:      parent.id,
        symbol:           stock,
        transaction_type: "ASSIGNMENT",
        asset_type:       "EQUITY",
        quantity:         sharesQty,
        price:            assignPrice,
        net_amount:       isSTO ? -netAmt : netAmt, // STO put assigned = buying shares (cash out)
        trade_date:       new Date(date_exec + "T16:00:00Z").toISOString(),
        account:          account,
        description:      `Assignment from contract ${parent.id}: ${isSTO ? "bought" : "sold"} ${sharesQty} shares of ${stock} at $${assignPrice}`,
        schwab_transaction_id: parsed.schwab_transaction_id || null,
      }, "resolution=ignore-duplicates");
      console.log(`[auto-import] assignment stock_transaction recorded: ${stock} ${sharesQty} shares @ $${assignPrice}`);
    } catch(e) { console.warn("[handleAssignment] stock_transaction write failed:", e.message); }

    console.log(`[auto-import] ✅ Assignment auto-resolved: ${stock} $${strike} ${expires} → contract #${parent.id}, profit $${profit.toFixed(2)}`);
    return { resolved: true, parentId: parent.id, profit };
  }

  // Fallback — no match found, park as pending anomaly
  console.warn(`[handleAssignment] ⚠️ No open contract found for ${stock} $${strike} ${expires} (${account}) — routing to pending anomaly`);
  return { resolved: false };
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

  // Always filter to same account — NEVER match across accounts
  const sameAcct = candidates.filter(c => c.account === parsed.account);
  if (!sameAcct.length) {
    console.warn(`[matchToOpen] no same-account match for ${parsed.opt_type} ${parsed.stock} $${parsed.strike} ${parsed.expires} (${parsed.account}) — candidates are in: ${candidates.map(c=>c.account).join(", ")}`);
    return { matchId: null, matchConfidence: "unmatched" };
  }

  // Prefer exact qty
  const sameAcctExact = sameAcct.find(c => +c.qty === +parsed.qty);
  if (sameAcctExact) return { matchId: sameAcctExact.id, matchConfidence: "exact" };

  // Closest qty within same account
  const best = sameAcct.reduce((a,b) => Math.abs(+a.qty - +parsed.qty) < Math.abs(+b.qty - +parsed.qty) ? a : b);
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
      console.log(`[auto-import] BTC already handled by trade_order ${match.id} — will create BTC row but skip re-closing parent`);
      return { skip: false, skipParentClose: true, tradeOrderId: match.id };
    }
  } catch(e) { console.warn("[auto-import] alreadyHandledByTradeOrder check failed:", e.message); }
  return false;
}

// ── Commit a transaction to contracts table ───────────────────────────────────
async function commitTx(parsed, matchId, openContracts, stocksData, committedClosers = {}, opts = {}) {

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
        notes: `${existingCloser.notes ? existingCloser.notes + "\n" : ""}Split fill merged: +${parsed.qty} @ $${parsed.premium} (tx: ${parsed.schwab_transaction_id})`,
      });
      // Update in-memory tracker
      existingCloser.qty     = newQty;
      existingCloser.premium = newPremium;
      existingCloser.notes   = `${existingCloser.notes ? existingCloser.notes + "\n" : ""}Split fill merged: +${parsed.qty} @ $${parsed.premium} (tx: ${parsed.schwab_transaction_id})`;
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
      // ── Idempotency: never merge the exact same leg twice ──────────────────
      // (upstream schwab_transaction_id/fingerprint dedup should already prevent
      // this from reaching commitTx, but this is a cheap last-line safety check)
      const alreadyMerged = existing.notes?.includes(`tx: ${parsed.schwab_transaction_id}`);
      if (alreadyMerged) {
        console.log(`[auto-import] partial-fill: leg tx ${parsed.schwab_transaction_id} already merged into contract ${existing.id} — skipping duplicate`);
        return true;
      }

      // ── Partial-fill merge safety: prefer order_id match (same parent Schwab
      // order, multiple fill legs — e.g. one manual market order filled across
      // several counterparties). This is the common, legitimate case and does
      // NOT require a trade_orders row, since manual trades placed directly at
      // the broker never create one.
      //
      // Falls back to the older trade_orders.fill_qty guard only when order_id
      // is unavailable or doesn't match — this preserves protection against the
      // 2026-06-18 incident pattern (multiple distinct orders coincidentally
      // matching on stock/strike/expiry/account/date) without blocking the much
      // more common manual-fill case.
      const orderIdMatch = parsed.order_id != null && existing.order_id != null && parsed.order_id === existing.order_id;

      const guard = async () => {
        if (orderIdMatch) {
          console.log(`[auto-import] partial-fill guard: order_id match (${parsed.order_id}) for ${parsed.stock} $${parsed.strike} ${parsed.expires} — merge approved`);
          return true;
        }
        try {
          const toRes = await fetch(
            `${SUPABASE_URL}/rest/v1/trade_orders?select=fill_qty,qty&ticker=eq.${encodeURIComponent(parsed.stock)}&strike=eq.${encodeURIComponent(parsed.strike)}&expires=eq.${encodeURIComponent(parsed.expires)}&account=eq.${encodeURIComponent(parsed.account)}&side=eq.SELL&status=eq.filled&order=submitted_at.desc&limit=1`,
            { headers: { apikey: SUPABASE_SVC_KEY, Authorization: `Bearer ${SUPABASE_SVC_KEY}` } }
          );
          const toRows = await toRes.json();
          const filledQty = toRows?.[0]?.fill_qty ?? toRows?.[0]?.qty ?? null;
          if (filledQty == null) {
            console.log(`[auto-import] partial-fill guard: no order_id match and no matching trade_order found for ${parsed.stock} $${parsed.strike} ${parsed.expires} ${parsed.account} — routing to anomalies`);
            return false;
          }
          const mergedQty = (+existing.qty || 0) + (+parsed.qty || 0);
          if (mergedQty > filledQty) {
            console.log(`[auto-import] partial-fill guard: merge would exceed fill_qty (${existing.qty}+${parsed.qty}=${mergedQty} > ${filledQty}) for ${parsed.stock} $${parsed.strike} — routing to anomalies`);
            return false;
          }
          console.log(`[auto-import] partial-fill guard: merge validated via trade_orders (${existing.qty}+${parsed.qty}=${mergedQty} ≤ fill_qty ${filledQty}) for ${parsed.stock} $${parsed.strike}`);
          return true;
        } catch(e) {
          console.warn(`[auto-import] partial-fill guard lookup failed:`, e.message);
          return false; // conservative: route to anomalies on error
        }
      };
      const mergeOk = await guard();
      if (!mergeOk) {
        return {
          needsReview: true,
          anomalyData: {
            ...parsed,
            anomaly_type: "partial_fill_needs_review",
            notes: `Potential partial fill for open ${parsed.opt_type} ${parsed.stock} $${parsed.strike} ${parsed.expires} (${parsed.account}) — matches existing open contract ${existing.id} (current qty ${existing.qty}, premium $${existing.premium}). order_id ${parsed.order_id ?? "missing"} did not match existing order_id ${existing.order_id ?? "missing"}, and no matching trade_orders fill found — review against actual broker position size before merging manually.`,
            raw: parsed.raw,
          },
        };
      }
      // Merge validated — safe to apply
      const newQty     = (+existing.qty || 0) + (+parsed.qty || 0);
      const newPremium = Math.round(((+existing.premium || 0) + (+parsed.premium || 0)) * 100) / 100;
      const mergedNote = `${existing.notes ? existing.notes + "\n" : ""}Partial fill merged: ${parsed.qty} @ $${parsed.premium} on ${parsed.date_exec} (tx: ${parsed.schwab_transaction_id})`;
      await sbPatch("contracts", existing.id, {
        qty:                    newQty,
        premium:                newPremium,
        schwab_transaction_id:  existing.schwab_transaction_id, // keep original
        order_id:               existing.order_id ?? parsed.order_id ?? null, // preserve/backfill parent order id
        notes:                  mergedNote,
      });
      existing.qty     = newQty;
      existing.premium = newPremium;
      existing.notes   = mergedNote;
      console.log(`[auto-import] partial fill merged: ${parsed.stock} ${parsed.opt_type} $${parsed.strike} ${parsed.expires} qty ${existing.qty - (+parsed.qty||0)}+${parsed.qty}=${newQty}`);
      return true;
    }
  }

  // ── Infer strategy from opt_type + type + share ownership ────────────────
  function inferStrategy(optType, type, stock, sd) {
    if (!["STO","BTO"].includes(optType)) return null;
    const shares = sd?.[stock?.toUpperCase()]?.shares;
    // Only mark naked if shares is explicitly 0 — default to covered when data is missing
    const isNaked = shares != null && shares === 0;
    if (optType === "STO" && type === "Call")  return isNaked ? "Naked Call"        : "OTM Covered Call Strategy";
    if (optType === "STO" && type === "Put")   return isNaked ? "Naked Put"         : "Cash Secured Put";
    if (optType === "BTO" && type === "Call")  return "Long Call";
    if (optType === "BTO" && type === "Put")   return "Long Put";
    return null;
  }

  // Insert the transaction
  // ── Detect if this STO/BTO was placed by Skynet (has a matching trade_order) ──
  let openMethod = null;
  if (["STO","BTO"].includes(parsed.opt_type) && parsed.stock && parsed.strike && parsed.expires && parsed.account) {
    try {
      const toCheck = await fetch(
        `${SUPABASE_URL}/rest/v1/trade_orders?ticker=eq.${encodeURIComponent(parsed.stock)}&strike=eq.${parsed.strike}&expires=eq.${parsed.expires}&account=eq.${encodeURIComponent(parsed.account)}&opt_type=eq.${parsed.opt_type}&approved_by=eq.skynet_auto_sto&select=id,auto_execute&limit=1`,
        { headers: svcHeaders }
      );
      const toRows = toCheck.ok ? await toCheck.json() : [];
      if (toRows?.length > 0) {
        openMethod = 'auto';
        console.log(`[auto-import] detected Skynet STO for ${parsed.stock} $${parsed.strike} — setting open_method=auto (trade_order ${toRows[0].id})`);
      }
    } catch(e) { console.warn('[auto-import] open_method trade_order check failed:', e.message); }
  }

  const row = {
    schwab_transaction_id: parsed.schwab_transaction_id,
    order_id: parsed.order_id ?? null,
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
    settlement_date: parsed.settlement_date || null,
    account:  parsed.account,
    status:   ["BTC","STC","ASSIGNED"].includes(parsed.opt_type) ? "Closed" : "Open",
    price_at_execution: parsed.price_at_execution,
    exercised: parsed.exercised || "No",
    created_via: "Auto Import",
    parent_id: matchId || null,
    strategy:  inferStrategy(parsed.opt_type, parsed.type, parsed.stock, stocksData),
    open_method: openMethod,
  };

  // Pre-check: if this transaction ID already exists in DB (any status), skip
  if (parsed.schwab_transaction_id) {
    const existCheck = await fetch(
      `${SUPABASE_URL}/rest/v1/contracts?schwab_transaction_id=eq.${encodeURIComponent(parsed.schwab_transaction_id)}&select=id&limit=1`,
      { headers: sbHeaders }
    );
    const existRows = existCheck.ok ? await existCheck.json() : [];
    if (existRows?.length > 0) {
      console.log(`[auto-import] skipping already-imported tx ${parsed.schwab_transaction_id} (id ${existRows[0].id})`);
      return;
    }
  }

  // ETrade composite fingerprint dedup: same trade can appear with different transaction IDs
  // Fingerprint = stock + opt_type + strike + expires + account + date_exec + premium (±$0.10)
  if (parsed.schwab_transaction_id?.startsWith('etrade_') && parsed.opt_type && parsed.expires) {
    try {
      const premiumLow  = (Math.abs(parseFloat(parsed.premium) || 0) - 0.10).toFixed(2);
      const premiumHigh = (Math.abs(parseFloat(parsed.premium) || 0) + 0.10).toFixed(2);
      const sign = ['STO','STC'].includes(parsed.opt_type) ? 'gte' : 'lte';
      const fpCheck = await fetch(
        `${SUPABASE_URL}/rest/v1/contracts?stock=eq.${encodeURIComponent(parsed.stock)}&opt_type=eq.${parsed.opt_type}&strike=eq.${parsed.strike}&expires=eq.${parsed.expires}&account=eq.${encodeURIComponent(parsed.account)}&date_exec=eq.${parsed.date_exec}&select=id,schwab_transaction_id,premium&limit=5`,
        { headers: sbHeaders }
      );
      const fpRows = fpCheck.ok ? await fpCheck.json() : [];
      const fpMatch = fpRows.find(r => Math.abs(Math.abs(parseFloat(r.premium)) - Math.abs(parseFloat(parsed.premium))) <= 0.10);
      if (fpMatch) {
        console.log(`[auto-import] skipping ETrade re-issued tx ${parsed.schwab_transaction_id} — fingerprint matches existing contract ${fpMatch.id} (tx: ${fpMatch.schwab_transaction_id}, premium: ${fpMatch.premium})`);
        // Tag the duplicate tx ID on the existing row so future pre-checks catch it faster
        await fetch(`${SUPABASE_URL}/rest/v1/contracts?id=eq.${fpMatch.id}`, {
          method: 'PATCH',
          headers: { ...sbHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ schwab_transaction_id: parsed.schwab_transaction_id }),
        }).catch(() => {});
        return;
      }
    } catch(e) { console.warn('[auto-import] ETrade fingerprint check failed:', e.message); }
  }

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
      order_id:  parsed.order_id ?? null,
    });
    console.log(`[auto-import] new open added to in-memory list: ${parsed.stock} ${parsed.opt_type} $${parsed.strike} qty ${parsed.qty} @ ${parsed.account} order_id=${parsed.order_id ?? "none"}`);
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
async function sendPushover(title, message, url, priority = 0, sound = null) {
  const token = process.env.PUSHOVER_API_TOKEN;
  const user  = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return;
  const resolvedSound = sound || (priority >= 1 ? "cashregister" : "pushover");
  await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, user, title, message, url: url || `${APP_URL}/?tab=import`, url_title: "Review in App", priority, sound: resolvedSound }),
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
    const schwabTxs       = [];
    const schwabEquityTxs = [];
    try {
      const token    = await getValidToken();
      const accts    = await fetch(`${SCHWAB_BASE}/trader/v1/accounts/accountNumbers`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }).then(r => r.json());
      const startUTC = new Date(today + "T05:00:00.000Z").toISOString();
      const endUTC   = new Date(new Date(today + "T05:00:00.000Z").getTime() + 86400000).toISOString();
      for (const acct of (Array.isArray(accts) ? accts : [])) {
        if (!acct.hashValue) continue;
        // Fetch all transaction types — parsers split options vs equity downstream
        const txData = await fetch(`${SCHWAB_BASE}/trader/v1/accounts/${acct.hashValue}/transactions?startDate=${startUTC}&endDate=${endUTC}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }).then(r => r.json());
        const txList = Array.isArray(txData) ? txData : (txData?.transactions ?? []);
        txList.forEach(tx => {
          const p = parseSchwabTx(tx, stocksData, acct.accountNumber);
          if (p) { schwabTxs.push(p); return; }
          if ((tx.description || "").toUpperCase().includes("EXPIR")) {
            console.log("[auto-import] Schwab EXPIRY raw:", JSON.stringify({ type: tx.type, desc: tx.description, netAmount: tx.netAmount, items: tx.transferItems?.map(i => ({ effect: i.positionEffect, assetType: i.instrument?.assetType, symbol: i.instrument?.underlyingSymbol })) }));
          }
          const eq = parseSchwabEquityTx(tx, acct.accountNumber);
          if (eq) schwabEquityTxs.push(eq);
        });
      }
    } catch(e) { console.warn("[auto-import] Schwab fetch failed:", e.message); }

    // ── Fetch ETrade ──────────────────────────────────────────────────────────
    const etradeTxs       = [];
    const etradeEquityTxs = [];
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
          txList.forEach(tx => {
            const p = parseEtradeTx(tx, stocksData);
            if (p) { etradeTxs.push(p); return; }
            const eq = parseEtradeEquityTx(tx);
            if (eq) etradeEquityTxs.push(eq);
          });
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


      // ASSIGNED — auto-resolve if matching open contract found; else fall to pending anomaly
      if (tx.opt_type === "ASSIGNED") {
        const result = await handleAssignment(tx);
        if (result.resolved) {
          committed.push({ ...tx, _assignedParentId: result.parentId, profit: result.profit });
        } else {
          anomalies.push({ ...tx, anomaly_type: "assigned", notes: "Option assigned/exercised — no matching open contract found, manual review required", raw: tx.raw });
        }
        continue;
      }

      const { matchId, matchConfidence } = matchToOpen(tx, openContracts);

      if (matchConfidence === "unmatched") {
        // Check if this BTC was already handled by a Skynet trade_order — skip if so
        const handled = await alreadyHandledByTradeOrder(tx);
        if (handled === true) continue;
        if (handled?.skip) continue;
        // handled?.skipParentClose = true means: create BTC row but don't re-close the STO
        // (fill detection already closed it; auto-import just needs to create the audit trail row)
        const skipParentClose = handled?.skipParentClose === true;
        if (skipParentClose) {
          // Create the BTC contract row for audit trail, but skip closing parent STO
          try {
            const wasCommitted = await commitTx(tx, null, openContracts, stocksData, committedClosers, { skipParentClose: true });
            if (wasCommitted) committed.push(tx);
            console.log(`[auto-import] created BTC audit row for ${tx.stock} $${tx.strike} ${tx.expires} (parent already closed by fill detection)`);
          } catch(e) { console.warn(`[auto-import] BTC audit row failed:`, e.message); }
          continue;
        }
        // Unmatched closer — log as anomaly
        anomalies.push({ ...tx, anomaly_type: "unmatched_close", notes: `No matching open contract found for ${tx.opt_type} ${tx.stock} $${tx.strike} ${tx.type} ${tx.expires}`, raw: tx.raw });
        continue;
      }

      // Auto-commit exact and partial matches, and all opens
      try {
        const wasCommitted = await commitTx(tx, matchId, openContracts, stocksData, committedClosers);
        if (wasCommitted === true) {
          committed.push(tx);
        } else if (wasCommitted && wasCommitted.needsReview) {
          anomalies.push(wasCommitted.anomalyData);
        }
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
      const existingAnomalies = await sbGet(`import_anomalies?select=stock,opt_type,strike,expires,account,premium,qty,date_exec,anomaly_type,schwab_transaction_id,notes,dismissed,resolved`);
      const existingIds = new Set(existingAnomalies.map(r => r.schwab_transaction_id));
      const existingFingerprints = new Set(existingAnomalies.map(anomalyFingerprint));

      // partial_fill_needs_review: Schwab can reissue a new transaction ID (and a slightly
      // different qty/premium fragment) for the same already-flagged position on every poll —
      // see 2026-06-18 incident. Fingerprint/ID dedup doesn't catch that, so for this anomaly
      // type, dedupe instead by the matched contract id embedded in the notes text, and only
      // against anomalies that are still active (not dismissed/resolved) so a genuinely new
      // partial fill can still be flagged later if this one gets cleared.
      const extractMatchedContractId = notes => notes?.match(/matches existing open contract (\d+)/)?.[1] || null;
      const existingActivePartialFillContractIds = new Set(
        existingAnomalies
          .filter(r => r.anomaly_type === "partial_fill_needs_review" && !r.dismissed && !r.resolved)
          .map(r => extractMatchedContractId(r.notes))
          .filter(Boolean)
      );
      const isDupeAnomaly = a => {
        if (a.anomaly_type === "partial_fill_needs_review") {
          const cid = extractMatchedContractId(a.notes);
          return !!(cid && existingActivePartialFillContractIds.has(cid));
        }
        return existingIds.has(a.schwab_transaction_id) || existingFingerprints.has(anomalyFingerprint(a));
      };

      const trulyNewAnomalies = anomalyRows.filter(a => !isDupeAnomaly(a));

      // Save — ignore dupes via unique constraint
      for (const row of anomalyRows) {
        if (isDupeAnomaly(row)) continue;
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

      // Calculate total profit on closed trades committed this run
      const totalProfit = closes.reduce((s,t) => {
        // Look up the profit we wrote to the DB (it's on the parent contract)
        // committed array has what was inserted; profit is on the closer row
        return s + (t.profit || 0);
      }, 0);

      let msg = `${committed.length} transaction${committed.length > 1 ? "s" : ""} auto-committed.`;
      if (opens.length)  msg += `\n📤 ${opens.length} open${opens.length > 1 ? "s" : ""}`;
      if (closes.length) {
        msg += `\n✅ ${closes.length} close${closes.length > 1 ? "s" : ""}`;
        if (totalProfit !== 0) {
          msg += `\n${totalProfit >= 0 ? "💰" : "📉"} Net P&L: ${totalProfit >= 0 ? "+" : ""}$${totalProfit.toFixed(2)}`;
        }
      }

      // Gamify: pick Pushover sound based on profit
      // cashregister = win 🎰, falling = loss 😢, magic = break-even/no closes
      const sound = closes.length === 0 ? "magic"
                  : totalProfit > 0     ? "cashregister"
                  : totalProfit < 0     ? "falling"
                  :                       "magic";

      const title = closes.length === 0 ? "📥 Auto-Import Complete"
                  : totalProfit > 0     ? "🎰 Import Complete — Profitable!"
                  : totalProfit < 0     ? "📉 Import Complete — Loss"
                  :                      "📥 Auto-Import Complete";

      await sendPushover(title, msg, `${APP_URL}/?tab=contracts`, 0, sound);
    }

    // ── Import equity transactions ────────────────────────────────────────────
    let equityImported    = 0;
    const equityImportedRows = [];
    const allEquityTxs   = [...schwabEquityTxs, ...etradeEquityTxs];
    if (allEquityTxs.length) {
      try {
        // Load existing stock_transaction IDs + composite fingerprints for dedup
        const existingStockTxs = await sbGet(
          `stock_transactions?select=schwab_transaction_id,symbol,transaction_type,trade_date,net_amount,account&trade_date=gte.${CUTOVER_DATE}T00:00:00Z`
        );
        const existingStockIds = new Set(
          (Array.isArray(existingStockTxs) ? existingStockTxs : [])
            .map(r => String(r.schwab_transaction_id))
            .filter(Boolean)
        );
        // Composite fingerprint: symbol|type|YYYY-MM-DD|rounded_cents_amount|account
        const makeEquityFP = r => {
          const dateStr = r.trade_date
            ? new Date(r.trade_date).toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10)
            : "";
          return `${r.symbol || ""}|${r.transaction_type}|${dateStr}|${Math.round(Math.abs(+(r.net_amount || 0)) * 100)}|${r.account}`;
        };
        const existingEquityFPs = new Set(
          (Array.isArray(existingStockTxs) ? existingStockTxs : []).map(makeEquityFP)
        );

        for (const eq of allEquityTxs) {
          const idStr = String(eq.schwab_transaction_id);
          if (existingStockIds.has(idStr)) continue;   // skip silently — already imported
          if (existingEquityFPs.has(makeEquityFP(eq))) continue; // skip silently — fingerprint match
          try {
            await sbPost("stock_transactions", eq, "resolution=ignore-duplicates");
            equityImported++;
            equityImportedRows.push(eq);
            existingStockIds.add(idStr);
            existingEquityFPs.add(makeEquityFP(eq));
            console.log(`[auto-import] equity imported: ${eq.transaction_type} ${eq.symbol || "(no symbol)"} $${eq.net_amount} (${eq.account})`);
          } catch(e) {
            console.warn(`[auto-import] equity insert failed for ${idStr}:`, e.message);
          }
        }

        // Daily summary Pushover — one notification per run if anything was imported
        if (equityImported > 0) {
          const preview = equityImportedRows.slice(0, 5)
            .map(eq => `${eq.transaction_type}${eq.symbol ? " " + eq.symbol : ""}: $${Math.abs(eq.net_amount).toFixed(2)} (${eq.account})`)
            .join("\n");
          const suffix = equityImported > 5 ? `\n…+${equityImported - 5} more` : "";
          await sendPushover(
            `📊 ${equityImported} equity transaction${equityImported > 1 ? "s" : ""} imported`,
            preview + suffix,
            `${APP_URL}/?tab=import`,
            0
          );
        }
      } catch(e) {
        console.warn("[auto-import] equity import block failed:", e.message);
      }
    }

    // ── Ecosystem heartbeat ──────────────────────────────────────────────────────
    const now = new Date().toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/ecosystem_heartbeat`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ agent_name: "auto-import", last_run_at: now, status: "ok", notes: `${committed.length} committed, ${anomalies.length} anomalies, ${equityImported} equity`, updated_at: now }),
    }).catch(e => console.warn("[heartbeat] write failed:", e.message));

    return res.status(200).json({
      ok: true,
      committed: committed.length,
      anomalies: anomalies.length,
      equityImported,
      debug: { schwabTxs: schwabTxs.length, etradeTxs: etradeTxs.length, allTxs: allTxs.length, existingIds: existingIds.size, equityTxs: allEquityTxs.length },
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
