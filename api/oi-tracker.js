// api/oi-tracker.js
// Daily job: snapshots open interest for all tracked tickers across all active expiries.
// Called by GitHub Actions once daily (after market close).
// Auto-purges oi_snapshots rows where expiry has passed.
// Tracked tickers stored in col_prefs -> oi_tracked_tickers -> { tickers: ["AAPL","NVDA",...] }

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SCHWAB_BASE  = "https://api.schwabapi.com";

async function getValidToken() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_tokens`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const t = (await r.json())?.[0]?.cols;
  if (!t?.accessToken) throw new Error("No Schwab tokens");
  if (t.accessTokenExpiresAt > Date.now() + 120000) return t.accessToken;
  if (!t.refreshToken || t.refreshTokenExpiresAt < Date.now()) throw new Error("Refresh token expired");
  const creds = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString("base64");
  const tr = await fetch("https://api.schwabapi.com/v1/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken }),
  });
  const n = await tr.json();
  if (!n.access_token) throw new Error("Token refresh failed");
  await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: "schwab_tokens", cols: { ...t, accessToken: n.access_token, refreshToken: n.refresh_token || t.refreshToken, accessTokenExpiresAt: Date.now() + (n.expires_in * 1000) }, updated_at: new Date().toISOString() }),
  });
  return n.access_token;
}

async function fetchChainOI(token, ticker) {
  // Fetch full chain (all expiries, all strikes) to get OI snapshots
  const url = `${SCHWAB_BASE}/marketdata/v1/chains?symbol=${ticker}&contractType=ALL&strikeCount=50&includeUnderlyingQuote=false`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${ticker}`);
  const data = await r.json();

  const rows = [];
  const today = new Date().toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);

  for (const [expKey, strikes] of Object.entries(data?.callExpDateMap || {})) {
    const expiry = expKey.split(":")[0]; // "2026-05-16:15" -> "2026-05-16"
    if (expiry < today) continue; // skip already-expired
    for (const [, opts] of Object.entries(strikes)) {
      for (const o of opts) {
        if (o.openInterest == null) continue;
        rows.push({ ticker, expiry, strike: o.strikePrice, type: "Call", open_interest: o.openInterest, date: today });
      }
    }
  }
  for (const [expKey, strikes] of Object.entries(data?.putExpDateMap || {})) {
    const expiry = expKey.split(":")[0];
    if (expiry < today) continue;
    for (const [, opts] of Object.entries(strikes)) {
      for (const o of opts) {
        if (o.openInterest == null) continue;
        rows.push({ ticker, expiry, strike: o.strikePrice, type: "Put", open_interest: o.openInterest, date: today });
      }
    }
  }

  return rows;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const secret   = process.env.CRON_SECRET;
  const provided = req.headers["x-cron-secret"] || req.query.secret;
  if (secret && provided !== secret) return res.status(401).json({ error: "Unauthorized" });

  const today = new Date().toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);

  try {
    // ── Step 1: purge expired snapshots ─────────────────────────────────────
    const purgeRes = await fetch(
      `${SUPABASE_URL}/rest/v1/oi_snapshots?expiry=lt.${today}`,
      { method: "DELETE", headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    console.log("[oi-tracker] purge status:", purgeRes.status);

    // ── Step 2: load tracked tickers ────────────────────────────────────────
    const cfgRes = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.oi_tracked_tickers`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const trackedTickers = (await cfgRes.json())?.[0]?.cols?.tickers || [];

    // Also pull tickers from open contracts to always cover current positions
    const openRes = await fetch(
      `${SUPABASE_URL}/rest/v1/contracts?select=stock&status=eq.Open`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const openTickers = (await openRes.json()).map(r => r.stock?.toUpperCase()).filter(Boolean);
    const allTickers  = [...new Set([...trackedTickers, ...openTickers])];

    if (!allTickers.length) return res.status(200).json({ ok: true, tickers: 0, rows: 0, reason: "no tracked tickers" });

    // ── Step 3: fetch OI for each ticker ────────────────────────────────────
    const token = await getValidToken();
    const results = await Promise.allSettled(allTickers.map(t => fetchChainOI(token, t)));

    const allRows = [];
    const errors  = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "fulfilled") allRows.push(...results[i].value);
      else errors.push({ ticker: allTickers[i], error: results[i].reason?.message });
    }

    if (!allRows.length) {
      return res.status(200).json({ ok: true, tickers: allTickers.length, rows: 0, errors });
    }

    // ── Step 4: upsert into oi_snapshots ────────────────────────────────────
    // Insert in batches of 500 to stay well under Supabase limits
    const BATCH = 500;
    let inserted = 0;
    for (let i = 0; i < allRows.length; i += BATCH) {
      const batch = allRows.slice(i, i + BATCH);
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/oi_snapshots`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=ignore-duplicates",
        },
        body: JSON.stringify(batch),
      });
      if (ins.ok) inserted += batch.length;
      else console.warn("[oi-tracker] batch insert failed:", await ins.text());
    }

    // ── Step 5: update col_prefs with last run info ──────────────────────────
    await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ id: "oi_tracked_tickers", cols: { tickers: trackedTickers, lastRun: today, tickersSnapshot: allTickers }, updated_at: new Date().toISOString() }),
    });

    res.status(200).json({ ok: true, tickers: allTickers.length, rows: inserted, errors, date: today });

  } catch (err) {
    console.error("[oi-tracker]", err.message);
    res.status(500).json({ error: err.message });
  }
}
