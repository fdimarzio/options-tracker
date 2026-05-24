// backtest_v2.js
// Expanded backtest — 52 tickers (your holdings + top S&P 500 options volume names)
// Pulls 6 months of daily price history from Schwab, simulates covered call outcomes,
// outputs backtest_results_v2.csv for analysis.
//
// Usage:
//   node backtest.js
//
// Output: backtest_results.csv

import fs from "fs";

// ── Load .env.backtest ────────────────────────────────────────────────────────
try {
  const lines = fs.readFileSync(".env.backtest", "utf8").split("\n");
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (k && !process.env[k]) process.env[k] = v;
  }
  console.log("Loaded .env.backtest");
} catch(e) { console.warn("No .env.backtest found — falling back to existing env vars"); }
import https from "https";

// ── Config ────────────────────────────────────────────────────────────────────

// Full expanded ticker list — your existing holdings + top S&P 500 options volume names
const TICKERS = [
  // Your existing holdings
  "AAPL","AMZN","AMD","CAT","CEG","COST","GOOG","GOOGL","JPM","LMT","MSFT","NFLX","NVDA","OKLO","TKO","UPS","WDC",
  // Top S&P 500 by options volume (new)
  "TSLA","META","BAC","GS","WFC","C","MS","BX","PLTR","SMCI",
  "INTC","CSCO","MU","ORCL","CRM","XOM","CVX","OXY","SLB","HAL",
  "PFE","MRNA","JNJ","ABBV","LLY","UBER","F","GM","T","VZ",
  "DIS","BA","GE","V","AVGO"
];
const SCHWAB_BASE   = "https://api.schwabapi.com";
const SUPABASE_URL  = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY  = process.env.VITE_SUPABASE_ANON_KEY;
const OTM_PCT       = 0.025; // 2.5% OTM strike
const SCORE_THRESHOLD = 65;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`JSON parse failed for ${url}: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// ── Schwab token ──────────────────────────────────────────────────────────────

async function getToken() {
  const url = `${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_tokens`;
  const data = await fetchJSON(url, { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` });
  const t = data?.[0]?.cols;
  if (!t?.accessToken) throw new Error("No Schwab token in Supabase — ensure app is authorized");

  if (t.accessTokenExpiresAt > Date.now() + 120000) return t.accessToken;

  // Refresh
  console.log("Access token expired, refreshing...");
  const creds = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString("base64");
  const body  = new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken }).toString();

  const newTokens = await new Promise((resolve, reject) => {
    const req = https.request("https://api.schwabapi.com/v1/oauth/token", {
      method: "POST",
      headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  if (!newTokens.access_token) throw new Error("Token refresh failed: " + JSON.stringify(newTokens));
  return newTokens.access_token;
}

// ── Price history ─────────────────────────────────────────────────────────────

async function fetchCandles(token, symbol) {
  const url = `${SCHWAB_BASE}/marketdata/v1/pricehistory?symbol=${encodeURIComponent(symbol)}&periodType=month&period=6&frequencyType=daily&frequency=1&needExtendedHoursData=false`;
  const data = await fetchJSON(url, { Authorization: `Bearer ${token}`, Accept: "application/json" });
  if (!data?.candles?.length) return [];
  return data.candles.map(c => ({
    date:   new Date(c.datetime).toISOString().slice(0, 10),
    open:   c.open,
    high:   c.high,
    low:    c.low,
    close:  c.close,
    volume: c.totalVolume ?? c.volume ?? 0,
  })).sort((a, b) => a.date.localeCompare(b.date));
}

// ── Factor computation (mirrors market-refresh.js) ────────────────────────────

function computeRSI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const closes = candles.map(c => c.close);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }
  let avgGain = gains  / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return Math.round((100 - 100 / (1 + avgGain / avgLoss)) * 100) / 100;
}

function computeBollingerBands(candles, period = 20) {
  if (!candles || candles.length < period) return null;
  const recent  = candles.slice(-period);
  const closes  = recent.map(c => c.close);
  const sma     = closes.reduce((s, v) => s + v, 0) / period;
  const variance= closes.reduce((s, v) => s + Math.pow(v - sma, 2), 0) / period;
  const stdDev  = Math.sqrt(variance);
  const upper   = sma + 2 * stdDev;
  const lower   = sma - 2 * stdDev;
  const cur     = candles[candles.length - 1].close;
  const bbPctB  = stdDev === 0 ? 0.5 : (cur - lower) / (upper - lower);
  const bbPos   = stdDev === 0 ? 0 : cur >= upper - stdDev * 0.2 ? 1 : cur <= lower + stdDev * 0.2 ? -1 : 0;
  return { bb_pct_b: Math.round(bbPctB * 1000) / 1000, bb_position: bbPos };
}

function computeFibFactors(candles, stockPrice, lookback = 60) {
  if (!candles || candles.length < 10 || !stockPrice) return null;
  const window    = candles.slice(-Math.min(lookback, candles.length));
  const swingHigh = Math.max(...window.map(c => c.high));
  const swingLow  = Math.min(...window.map(c => c.low));
  const range     = swingHigh - swingLow;
  if (range <= 0) return null;
  const levels = [0.236, 0.382, 0.5, 0.618, 0.786].map(pct => ({ pct, price: swingHigh - pct * range }));
  let nearest = null, nearestDist = Infinity;
  for (const lvl of levels) {
    const dist = Math.abs(stockPrice - lvl.price) / stockPrice * 100;
    if (dist < nearestDist) { nearestDist = dist; nearest = lvl; }
  }
  const prevClose  = candles[candles.length - 2]?.close;
  const brokeBelow = nearest && prevClose > nearest.price && stockPrice < nearest.price;
  return {
    fib_broke_below:     brokeBelow ? 1 : 0,
    fib_near_resistance: (nearest?.pct <= 0.382 && nearestDist < 1.5) ? 1 : 0,
    fib_near_support:    (nearest?.pct >= 0.618 && nearestDist < 1.5) ? 1 : 0,
  };
}

function computeGapFlag(candles, threshold = 0.5) {
  if (!candles || candles.length < 2) return null;
  const today = candles[candles.length - 1];
  const prev  = candles[candles.length - 2];
  const gapPct = (today.open - prev.close) / prev.close * 100;
  return { gap_flag: Math.abs(gapPct) >= threshold ? 1 : 0, gap_pct: Math.round(gapPct * 100) / 100 };
}

// ── Black-Scholes call option pricing ────────────────────────────────────────
// Returns estimated call premium given stock price, strike, DTE, vol, risk-free rate
function blackScholesCall(S, K, T, sigma, r = 0.05) {
  if (T <= 0 || sigma <= 0) return 0;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return S * normalCDF(d1) - K * Math.exp(-r * T) * normalCDF(d2);
}

// Standard normal CDF approximation (Abramowitz & Stegun)
function normalCDF(x) {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t*Math.exp(-x*x);
  return 0.5 * (1.0 + sign * y);
}

// Compute 20-day historical volatility (annualized) from candles
function computeHV20(candles) {
  if (!candles || candles.length < 22) return null;
  const recent = candles.slice(-21);
  const logReturns = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i-1].close > 0) logReturns.push(Math.log(recent[i].close / recent[i-1].close));
  }
  if (logReturns.length < 2) return null;
  const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
  const variance = logReturns.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (logReturns.length - 1);
  return Math.sqrt(variance * 252); // annualized
}

