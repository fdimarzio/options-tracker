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
const FMP_API_KEY  = process.env.FMP_API_KEY;
const PUSHOVER_API_TOKEN = process.env.PUSHOVER_API_TOKEN;
const PUSHOVER_USER_KEY  = process.env.PUSHOVER_USER_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}
if (!FMP_API_KEY) {
  console.error("Missing FMP_API_KEY");
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

// Returns { nextEarnings, prevEarnings } (either may be null) for a symbol from
// FMP's historical earnings calendar, which mixes past actuals and future estimates.
async function fetchEarningsForSymbol(symbol) {
  const url = `https://financialmodelingprep.com/api/v3/historical/earning_calendar/${encodeURIComponent(symbol)}?apikey=${FMP_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status} for ${symbol}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return { nextEarnings: null, prevEarnings: null };

  const today = new Date().toISOString().slice(0, 10);
  const future = rows.filter(r => r.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const past   = rows.filter(r => r.date <  today).sort((a, b) => b.date.localeCompare(a.date));
  return {
    nextEarnings: future[0]?.date ?? null,
    prevEarnings: past[0]?.date ?? null,
  };
}

async function upsertEarnings(symbol, nextEarnings, prevEarnings) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/earnings_dates?on_conflict=symbol`, {
    method: "POST",
    headers: { ...HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      symbol, next_earnings: nextEarnings, prev_earnings: prevEarnings,
      source: "fmp", updated_at: new Date().toISOString(),
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

async function main() {
  const symbols = await getActiveSymbols();
  console.log(`[earnings-refresh] refreshing ${symbols.length} active symbols: ${symbols.join(", ")}`);

  const earningsBySymbol = {};
  let updated = 0, failed = 0;
  for (const symbol of symbols) {
    try {
      const { nextEarnings, prevEarnings } = await fetchEarningsForSymbol(symbol);
      await upsertEarnings(symbol, nextEarnings, prevEarnings);
      earningsBySymbol[symbol] = nextEarnings;
      updated++;
    } catch (e) {
      console.warn(`[earnings-refresh] ${symbol} failed:`, e.message);
      failed++;
    }
  }
  console.log(`[earnings-refresh] done — ${updated} updated, ${failed} failed`);

  const straddling = await flagStraddlingShorts(earningsBySymbol);
  if (straddling.length) {
    console.log(`[earnings-refresh] ${straddling.length} open short(s) straddle an upcoming earnings date — Pushover sent`);
  }
}

main().catch(e => { console.error("[earnings-refresh] Fatal:", e.message); process.exit(1); });
