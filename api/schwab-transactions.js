// api/schwab-transactions.js
// Fetches option transactions from Schwab, parses them, fetches stock prices,
// and auto-matches closing trades to their opening counterparts in Supabase.
//
// GET /api/schwab-transactions?days=30
// GET /api/schwab-transactions?startDate=2025-01-01&endDate=2025-12-31

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SCHWAB_BASE  = "https://api.schwabapi.com";

// ── Token helper (same pattern as schwab-proxy.js) ───────────────────────────
async function getValidToken() {
  const res  = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_tokens`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const rows = await res.json();
  const t    = rows?.[0]?.cols;
  if (!t?.accessToken) throw new Error("No Schwab tokens — visit /api/schwab-auth to authorize");

  if (t.accessTokenExpiresAt > Date.now() + 120000) return t.accessToken;

  if (!t.refreshToken) throw new Error("No refresh token");
  if (t.refreshTokenExpiresAt < Date.now()) throw new Error("Refresh token expired — re-authorize at /api/schwab-auth");

  const credentials = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString("base64");
  const refreshRes  = await fetch("https://api.schwabapi.com/v1/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken }),
  });
  const newTokens = await refreshRes.json();
  if (!newTokens.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(newTokens)}`);

  await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      id: "schwab_tokens",
      cols: { ...t, accessToken: newTokens.access_token, refreshToken: newTokens.refresh_token || t.refreshToken, accessTokenExpiresAt: Date.now() + (newTokens.expires_in * 1000), savedAt: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }),
  });
  return newTokens.access_token;
}

async function schwabFetch(path, params = {}, token) {
  const qs  = Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`${SCHWAB_BASE}${path}${qs}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Schwab ${res.status} ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// ── Parse a Schwab transaction into our contract shape ───────────────────────
// Schwab structure: tx.transferItems[] — find the OPTION item among them
function parseTransaction(tx) {
  // Find the option leg in transferItems (ignore CURRENCY fee items)
  const items = tx.transferItems ?? [];
  const optItem = items.find(i => i.instrument?.assetType === "OPTION");
  if (!optItem) return null;

  const inst           = optItem.instrument;
  const positionEffect = optItem.positionEffect?.toUpperCase(); // "OPENING" | "CLOSING"

  // amount on the option transferItem: negative = SELL, positive = BUY
  // This is the most reliable signal — netAmount is unreliable on rolls/spreads
  const itemAmount = optItem.amount ?? 0;
  const isBuy      = itemAmount > 0;
  const isSell     = itemAmount < 0;

  let optType = null;
  if      (isBuy  && positionEffect === "OPENING") optType = "BTO";
  else if (isSell && positionEffect === "OPENING") optType = "STO";
  else if (isBuy  && positionEffect === "CLOSING") optType = "BTC";
  else if (isSell && positionEffect === "CLOSING") optType = "STC";

  if (!optType) return null; // skip assignments, expirations, etc.

  const isOpen    = optType === "BTO" || optType === "STO";
  const callOrPut = inst.putCall?.toUpperCase(); // "CALL" | "PUT"

  // qty: absolute value of amount on the option item (number of contracts)
  const qty = Math.abs(itemAmount);

  // Premium: use netAmount (includes fees, matches what we actually paid/received)
  // Keep sign: positive = credit received (STO/STC), negative = debit paid (BTO/BTC)
  const netAmount = tx.netAmount ?? 0;
  const premium   = netAmount;

  // Trade date
  const tradeDate = tx.tradeDate
    ? tx.tradeDate.slice(0, 10)
    : tx.time?.slice(0, 10);

  // Expiration
  const expires = inst.expirationDate
    ? inst.expirationDate.slice(0, 10)
    : null;

  return {
    schwabTransactionId: tx.activityId ?? tx.transactionId ?? null,
    stock:               inst.underlyingSymbol?.toUpperCase() ?? null,
    type:                callOrPut === "PUT" ? "Put" : "Call",
    optType,
    strike:              inst.strikePrice ?? null,
    qty,
    expires,
    premium,
    priceAtExecution:    null, // filled in separately
    dateExec:            tradeDate,
    account:             "Schwab",
    status:              isOpen ? "Open" : "Closed",
    strategy:            null, // user fills in
    notes:               null, // user fills in
    createdVia:          "Schwab Import",
    _raw:                tx,
  };
}

// ── Fetch historical closing price for a stock on a given date ───────────────
async function fetchClosingPrice(symbol, date, token) {
  try {
    // Schwab pricehistory: get 1-day candle around the target date
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    const data = await schwabFetch("/marketdata/v1/pricehistory", {
      symbol,
      periodType:         "day",
      period:             1,
      frequencyType:      "daily",
      frequency:          1,
      startDate:          start.getTime(),
      endDate:            end.getTime(),
      needExtendedHoursData: false,
    }, token);

    const candles = data?.candles;
    if (candles?.length) return candles[candles.length - 1].close ?? null;
    return null;
  } catch (err) {
    console.warn(`[schwab-transactions] closing price fetch failed for ${symbol} on ${date}:`, err.message);
    return null;
  }
}

// ── Fetch live quote for a stock ─────────────────────────────────────────────
async function fetchLivePrice(symbol, token) {
  try {
    const data = await schwabFetch("/marketdata/v1/quotes", {
      symbols: symbol, fields: "quote", indicative: false,
    }, token);
    const q = data?.[symbol]?.quote ?? data?.[symbol];
    return q?.lastPrice ?? q?.mark ?? null;
  } catch (err) {
    console.warn(`[schwab-transactions] live price fetch failed for ${symbol}:`, err.message);
    return null;
  }
}

// ── Load existing open Schwab contracts from Supabase for auto-linking ─────────
// Fetches BTO/STO contracts from Schwab account (Open or manually-closed)
// We include all statuses so we can match even if the user marked it closed manually
async function loadExistingOpens() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/contracts?select=id,stock,opt_type,strike,expires,qty,account,status&account=eq.Schwab&order=id.desc&limit=1000`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  // Only want openers (BTO/STO) for matching purposes
  return rows.filter(r => r.opt_type === "BTO" || r.opt_type === "STO");
}

