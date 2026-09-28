// scripts/earnings-refresh.js
// Nightly refresh of earnings_dates for every active symbol (open contracts +
// watchlist), via .github/workflows/earnings-refresh.yml. Feeds the earnings-date
// awareness guard in api/_lib/earningsGuard.js, used by the Skynet STO scanners
// in api/market-refresh.js so a short call isn't left open straddling an earnings
// surprise the way the AMZN position was.
//
// Provider: Financial Modeling Prep (FMP_API_KEY) — the in-app "catalyst" flow
// (ticker_catalysts, api/claude.js mode=catalyst_fetch) is LLM-generated and
// explicitly "approximate if uncertain," not reliable enough to gate automated
// STO candidate generation, so this uses a real data provider instead.
//
// Run manually: node --env-file=.env.local scripts/earnings-refresh.js

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const PUSHOVER_API_TOKEN = process.env.PUSHOVER_API_TOKEN;
const PUSHOVER_USER_KEY  = process.env.PUSHOVER_USER_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}
if (!FINNHUB_API_KEY) {
  console.error("Missing FINNHUB_API_KEY");
  process.exit(1);
}

const HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };

async function getActiveSymbols() {
  const [contractsRes, watchlistRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/contracts?select=stock&status=eq.Open`, { headers: HEADERS }),
    fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.watchlist`, { headers: HEADERS }),
  ]);
  const contracts = await contractsRes.json();
  const watchlist = (await watchlistRes.json())?.[0]?.cols?.tickers || [];
  const symbols = new Set([
    ...(Array.isArray(contracts) ? contracts.map(c => c.stock?.toUpperCase()) : []),
    ...watchlist.map(t => t.toUpperCase()),
  ].filter(Boolean));
  return [...symbols];
}

// Finnhub's free bulk (all-companies) calendar returns an incomplete set, so query it
// per-symbol — ~12 tiny calls, well under the 60/min free limit. One symbol's failure is
// logged and skipped, not fatal; the 0-updated guard in main() still fails the run loud
// if every symbol fails (e.g. bad key).
async function fetchEarningsCalendar(symbols) {
  const now  = Date.now();
  const from = new Date(now - 120 * 86400000).toISOString().slice(0, 10);
  const to   = new Date(now + 180 * 86400000).toISOString().slice(0, 10);
  const bySymbol = new Map();
  for (const symbol of symbols) {
    try {
      const url = `https://finnhub.io/api/v1/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${FINNHUB_API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) { console.warn(`[earnings-refresh] ${symbol}: Finnhub HTTP ${res.status} ${(await res.text()).slice(0,100)}`); continue; }
      const data = await res.json();
      const rows = Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : [];
      for (const r of rows) {
        if (!r || !r.symbol || !r.date) continue;
        const s = String(r.symbol).toUpperCase();
        if (!bySymbol.has(s)) bySymbol.set(s, []);
        bySymbol.get(s).push(r.date);
      }
    } catch (e) {
      console.warn(`[earnings-refresh] ${symbol}: Finnhub error ${e.message}`);
    }
  }
  return bySymbol;
}

// From one symbol's earnings dates, pick the next upcoming and the most recent past.
function pickEarnings(dates) {
  const today  = new Date().toISOString().slice(0, 10);
  const sorted = [...new Set(dates)].sort();
  const future = sorted.filter(d => d >= today);
  const past   = sorted.filter(d => d <  today);
  return { nextEarnings: future[0] ?? null, prevEarnings: past[past.length - 1] ?? null };
}

async function upsertEarnings(symbol, nextEarnings, prevEarnings) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/earnings_dates?on_conflict=symbol`, {
    method: "POST",
    headers: { ...HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      symbol, next_earnings: nextEarnings, prev_earnings: prevEarnings,
      source: "finnhub", updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`earnings_dates upsert failed for ${symbol}: ${res.status} ${await res.text()}`);
}

async function notify(title, message) {
  if (!PUSHOVER_API_TOKEN || !PUSHOVER_USER_KEY) return;
  await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: PUSHOVER_API_TOKEN, user: PUSHOVER_USER_KEY, title, message }),
  }).catch(() => {});
}

