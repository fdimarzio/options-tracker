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
function parseTransaction(tx) {
  const item = tx.transactionItem;
  const inst = item?.instrument;

  // Only process options
  if (inst?.assetType !== "OPTION") return null;

  // Derive opt_type from instruction + positionEffect
  const instruction    = item.instruction?.toUpperCase();   // BUY | SELL
  const positionEffect = item.positionEffect?.toUpperCase(); // OPENING | CLOSING
  let optType = null;
  if      (instruction === "BUY"  && positionEffect === "OPENING") optType = "BTO";
  else if (instruction === "SELL" && positionEffect === "OPENING") optType = "STO";
  else if (instruction === "BUY"  && positionEffect === "CLOSING") optType = "BTC";
  else if (instruction === "SELL" && positionEffect === "CLOSING") optType = "STC";
  if (!optType) return null; // skip assignments, expirations etc.

  const isOpen   = optType === "BTO" || optType === "STO";
  const callOrPut = inst.putCall; // "CALL" | "PUT"

  // Premium: Schwab gives netAmount (negative = paid, positive = received)
  // Normalize: STO/STC = positive (credit received), BTO/BTC = negative (debit paid)
  const rawAmount = tx.netAmount ?? 0;
  const qty       = Math.abs(item.amount ?? 1);
  // Per-contract premium (netAmount already accounts for qty×100)
  const premium   = rawAmount; // keep sign: positive=credit, negative=debit

  // Trade date
  const tradeDate = tx.tradeDate
    ? tx.tradeDate.slice(0, 10)
    : tx.transactionDate?.slice(0, 10);

  // Expiration: Schwab returns expirationDate as "YYYY-MM-DDTHH:mm:ssZ" or "YYYY-MM-DD"
  const expires = inst.expirationDate
    ? inst.expirationDate.slice(0, 10)
    : null;

  return {
    schwabTransactionId: tx.transactionId ?? tx.activityId ?? null,
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
    // raw for debugging
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

// ── Load existing open contracts from Supabase for auto-linking ──────────────
async function loadExistingOpens() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/contracts?select=id,stock,opt_type,strike,expires,qty,account,status&status=eq.Open`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  return await res.json();
}

// ── Auto-match a closing trade to its opener ─────────────────────────────────
// Returns { parentId, confidence } or null
function autoMatch(closer, openers, batchOpeners = []) {
  const oppositeType = { BTC: "BTO", STC: "STO" };
  const targetOptType = oppositeType[closer.optType];
  if (!targetOptType) return null;

  const candidates = [
    ...batchOpeners.filter(o => o.optType === targetOptType),
    ...openers.filter(o => o.opt_type === targetOptType),
  ];

  const matches = candidates.filter(o => {
    const stock   = (o.stock   || o.stock)?.toUpperCase()   === closer.stock?.toUpperCase();
    const strike  = Number(o.strike  ?? o.strike)  === Number(closer.strike);
    const expires = (o.expires ?? o.expires)?.slice(0, 10)  === closer.expires;
    const account = (o.account ?? o.account)?.toLowerCase() === closer.account?.toLowerCase();
    return stock && strike && expires && account;
  });

  if (!matches.length) return { parentId: null, confidence: "unmatched" };

  // If qty matches exactly, high confidence
  const exactQty = matches.find(o => Number(o.qty) === Number(closer.qty));
  if (exactQty) return { parentId: exactQty.id ?? exactQty._batchIdx, confidence: "exact" };

  // Otherwise, pick the best candidate (closest qty)
  const best = matches.reduce((a, b) =>
    Math.abs(Number(a.qty) - Number(closer.qty)) < Math.abs(Number(b.qty) - Number(closer.qty)) ? a : b
  );
  return { parentId: best.id ?? best._batchIdx, confidence: "partial" };
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
        c.matchConfidence  = match?.confidence ?? "unmatched";
      } else {
        c.parentId        = null;
        c.matchConfidence = null;
      }
    }

    res.status(200).json({
      transactions: parsed,
      meta: { startDate, endDate, total: parsed.length, rawTotal: allRaw.length },
    });
  } catch (err) {
    console.error("[schwab-transactions] error:", err.message);
    res.status(500).json({ error: err.message });
  }
}