// ── Expiry selection: next Mon/Wed/Fri from a given date ─────────────────────

function nextExpiry(fromDate) {
  const d   = new Date(fromDate + "T12:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  // MWF = 1, 3, 5
  const mwf = [1, 3, 5];
  for (let i = 1; i <= 7; i++) {
    const next = (dow + i) % 7;
    if (mwf.includes(next)) {
      const result = new Date(d);
      result.setUTCDate(d.getUTCDate() + i);
      return result.toISOString().slice(0, 10);
    }
  }
  return null;
}

// ── Scoring (mirrors claude.js scoreFactors) ──────────────────────────────────
// Weights match scoring_factors table as of today

const WEIGHTS = {
  iv_rank:            9,
  vix:                7,
  iv_percentile:      6,
  rsi_14:             6,
  change_pct:         5,
  iv_pct:             5,
  ticker_win_rate:    5,
  fib_near_resistance:4,
  fib_broke_below:    4,
  sr_near_resistance: 4,
  pullback_from_high: 4,
  deceleration:       4,
  otm_pct:            3,
  bb_pct_b:           3,
  gap_flag:           2,
  fib_near_support:  -5,
  sr_near_support:   -4,
};

function scoreFactors(f) {
  let rawScore = 0, maxPossible = 0;
  const contribs = {};
  const add = (key, normalized) => {
    const w = WEIGHTS[key];
    if (w == null) return;
    const contrib = Math.max(normalized, 0) * Math.abs(w) * Math.sign(w);
    rawScore    += contrib;
    maxPossible += Math.abs(w);
    contribs[key] = +(contrib.toFixed(3));
  };

  // We don't have live IV rank in backtest — skip iv_rank, iv_percentile, iv_pct, sr_*, ticker_win_rate, pullback, decel
  // Those need intraday or options data we don't have historically
  // Focus on what daily candles give us: rsi, change_pct, fib, bb, gap, otm_pct
  if (f.rsi_14     != null) { const r = f.rsi_14; add("rsi_14", Math.max(r < 40 ? (40-r)/40 : r > 70 ? -((r-70)/30) : 0.3, 0)); }
  if (f.change_pct != null) { const cp = f.change_pct; add("change_pct", cp >= 0.5 ? Math.min(cp / 3, 1) : 0); }
  if (f.fib_near_resistance === 1) add("fib_near_resistance", 1);
  if (f.fib_broke_below     === 1) add("fib_broke_below", 1);
  if (f.fib_near_support    === 1) add("fib_near_support", 1);
  if (f.bb_pct_b != null) add("bb_pct_b", Math.max(1 - f.bb_pct_b, 0));
  if (f.gap_flag  === 1)  add("gap_flag", 1);
  if (f.otm_pct   != null) add("otm_pct", Math.min(f.otm_pct / 5, 1));

  // Gates
  const gatesFail = (f.bb_position ?? 0) > 0 || (f.change_pct ?? 0) < 0.5;

  const score = maxPossible > 0 ? Math.round(Math.max(0, rawScore) / maxPossible * 100) : 0;
  return { score, gatesFail, contribs };
}

// ── Main backtest loop ────────────────────────────────────────────────────────

async function run() {
  console.log("=== SAGE Backtest v2 — 52 tickers ===");
  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log("Fetching Schwab token...");

  const token = await getToken();
  console.log("Token OK\n");

  const rows = [];

  for (const ticker of TICKERS) {
    process.stdout.write(`Fetching ${ticker}...`);
    let candles;
    try {
      candles = await fetchCandles(token, ticker);
    } catch(e) {
      console.log(` FAILED: ${e.message}`);
      continue;
    }
    console.log(` ${candles.length} days`);

    if (candles.length < 30) { console.log(`  Skipping — not enough data`); continue; }

    // For each trading day (except last 7 — need future prices for outcome)
    for (let i = 20; i < candles.length - 7; i++) {
      const day      = candles[i];
      const prevDay  = candles[i - 1];
      const candlesUpToToday = candles.slice(0, i + 1);

      // Factors from daily candles
      const changePct = prevDay.close > 0 ? (day.close - prevDay.close) / prevDay.close * 100 : 0;
      const rsi       = computeRSI(candlesUpToToday);
      const bb        = computeBollingerBands(candlesUpToToday);
      const fib       = computeFibFactors(candlesUpToToday, day.close);
      const gap       = computeGapFlag(candlesUpToToday);
      // Round strike to realistic option increment based on price level
      const rawStrike = day.close * (1 + OTM_PCT);
      const increment = rawStrike < 25 ? 0.5 : rawStrike < 200 ? 1.0 : rawStrike < 500 ? 2.5 : 5.0;
      const strike    = Math.round(rawStrike / increment) * increment;
      const otmPct    = (strike - day.close) / day.close * 100;
      const expiry    = nextExpiry(day.date);
      const dte       = expiry ? Math.round((new Date(expiry) - new Date(day.date)) / 86400000) : null;

      // Find expiry candle
      const expiryCandle = candles.find(c => c.date === expiry);
      if (!expiry || !expiryCandle) continue;

      // Outcome: did the stock stay below strike at expiry? (call expires worthless = win)
      const expiredWorthless = expiryCandle.close < strike ? 1 : 0;
      const pnlPct = expiredWorthless
        ? null  // premium kept — would need options chain data for exact amount
        : Math.round((expiryCandle.close - strike) / strike * 100 * 100) / 100; // how far ITM

      const factors = {
        rsi_14:             rsi,
        change_pct:         Math.round(changePct * 1000) / 1000,
        otm_pct:            Math.round(otmPct * 100) / 100,
        bb_pct_b:           bb?.bb_pct_b ?? null,
        bb_position:        bb?.bb_position ?? null,
        fib_near_resistance:fib?.fib_near_resistance ?? null,
        fib_near_support:   fib?.fib_near_support    ?? null,
        fib_broke_below:    fib?.fib_broke_below     ?? null,
        gap_flag:           gap?.gap_flag             ?? null,
      };

      const { score, gatesFail, contribs } = scoreFactors(factors);

      // ── Premium estimate via Black-Scholes ──────────────────────────────────
      const hv20      = computeHV20(candlesUpToToday);
      const T         = dte / 365; // time to expiry in years
      const estPremium= hv20 && T > 0 ? Math.round(blackScholesCall(day.close, strike, T, hv20) * 100) / 100 : null;
      const premiumPct= estPremium && day.close > 0 ? Math.round(estPremium / day.close * 10000) / 100 : null;
      // Annualized yield = (premium / stock price) * (365 / dte)
      const annualYield = estPremium && dte > 0 ? Math.round(estPremium / day.close * (365 / dte) * 10000) / 100 : null;

      rows.push({
        ticker,
        date:               day.date,
        close:              day.close,
        strike,
        expiry,
        expiry_close:       expiryCandle.close,
        dte,
        otm_pct:            factors.otm_pct,
        expired_worthless:  expiredWorthless,
        itm_pct:            expiredWorthless ? 0 : pnlPct,
        hv_20:              hv20 ? Math.round(hv20 * 1000) / 10 : null,
        est_premium:        estPremium,
        premium_pct:        premiumPct,
        annual_yield:       annualYield,
        score,
        gates_fail:         gatesFail ? 1 : 0,
        passes_threshold:   (!gatesFail && score >= SCORE_THRESHOLD) ? 1 : 0,
        rsi_14:             factors.rsi_14,
        change_pct:         factors.change_pct,
        bb_pct_b:           factors.bb_pct_b,
        bb_position:        factors.bb_position,
        fib_near_resistance:factors.fib_near_resistance,
        fib_near_support:   factors.fib_near_support,
        fib_broke_below:    factors.fib_broke_below,
        gap_flag:           factors.gap_flag,
        contrib_rsi:        contribs.rsi_14         ?? 0,
        contrib_change_pct: contribs.change_pct     ?? 0,
        contrib_bb:         contribs.bb_pct_b       ?? 0,
        contrib_fib_res:    contribs.fib_near_resistance ?? 0,
        contrib_fib_sup:    contribs.fib_near_support    ?? 0,
        contrib_fib_broke:  contribs.fib_broke_below     ?? 0,
        contrib_gap:        contribs.gap_flag        ?? 0,
        contrib_otm:        contribs.otm_pct         ?? 0,
      });
    }

    console.log(`  ${rows.filter(r => r.ticker === ticker).length} simulated trades`);
  }

  // ── Write CSV ───────────────────────────────────────────────────────────────
  if (!rows.length) { console.log("No rows generated — check token and tickers"); return; }

  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(","),
    ...rows.map(r => headers.map(h => {
      const v = r[h];
      if (v === null || v === undefined) return "";
      if (typeof v === "string" && v.includes(",")) return `"${v}"`;
      return v;
    }).join(","))
  ].join("\n");

  fs.writeFileSync("backtest_results_v2.csv", csv);
  console.log(`\n✓ Written backtest_results_v2.csv — ${rows.length} total rows`);

  // ── Quick summary ────────────────────────────────────────────────────────────
  const total        = rows.length;
  const wins         = rows.filter(r => r.expired_worthless === 1).length;
  const highScore    = rows.filter(r => r.passes_threshold === 1);
  const highScoreWins= highScore.filter(r => r.expired_worthless === 1).length;
  const lowScore     = rows.filter(r => r.passes_threshold === 0);
  const lowScoreWins = lowScore.filter(r => r.expired_worthless === 1).length;

  console.log("\n=== Quick Summary ===");
  console.log(`Total simulated trades:      ${total}`);
  console.log(`Overall win rate:            ${(wins/total*100).toFixed(1)}%`);
  console.log(`High score (≥${SCORE_THRESHOLD}) trades:    ${highScore.length} → win rate ${highScore.length ? (highScoreWins/highScore.length*100).toFixed(1) : "n/a"}%`);
  console.log(`Low score (<${SCORE_THRESHOLD}) trades:     ${lowScore.length}  → win rate ${lowScore.length  ? (lowScoreWins/lowScore.length*100).toFixed(1)  : "n/a"}%`);
  console.log("\nUpload backtest_results_v2.csv to Claude for full analysis.");
}

run().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
