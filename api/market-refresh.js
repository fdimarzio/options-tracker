// api/market-refresh.js
// Cron job: runs every minute during market hours (9:30-16:00 ET Mon-Fri)
// - Fetches live quotes for all open contract tickers
// - Fetches option chains for open positions
// - Evaluates signals against OTM/DTE bands
// - Sends Pushover notifications for actionable signals
// - Saves last-refresh timestamp + quote data to Supabase for frontend to pick up

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SCHWAB_BASE  = "https://api.schwabapi.com";
const APP_URL      = "https://options-tracker-five.vercel.app";

// ── Market hours check (ET) ───────────────────────────────────────────────────
function isMarketHours() {
  const now = new Date();
  const et  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const h = et.getHours(), m = et.getMinutes();
  const mins = h * 60 + m;
  return mins >= 570 && mins < 960; // 9:30 to 16:00
}

// ── Schwab token helper ───────────────────────────────────────────────────────
async function getValidToken() {
  const res  = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_tokens`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const rows = await res.json();
  const t    = rows?.[0]?.cols;
  if (!t?.accessToken) throw new Error("No Schwab tokens");

  if (t.accessTokenExpiresAt > Date.now() + 120000) return t.accessToken;
  if (!t.refreshToken || t.refreshTokenExpiresAt < Date.now()) throw new Error("Refresh token expired");

  const creds      = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString("base64");
  const refreshRes = await fetch("https://api.schwabapi.com/v1/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken }),
  });
  const newT = await refreshRes.json();
  if (!newT.access_token) throw new Error("Token refresh failed");

  await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: "schwab_tokens", cols: { ...t, accessToken: newT.access_token, refreshToken: newT.refresh_token || t.refreshToken, accessTokenExpiresAt: Date.now() + (newT.expires_in * 1000), savedAt: new Date().toISOString() }, updated_at: new Date().toISOString() }),
  });
  return newT.access_token;
}

async function schwabGet(path, params = {}, token) {
  const qs  = Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`${SCHWAB_BASE}${path}${qs}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Schwab ${res.status} ${path}`);
  return res.json();
}

// ── Load open contracts from Supabase ─────────────────────────────────────────
async function loadOpenContracts() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/contracts?select=*&status=eq.Open&order=id.desc`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  return await res.json();
}

// ── Load OTM/DTE bands from Supabase ─────────────────────────────────────────
async function loadBands() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.dte_matrix`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  return rows?.[0]?.cols || {};
}

// ── Load already-sent notifications (prevent duplicates) ─────────────────────
async function loadSentToday() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.notifications_sent`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  const data = rows?.[0]?.cols || {};
  const today = new Date().toISOString().slice(0, 10);
  // Reset if stale (different day)
  if (data.date !== today) return { date: today, sent: [] };
  return data;
}

async function markSent(contractId, sentData) {
  const updated = { ...sentData, sent: [...sentData.sent, String(contractId)] };
  await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: "notifications_sent", cols: updated, updated_at: new Date().toISOString() }),
  });
  return updated;
}

// ── Get OTM/DTE band for a contract ──────────────────────────────────────────
function getContractBand(contract, bands, stockPrice) {
  if (!stockPrice || !contract.strike || !contract.expires) return null;
  const dte = Math.ceil((new Date(contract.expires) - new Date()) / 86400000);
  const strike = +contract.strike;
  const otmPct = contract.type === "Put"
    ? ((stockPrice - strike) / stockPrice) * 100
    : ((strike - stockPrice) / stockPrice) * 100;

  const dteBrackets = dte <= 7 ? "0-7" : dte <= 14 ? "8-14" : dte <= 21 ? "15-21" : dte <= 30 ? "22-30" : "31+";
  const otmBrackets = otmPct < 2 ? "0-2" : otmPct < 5 ? "2-5" : otmPct < 10 ? "5-10" : "10+";

  const band = bands?.[dteBrackets]?.[otmBrackets];
  if (!band) return null;

  const premPerShare = Math.abs(contract.premium) / ((contract.qty || 1) * 100);
  const tgtPct       = band.closeAt || 65;
  const targetPerShare = premPerShare * (1 - tgtPct / 100);
  return {
    tgtPct,
    targetClose: targetPerShare * 100 * (contract.qty || 1),
    band: `${dteBrackets} DTE / ${otmBrackets}% OTM`,
  };
}



