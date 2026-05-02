// api/chain-refresh.js
// Fetches option chains for all open positions and saves to Supabase
// Uses parallel fetches to stay well under Vercel's 10s timeout

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SCHWAB_BASE  = "https://api.schwabapi.com";

async function getValidToken() {
  const res  = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_tokens`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
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
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
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
    if (!contracts.length) return res.status(200).json({ ok: true, chains: 0 });

    // Deduplicate ticker|expiry pairs
    const seen = new Set();
    const pairs = [];
    for (const c of contracts) {
      if (!c.stock || !c.expires) continue;
      const key = `${c.stock.toUpperCase()}|${c.expires}`;
      if (!seen.has(key)) { seen.add(key); pairs.push({ ticker: c.stock.toUpperCase(), expiry: c.expires, key }); }
    }

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