// Optional BTC-side check: flag open short (STO) positions whose expiry now
// straddles an upcoming earnings date, for manual review — this script doesn't
// close or modify anything, only alerts.
async function flagStraddlingShorts(earningsBySymbol) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/contracts?select=id,stock,strike,type,expires,account&status=eq.Open&opt_type=eq.STO`,
    { headers: HEADERS }
  );
  const openShorts = await res.json();
  if (!Array.isArray(openShorts)) return [];

  const today = new Date().toISOString().slice(0, 10);
  const straddling = openShorts.filter(c => {
    const nextEarnings = earningsBySymbol[c.stock?.toUpperCase()];
    if (!nextEarnings) return false;
    return nextEarnings >= today && nextEarnings <= c.expires;
  });

  if (straddling.length) {
    const lines = straddling.map(c => `${c.stock} $${c.strike} ${c.type} ${c.expires} (${c.account}) — earnings ${earningsBySymbol[c.stock.toUpperCase()]}`);
    await notify("⚠️ Open shorts straddling earnings", lines.join("\n"));
  }
  return straddling;
}

// Heads-up alert: any active symbol whose next earnings is within 10 days, so Frank can
// be careful when trading manually around it. Fires once per earnings event, deduped in
// col_prefs row `earnings_prealert` ({ SYMBOL: earnings_date_already_alerted }).
async function flagUpcomingEarnings(earningsBySymbol) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const horizon  = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const pref = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.earnings_prealert`, { headers: HEADERS })
    .then(r => r.json()).catch(() => []);
  const alerted = (pref && pref[0] && pref[0].cols) || {};
  const due = [];
  for (const [symbol, next] of Object.entries(earningsBySymbol)) {
    if (!next) continue;
    if (next >= todayStr && next <= horizon && alerted[symbol] !== next) {
      due.push({ symbol, next });
      alerted[symbol] = next;
    }
  }
  if (due.length) {
    due.sort((a, b) => a.next.localeCompare(b.next));
    const lines = due.map(d => `${d.symbol} — ${d.next}`);
    await notify("📅 Earnings within 10 days", `Be careful trading around these:\n${lines.join("\n")}`);
    await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
      method: "POST",
      headers: { ...HEADERS, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ id: "earnings_prealert", cols: alerted, updated_at: new Date().toISOString() }),
    }).catch(() => {});
  }
  return due;
}

async function main() {
  const symbols = await getActiveSymbols();
  console.log(`[earnings-refresh] refreshing ${symbols.length} active symbols: ${symbols.join(", ")}`);

  let calendar;
  try {
    calendar = await fetchEarningsCalendar(symbols);
    console.log(`[earnings-refresh] Finnhub returned earnings for ${calendar.size} of ${symbols.length} symbols`);
  } catch (e) {
    console.error(`[earnings-refresh] FATAL: earnings-calendar fetch failed — ${e.message}`);
    await notify("❌ earnings-refresh failed", `Finnhub earnings-calendar error: ${e.message}. earnings_dates NOT updated.`);
    process.exit(1);
  }

  const earningsBySymbol = {};
  let updated = 0, failed = 0, notInCalendar = 0;
  for (const symbol of symbols) {
    try {
      const dates = calendar.get(symbol) || [];
      if (!dates.length) {
        notInCalendar++;
        earningsBySymbol[symbol] = null;
        console.warn(`[earnings-refresh] ${symbol}: no earnings in calendar window`);
        continue;
      }
      const { nextEarnings, prevEarnings } = pickEarnings(dates);
      await upsertEarnings(symbol, nextEarnings, prevEarnings);
      earningsBySymbol[symbol] = nextEarnings;
      updated++;
    } catch (e) {
      console.warn(`[earnings-refresh] ${symbol} failed:`, e.message);
      failed++;
    }
  }
  console.log(`[earnings-refresh] done — ${updated} updated, ${notInCalendar} not-in-calendar, ${failed} failed`);

  if (symbols.length > 0 && updated === 0) {
    await notify("❌ earnings-refresh wrote nothing", `0/${symbols.length} updated (${notInCalendar} not in calendar, ${failed} errored) — Finnhub returned nothing / provider issue. earnings_dates NOT updated.`);
    console.error(`[earnings-refresh] FATAL: 0 of ${symbols.length} symbols updated — failing the run so it is visible`);
    process.exit(1);
  }

  const straddling = await flagStraddlingShorts(earningsBySymbol);
  if (straddling.length) {
    console.log(`[earnings-refresh] ${straddling.length} open short(s) straddle an upcoming earnings date — Pushover sent`);
  }

  const upcoming = await flagUpcomingEarnings(earningsBySymbol);
  if (upcoming.length) {
    console.log(`[earnings-refresh] ${upcoming.length} symbol(s) with earnings within 10 days — Pushover sent`);
  }
}

main().catch(e => { console.error("[earnings-refresh] Fatal:", e.message); process.exit(1); });
