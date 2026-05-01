// api/market-refresh.js
// Lightweight background refresh — fetches stock quotes only (fast, under 5s)
// Called by GitHub Actions every minute during market hours

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SCHWAB_BASE  = "https://api.schwabapi.com";
const APP_URL      = "https://options-tracker-five.vercel.app";

function isMarketHours() {
  const et   = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day  = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960;
}

async function getValidToken() {
  const res  = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_tokens`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const rows = await res.json();
  const t    = rows?.[0]?.cols;
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

async function sendPushover(title, body, url, urlTitle, priority) {
  const token = process.env.PUSHOVER_API_TOKEN;
  const user  = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return;
  await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, user, title, message: body, priority: priority || 0, sound: priority >= 1 ? "cashregister" : "pushover", url, url_title: urlTitle }),
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const secret   = process.env.CRON_SECRET;
  const provided = req.headers["x-cron-secret"] || req.query.secret;
  if (secret && provided !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const forceRun = req.query.force === "1";
  if (!forceRun && !isMarketHours()) {
    return res.status(200).json({ skipped: true, reason: "Outside market hours" });
  }

  try {
    const token = await getValidToken();

    const cRes = await fetch(`${SUPABASE_URL}/rest/v1/contracts?select=id,stock,type,opt_type,strike,expires,premium,qty&status=eq.Open`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const contracts = await cRes.json();
    if (!contracts.length) return res.status(200).json({ ok: true, tickers: 0 });

    const tickers = [...new Set(contracts.map(c => c.stock?.toUpperCase()).filter(Boolean))];

    const qRes = await fetch(`${SCHWAB_BASE}/marketdata/v1/quotes?symbols=${tickers.join(",")}&fields=quote&indicative=false`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const qData = await qRes.json();

    const quotes = {};
    for (const [sym, entry] of Object.entries(qData || {})) {
      const q = entry?.quote ?? entry;
      if (!q) continue;
      quotes[sym.toUpperCase()] = {
        lastPrice:   q.lastPrice ?? q.mark ?? null,
        bid:         q.bidPrice  ?? null,
        ask:         q.askPrice  ?? null,
        changeClose: q.netChange ?? null,
        changePct:   q.netPercentChange != null ? q.netPercentChange / 100 : null,
      };
    }

    const lastRefresh = new Date().toISOString();

    await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ id: "last_market_refresh", cols: { quotes, lastRefresh }, updated_at: lastRefresh }),
    });

    const sdRes  = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.stocks_data`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const sdRows = await sdRes.json();
    const existing = sdRows?.[0]?.cols || {};
    const updated  = { ...existing };
    for (const [ticker, q] of Object.entries(quotes)) {
      if (q.lastPrice != null) {
        updated[ticker] = { ...(updated[ticker] || {}), currentPrice: q.lastPrice, bid: q.bid, ask: q.ask, changeClose: q.changeClose, changePct: q.changePct, lastQuoteAt: lastRefresh };
      }
    }
    await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ id: "stocks_data", cols: updated, updated_at: lastRefresh }),
    });

    const nRes   = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.notifications_sent`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const today  = lastRefresh.slice(0, 10);
    let sentData = (await nRes.json())?.[0]?.cols || {};
    if (sentData.date !== today) sentData = { date: today, sent: [] };

    const signals = [];
    for (const c of contracts) {
      if (!c.stock || !c.premium) continue;
      const stockPrice = quotes[c.stock.toUpperCase()]?.lastPrice;
      if (!stockPrice || !c.strike || !c.expires) continue;
      if (sentData.sent?.includes(String(c.id))) continue;
      const dte   = Math.ceil((new Date(c.expires) - new Date()) / 86400000);
      const isITM = c.type === "Put" ? stockPrice < +c.strike : stockPrice > +c.strike;
      if (isITM && dte <= 7) signals.push({ c, dte, stockPrice });
    }

    for (const s of signals) {
      const c = s.c;
      await sendPushover(
        `WARNING ITM: ${c.stock} ${c.expires} $${c.strike} ${c.type}`,
        `${c.type} is ITM with ${s.dte}d left. Stock $${s.stockPrice.toFixed(2)}, strike $${c.strike}.`,
        `${APP_URL}/?action=close&id=${c.id}`, "View in App", 1
      );
      sentData.sent.push(String(c.id));
    }

    if (signals.length) {
      await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id: "notifications_sent", cols: sentData, updated_at: lastRefresh }),
      });
    }

    res.status(200).json({ ok: true, time: lastRefresh, tickers: tickers.length, quotes: Object.keys(quotes).length, signals: signals.length });

  } catch (err) {
    console.error("[market-refresh]", err.message);
    res.status(500).json({ error: err.message });
  }
}