// ── Auto-match a closing trade to its opener ─────────────────────────────────
// Returns { parentId, matchedContract, confidence }
function autoMatch(closer, dbOpeners, batchOpeners = []) {
  const oppositeType = { BTC: "BTO", STC: "STO" };
  const targetOptType = oppositeType[closer.optType];
  if (!targetOptType) return null;

  // Combine batch openers (same import) and DB openers
  // Normalize to a common shape for comparison
  const candidates = [
    ...batchOpeners
      .filter(o => o.optType === targetOptType)
      .map(o => ({ id: o._batchIdx, stock: o.stock, opt_type: o.optType, strike: o.strike, expires: o.expires, qty: o.qty, account: o.account, _isBatch: true })),
    ...dbOpeners.filter(o => o.opt_type === targetOptType),
  ];

  // Match on stock + strike + expiry (drop account filter — some older records may vary)
  const matches = candidates.filter(o => {
    const stock  = o.stock?.toUpperCase()  === closer.stock?.toUpperCase();
    const strike = Number(o.strike)        === Number(closer.strike);
    const exp    = o.expires?.slice(0, 10) === closer.expires;
    return stock && strike && exp;
  });

  if (!matches.length) return { parentId: null, matchedContract: null, confidence: "unmatched" };

  // Prefer exact qty match
  const exactQty = matches.find(o => Number(o.qty) === Number(closer.qty));
  if (exactQty) return { parentId: exactQty.id, matchedContract: exactQty, confidence: "exact" };

  // Otherwise pick closest qty — mark as partial
  const best = matches.reduce((a, b) =>
    Math.abs(Number(a.qty) - Number(closer.qty)) < Math.abs(Number(b.qty) - Number(closer.qty)) ? a : b
  );
  return { parentId: best.id, matchedContract: best, confidence: "partial" };
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const token = await getValidToken();

    // Date range
    const today    = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    let startDate, endDate;

    if (req.query.startDate) {
      startDate = req.query.startDate;
      endDate   = req.query.endDate || todayStr;
    } else {
      const days = parseInt(req.query.days ?? "30", 10);
      const from = new Date(today);
      from.setDate(from.getDate() - days);
      startDate = from.toISOString().slice(0, 10);
      endDate   = todayStr;
    }

    // Step 1: Get account hash
    const acctData = await schwabFetch("/trader/v1/accounts/accountNumbers", {}, token);
    const accounts = Array.isArray(acctData) ? acctData : [acctData];
    if (!accounts.length) throw new Error("No Schwab accounts found");

    // Step 2: Fetch transactions for each account
    const allRaw = [];
    for (const acct of accounts) {
      const hash = acct.hashValue;
      if (!hash) continue;
      const txData = await schwabFetch(`/trader/v1/accounts/${hash}/transactions`, {
        types:     "TRADE",
        startDate: `${startDate}T00:00:00.000Z`,
        endDate:   `${endDate}T23:59:59.000Z`,
      }, token);
      const txList = Array.isArray(txData) ? txData : (txData?.transactions ?? []);
      allRaw.push(...txList);
    }

    // Debug mode: return raw first 3 transactions + parse attempt details
    if (req.query.debug === "1") {
      const debugInfo = allRaw.slice(0, 3).map(tx => {
        const items    = tx.transferItems ?? [];
        const optItem  = items.find(i => i.instrument?.assetType === "OPTION");
        const parsed   = parseTransaction(tx);
        return {
          activityId:      tx.activityId,
          netAmount:       tx.netAmount,
          transferItemCount: items.length,
          assetTypes:      items.map(i => i.instrument?.assetType),
          optItemFound:    !!optItem,
          optItemEffect:   optItem?.positionEffect,
          optItemAmount:   optItem?.amount,
          optItemCost:     optItem?.cost,
          parsedResult:    parsed ? { optType: parsed.optType, stock: parsed.stock, strike: parsed.strike } : null,
          parseFailReason: !optItem ? "no OPTION in transferItems"
                         : !parsed  ? "optType could not be determined"
                         : "ok",
        };
      });
      return res.status(200).json({ debug: debugInfo, rawTotal: allRaw.length });
    }

    // Step 3: Parse — options only
    const parsed = allRaw.map(parseTransaction).filter(Boolean);

    // Step 4: Fetch stock prices
    // Group by (symbol, date) to minimize API calls
    const priceMap = {};
    const symbolDates = [...new Set(parsed.map(c => `${c.stock}|${c.dateExec}`))];
    for (const key of symbolDates) {
      const [symbol, date] = key.split("|");
      if (!symbol || !date) continue;
      const isToday = date === todayStr;
      priceMap[key] = isToday
        ? await fetchLivePrice(symbol, token)
        : await fetchClosingPrice(symbol, date, token);
    }

    // Attach prices + flag them
    for (const c of parsed) {
      const key   = `${c.stock}|${c.dateExec}`;
      const price = priceMap[key] ?? null;
      c.priceAtExecution      = price;
      c.priceAtExecutionAuto  = price !== null; // true = auto-filled, user can override
      c.priceAtExecutionType  = c.dateExec === todayStr ? "live" : "closing";
    }

    // Step 5: Auto-link closers to openers
    const existingOpens = await loadExistingOpens();

    // Assign temp batch indices to openers within this batch
    const batchOpeners = parsed
      .filter(c => c.optType === "BTO" || c.optType === "STO")
      .map((c, i) => ({ ...c, _batchIdx: `batch_${i}` }));

    for (const c of parsed) {
      if (c.optType === "BTC" || c.optType === "STC") {
        const match = autoMatch(c, existingOpens, batchOpeners);
        c.parentId         = match?.parentId ?? null;
        c.matchedContract  = match?.matchedContract ?? null; // for display in review UI
        c.matchConfidence  = match?.confidence ?? "unmatched";
      } else {
        c.parentId        = null;
        c.matchedContract = null;
        c.matchConfidence = null;
      }
    }

    // Also send the full list of open DB contracts to the UI
    // so the manual-match dropdown can be populated
    const allOpenContracts = existingOpens;

    res.status(200).json({
      transactions: parsed,
      openContracts: allOpenContracts,
      meta: { startDate, endDate, total: parsed.length, rawTotal: allRaw.length },
    });
  } catch (err) {
    console.error("[schwab-transactions] error:", err.message);
    res.status(500).json({ error: err.message });
  }
}
