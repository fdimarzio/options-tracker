// api/chain-refresh.js
// Fetches option chains for all open positions and saves to Supabase
// Uses parallel fetches to stay well under Vercel's 10s timeout

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY; // service key for token rows
const SCHWAB_BASE  = "https://api.schwabapi.com";

async function getValidToken() {
  const res  = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_tokens`, {
    headers: { apikey: SUPABASE_SVC_KEY, Authorization: `Bearer ${SUPABASE_SVC_KEY}` },
  });
  const t = (await res.json())?.[0]?.cols;
  if (!t?.accessToken) throw new Error("No Schwab tokens");
  if (t.accessTokenExpiresAt > Date.now() + 120000) return t.accessToken;
  if (!t.refreshToken || t.refreshTokenExpiresAt < Date.now()) throw new Error("Refresh token expired");
  const creds = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString("base64");
  const r = await fetch("https://api.schwabapi.com/v1/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken }),
  });
  const n = await r.json();
  if (!n.access_token) throw new Error("Token refresh failed");
  await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
    method: "POST",
    headers: { apikey: SUPABASE_SVC_KEY, Authorization: `Bearer ${SUPABASE_SVC_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: "schwab_tokens", cols: { ...t, accessToken: n.access_token, refreshToken: n.refresh_token || t.refreshToken, accessTokenExpiresAt: Date.now() + (n.expires_in * 1000) }, updated_at: new Date().toISOString() }),
  });
  return n.access_token;
}

async function fetchChain(token, ticker, expiry) {
  const url = `${SCHWAB_BASE}/marketdata/v1/chains?symbol=${ticker}&contractType=ALL&strikeCount=20&fromDate=${expiry}&toDate=${expiry}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const calls = [], puts = [];
  for (const [, strikes] of Object.entries(data?.callExpDateMap || {}))
    for (const [, opts] of Object.entries(strikes))
      for (const o of opts) calls.push({ strikePrice: o.strikePrice, bid: o.bid, ask: o.ask, last: o.last, mark: o.mark, delta: o.delta, volatility: o.volatility, totalVolume: o.totalVolume, openInterest: o.openInterest });
  for (const [, strikes] of Object.entries(data?.putExpDateMap || {}))
    for (const [, opts] of Object.entries(strikes))
      for (const o of opts) puts.push({ strikePrice: o.strikePrice, bid: o.bid, ask: o.ask, last: o.last, mark: o.mark, delta: o.delta, volatility: o.volatility, totalVolume: o.totalVolume, openInterest: o.openInterest });
  return { calls, puts };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  const secret   = process.env.CRON_SECRET;
  const provided = req.headers["x-cron-secret"] || req.query.secret;
  if (secret && provided !== secret) return res.status(401).json({ error: "Unauthorized" });

  const startTime = Date.now();

  try {
    const token = await getValidToken();

    // Fetch open contracts
    const cRes = await fetch(`${SUPABASE_URL}/rest/v1/contracts?select=stock,expires&status=eq.Open`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const contracts = await cRes.json();

    // Fetch autoSto tickers from stocks_data
    const sdRes = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.stocks_data`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const sdBlob = (await sdRes.json())?.[0]?.cols || {};
    const autoStoTickers = Object.entries(sdBlob)
      .filter(([sym, v]) => sym !== "__cash__" && v?.autoSto === true)
      .map(([sym]) => sym.toUpperCase());

    console.log(`[chain-refresh] autoSto tickers: ${autoStoTickers.join(", ") || "none"}`);

    // Generate all Mon/Wed/Fri expirations for the next 16 days
    // High-volume tickers (AMZN, NVDA, AAPL etc) expire MWF; others expire Fri only
    // Fetching all three gives market-refresh the best pick
    function nextExpiryDates(days) {
      const dates = [];
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + 1); // start tomorrow
      const end = new Date(d.getTime() + days * 86400000);
      while (d <= end) {
        const dow = d.getDay();
        if (dow === 1 || dow === 3 || dow === 5) { // Mon, Wed, Fri
          dates.push(d.toISOString().slice(0, 10));
        }
        d.setDate(d.getDate() + 1);
      }
      return dates;
    }
    const upcomingExpiries = nextExpiryDates(16);
    console.log(`[chain-refresh] expiry dates to fetch: ${upcomingExpiries.join(", ")}`);

    // Deduplicate ticker|expiry pairs — open contracts + autoSto tickers x upcoming expiries
    const seen = new Set();
    const pairs = [];

    for (const c of (Array.isArray(contracts) ? contracts : [])) {
      if (!c.stock || !c.expires) continue;
      const key = `${c.stock.toUpperCase()}|${c.expires}`;
      if (!seen.has(key)) { seen.add(key); pairs.push({ ticker: c.stock.toUpperCase(), expiry: c.expires, key }); }
    }

    for (const ticker of autoStoTickers) {
      for (const expiry of upcomingExpiries) {
        const key = `${ticker}|${expiry}`;
        if (!seen.has(key)) { seen.add(key); pairs.push({ ticker, expiry, key }); }
      }
    }

    if (!pairs.length) return res.status(200).json({ ok: true, chains: 0, message: "No open contracts or autoSto tickers" });

    // Fetch all chains IN PARALLEL — this is the key fix vs sequential awaits
    const results = await Promise.allSettled(
      pairs.map(({ ticker, expiry }) => fetchChain(token, ticker, expiry))
    );

    const chainData = {};
    let failed = 0;
    for (let i = 0; i < pairs.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        chainData[pairs[i].key] = r.value;
      } else {
        console.warn(`chain failed ${pairs[i].key}:`, r.reason?.message);
        failed++;
      }
    }

    const lastRefresh = new Date().toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ id: "last_chain_refresh", cols: { chains: chainData, lastRefresh }, updated_at: lastRefresh }),
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    res.status(200).json({ ok: true, time: lastRefresh, chains: Object.keys(chainData).length, failed, elapsed: `${elapsed}s` });
  } catch (err) {
    console.error("[chain-refresh]", err.message);
    res.status(500).json({ error: err.message });
  }
}