// ── Send Pushover notification ────────────────────────────────────────────────
async function sendPushover(title, body, url, urlTitle, priority = 0) {
  const token = process.env.PUSHOVER_API_TOKEN;
  const user  = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return;

  await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token, user, title, message: body,
      priority, sound: priority >= 1 ? "cashregister" : "pushover",
      url: url || undefined, url_title: urlTitle || undefined,
    }),
  });
}

// ── Save refresh data to Supabase ────────────────────────────────────────────
// 1. last_market_refresh: for frontend polling (lightweight, just quotes + timestamp)
// 2. stocks_data: persisted across sessions so new browser loads see fresh prices
async function saveRefreshData(quotes, lastRefresh) {
  // Save to last_market_refresh for polling
  await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      id:   "last_market_refresh",
      cols: { quotes, lastRefresh },
      updated_at: new Date().toISOString(),
    }),
  });

  // Also merge into stocks_data so new sessions load fresh prices immediately
  const sdRes  = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.stocks_data`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const sdRows = await sdRes.json();
  const existing = sdRows?.[0]?.cols || {};

  const updated = { ...existing };
  for (const [ticker, q] of Object.entries(quotes)) {
    if (q.lastPrice != null) {
      updated[ticker] = {
        ...(updated[ticker] || {}),
        currentPrice: q.lastPrice,
        bid:          q.bid,
        ask:          q.ask,
        changeClose:  q.changeClose,
        changePct:    q.changePct,
        lastQuoteAt:  lastRefresh,
      };
    }
  }

  await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      id:   "stocks_data",
      cols: updated,
      updated_at: new Date().toISOString(),
    }),
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Allow manual trigger via GET (for testing) or cron
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const forceRun = req.query.force === "1";

  if (!forceRun && !isMarketHours()) {
    return res.status(200).json({ skipped: true, reason: "Outside market hours" });
  }

  try {
    const token    = await getValidToken();
    const contracts = await loadOpenContracts();
    const bands    = await loadBands();
    let sentData   = await loadSentToday();

    if (!contracts.length) {
      return res.status(200).json({ ok: true, contracts: 0 });
    }

    // Get unique tickers
    const tickers = [...new Set(contracts.map(c => c.stock?.toUpperCase()).filter(Boolean))];

    // Fetch live quotes
    const quoteData = await schwabGet("/marketdata/v1/quotes", {
      symbols:    tickers.join(","),
      fields:     "quote",
      indicative: false,
    }, token);

    // Normalize quotes
    const quotes = {};
    for (const [sym, entry] of Object.entries(quoteData || {})) {
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

    // Save quotes + timestamp to Supabase for frontend
    await saveRefreshData(quotes, new Date().toISOString());

    // Fetch option chains for all open positions and save to Supabase
    const chainData = {};
    const seen = new Set();
    for (const c of contracts) {
      if (!c.stock || !c.expires) continue;
      const key = c.stock.toUpperCase() + "|" + c.expires;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const data = await schwabGet("/marketdata/v1/chains", {
          symbol:       c.stock.toUpperCase(),
          contractType: "ALL",
          strikeCount:  30,
          fromDate:     c.expires,
          toDate:       c.expires,
        }, token);

        const calls = [], puts = [];
        for (const [, strikes] of Object.entries(data?.callExpDateMap || {}))
          for (const [, opts] of Object.entries(strikes))
            for (const o of opts) calls.push({ strikePrice: o.strikePrice, bid: o.bid, ask: o.ask, last: o.last, mark: o.mark, delta: o.delta, volatility: o.volatility, totalVolume: o.totalVolume, openInterest: o.openInterest });
        for (const [, strikes] of Object.entries(data?.putExpDateMap || {}))
          for (const [, opts] of Object.entries(strikes))
            for (const o of opts) puts.push({ strikePrice: o.strikePrice, bid: o.bid, ask: o.ask, last: o.last, mark: o.mark, delta: o.delta, volatility: o.volatility, totalVolume: o.totalVolume, openInterest: o.openInterest });

        chainData[key] = { calls, puts };
      } catch (e) {
        console.warn("[market-refresh] chain fetch failed for", key, e.message);
      }
    }

    // Save chain data to Supabase for frontend to load
    if (Object.keys(chainData).length > 0) {
      await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({
          id:   "last_chain_refresh",
          cols: { chains: chainData, lastRefresh: new Date().toISOString() },
          updated_at: new Date().toISOString(),
        }),
      });
    }

    // Evaluate signals
    const signals = [];
    for (const c of contracts) {
      if (!c.stock || !c.premium) continue;
      const stockPrice = quotes[c.stock.toUpperCase()]?.lastPrice;
      if (!stockPrice) continue;

      const bd   = getContractBand(c, bands, stockPrice);
      if (!bd)   continue;

      // Use chain data we already fetched
      const chainKey = c.stock.toUpperCase() + "|" + c.expires;
      const chain    = chainData[chainKey];
      const options  = c.type === "Put" ? chain?.puts : chain?.calls;
      const opt      = options?.find(o => Math.abs(o.strikePrice - +c.strike) < 0.01);
      const last     = opt?.mark ?? opt?.last ?? opt?.bid ?? null;
      if (last == null) continue;

      const mv      = (c.qty || 1) * last * 100;
      const prem    = Math.abs(c.premium);
      const gain    = c.optType === "BTO" ? mv - prem : prem - mv;
      const gainPct = prem > 0 ? (gain / prem) * 100 : 0;
      const tgtPct  = bd.tgtPct;
      const target  = bd.targetClose;

      // Skip if already notified today
      const alreadySent = sentData.sent.includes(String(c.id));

      let type = null;
      if (gainPct >= tgtPct && c.qty > 1) {
        const perC = prem / (c.qty || 1), gainPerU = gain / (c.qty || 1);
        const pq = gainPerU > 0 ? Math.ceil(perC / gainPerU) : null;
        type = pq && pq < c.qty ? "PARTIAL_CLOSE" : "TARGET_HIT";
      } else if (gainPct >= tgtPct) {
        type = "TARGET_HIT";
      } else if (gainPct >= tgtPct * 0.75) {
        type = "APPROACHING_TARGET";
      }

      if (type && !alreadySent) {
        signals.push({ contract: c, type, gainPct, gain, target, tgtPct, last });
      }
    }

    // Send notifications
    for (const s of signals) {
      const c         = s.contract;
      const label     = `${c.stock} ${c.expires} $${c.strike} ${c.type}`;
      const planUrl   = `${APP_URL}/?action=plan&ticker=${c.stock}`;
      const closeUrl  = `${APP_URL}/?action=close&id=${c.id}`;

      if (s.type === "TARGET_HIT") {
        await sendPushover(
          `CLOSE SIGNAL: ${label}`,
          `Gain +${s.gainPct.toFixed(1)}% ($${s.gain.toFixed(0)}) has hit your ${s.tgtPct}% target. Consider closing now.`,
          closeUrl, "→ Close in App", 1
        );
      } else if (s.type === "PARTIAL_CLOSE") {
        const perC = Math.abs(c.premium) / (c.qty || 1);
        const pq   = Math.ceil(perC / (s.gain / (c.qty || 1)));
        await sendPushover(
          `LOCK IN PROFIT: ${label}`,
          `Up ${s.gainPct.toFixed(0)}% — sell ${pq} of ${c.qty} contracts to recover cost basis.`,
          closeUrl, "→ Close in App", 1
        );
      } else if (s.type === "APPROACHING_TARGET") {
        await sendPushover(
          `APPROACHING TARGET: ${label}`,
          `Gain +${s.gainPct.toFixed(1)}% ($${s.gain.toFixed(0)}) — getting close to your ${s.tgtPct}% target.`,
          planUrl, "→ Open in App", 0
        );
      }

      sentData = await markSent(c.id, sentData);
    }

    res.status(200).json({
      ok:       true,
      time:     new Date().toISOString(),
      tickers:  tickers.length,
      signals:  signals.length,
      notified: signals.map(s => `${s.contract.stock} ${s.type}`),
    });

  } catch (err) {
    console.error("[market-refresh]", err.message);
    res.status(500).json({ error: err.message });
  }
}
