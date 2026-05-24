# PRI Options Tracker — Session Summary
**Date:** May 17-18, 2026  
**Handoff document for next Claude chat session**

---

## Project Overview

**App:** PRI Options Tracker — React/Vite + Supabase + Vercel  
**Main file:** `src/pri-tod-v3.jsx`  
**Deployed:** `https://options-tracker-five.vercel.app`  
**12 Vercel serverless functions** (at limit)  
**Key API files:** `api/claude.js`, `api/market-refresh.js`, `api/auto-import.js`, `api/schwab-orders.js`, `api/schwab-proxy.js`

**Second project:** Standalone options chain viewer at `C:\Users\fmdim\options-chain` using `src/OptionsChain.jsx`

**Supabase URL:** `https://ufagnokxmetushstgrip.supabase.co`  
**Cron/auth secret:** `CronSecret2026!`  
**ETrade re-auth:** `https://options-tracker-five.vercel.app/api/etrade?action=auth&secret=CronSecret2026!`  
**Schwab re-auth:** `https://options-tracker-five.vercel.app/api/schwab-auth`

---

## SAGE Scoring Model — Architecture Decisions

**Name:** SAGE — named after a mentor who gave the user their career start (not an acronym)

**Architecture decision:** Gating + weighted sum  
- Hard gates first (ticker_win_rate ≥ 70%, otm_pct ≥ 15%, dte 21-45, vix ≥ 18)
- Weighted scoring on what passes gates
- Trade threshold: ≥ 65/100

**Status:** NOT YET IMPLEMENTED — data collection phase only. Need more signals with new factors before scoring means anything.

**Key insight from Nick Homira (experienced trader):**
- IV > 100% = good premium environment
- RSI, CCI, Stochastic as buy/sell indicators
- Gap fills — gaps fill 80% of the time (gap flag useful)
- Role reversals / Support & Resistance
- Fibonacci retracements
- Bollinger Bands

**Ticker as factor — NOT recommended.** Ticker win rate is a proxy for IV regime, not ticker identity. OKLO's 86% win rate is because it's high-IV, not because it's OKLO. Better: `iv_pct`, `iv_rank`, `iv_percentile`.

**Fibonacci STO logic (corrected):**
- Broke below a Fib level → stock falling → **favorable for STO** (call stays OTM)
- Near resistance → stock capped → **favorable for STO**
- Near support from above → stock may bounce and run up → **suppress STO** (call goes ITM)
- Fibonacci + RSI oversold + gap fill = **BTO signal** (future feature)

---

## Factor Infrastructure — Complete

### Factors captured in `scoring_factor_values` (18 total):

| Factor | Source | Notes |
|--------|--------|-------|
| `change_pct` | market-refresh | Stock move % at signal time |
| `vix` | market-refresh | Market volatility |
| `dte` | market-refresh | Days to expiry |
| `otm_pct` | market-refresh | How far OTM the strike is |
| `pullback_from_high` | market-refresh | Momentum indicator |
| `deceleration` | market-refresh | Momentum slowing |
| `time_of_day` | market-refresh | Minutes since midnight ET |
| `rsi_14` | market-refresh | Wilder RSI-14 from daily candles |
| `iv_pct` | market-refresh | ATM IV from chain data (decimal→%, e.g. 85.0) |
| `fib_proximity_pct` | market-refresh | Distance to nearest Fib level |
| `fib_level` | market-refresh | Which Fib level (0.236, 0.382, 0.5, 0.618, 0.786) |
| `fib_broke_below` | market-refresh | 1 if price broke below a level |
| `fib_near_resistance` | market-refresh | 1 if near upper Fib level (≤38.2%) within 1.5% |
| `fib_near_support` | market-refresh | 1 if near lower Fib level (≥61.8%) within 1.5% |
| `bb_pct_b` | market-refresh | %B (0=lower band, 0.5=mid, 1=upper) |
| `bb_width` | market-refresh | Band width as % of SMA |
| `bb_position` | market-refresh | -1/0/1 (lower/mid/upper band) |
| `gap_pct` | market-refresh | Gap size and direction % |
| `gap_flag` | market-refresh | 1 if gap > 0.5% threshold |
| `gap_direction` | market-refresh | 1=gap up, -1=gap down, 0=no gap |

### Key implementation details:
- Daily candles fetched via `fetchPriceHistories(token, symbols)` — 3 months of daily OHLCV from Schwab at each market-refresh run
- IV extracted from already-loaded chain data (no extra API call) via `getAtmIv(chainData, symbol, stockPrice)`
- All factors written on both pushed AND momentum-suppressed signals
- `bb_position` has stdDev=0 guard: returns 0 for flat candles

---

## UI Features Added

### SAGE Explorer Tab (burger menu → ◈ SAGE Explorer)
- Metric cards: total STO trades, win rate, avg profit, avg premium, tickers
- Win rate by ticker horizontal bar chart (Chart.js, STO only, ≥3 trades)
- Profit % distribution histogram
- Win rate by days held bar chart
- Per-ticker summary table
- **NEW: Factor coverage table** — shows count/avg/median/min/max for every captured factor with coverage bars
- "◈ recommend factor weights" button → calls Claude API (response parsing fixed to extract `content[0].text`)
- Fetches both contract data AND `scoring_factor_values` from Supabase on load

### Signal Log Tab
- **NEW: Factor panel on row expand** — when you click "log" on any STO signal, fetches `scoring_factor_values` for that signal and shows color-coded factor strip
  - RSI > 70 = red (overbought), RSI < 30 = green (oversold)
  - IV% > 80 = green (good premium), IV% > 50 = yellow
  - %B > 0.8 = red (near upper band), %B < 0.2 = green (near lower)
  - Gap flag = yellow if present
  - Fib level shown in purple
- Older signals (pre-factor-capture) show "no factor data for this signal"

### Options Chain (Plan tab + StocksChainSection)
- `FibPanel` component — collapsible, shows above strike rows when expiry expanded
  - Collapsed: shows nearest Fib level badge + STO signal quality
  - Expanded: stock candlestick chart (3-month daily) with Fib levels overlaid as colored horizontal lines
- `StockChartWithFib` — combined chart, Fib levels drawn directly on candles using `addLineSeries`
- Inline option chart (📈 button) — splits table at clicked strike, chart renders outside `<table>` to avoid canvas clipping
- Contract calculator with Qty stepper
- `lightweight-charts` now imported from npm (not CDN) — fixes Edge tracking prevention blocking

---

## Test Suite

**Location:** `C:\Users\fmdim\options-tracker\tests\`  
**Runner:** Vitest (`npx vitest run`)  
**Config:** `vitest.config.js` with `include: ["tests/**/*.test.js"]`

| File | Tests | Coverage |
|------|-------|---------|
| `utils.test.js` | 130 | Existing utils |
| `sage_factors.test.js` | 21 | `computeRSI`, `getAtmIv` |
| `fib_factors.test.js` | 15 | `computeFibFactors` |
| `bb_gap.test.js` | 22 | `computeBollingerBands`, `computeGapFlag` |

All 188 tests passing as of last run.

---

## Pending / Tomorrow's Priorities

### 1. Data Quality Check (first thing)
Deploy `market-refresh.js`, let signals fire, check SAGE factor coverage table to confirm all 18 factors populating. Gates everything else.

### 2. S/R Auto-Detection (1 session)
Daily candles already fetched — detect swing highs/lows algorithmically (prior bounces, clusters of price touches), store in `support_resistance` Supabase table, add `near_sr_level` as factor. Nick called this out specifically.

### 3. IV Rank / IV Percentile (1 session)
Raw `iv_pct` captured but IV Rank (where IV sits vs 52-week range) is more meaningful. Needs 52-week price history from Schwab. Add `iv_rank` and `iv_percentile` as factors.

### 4. SAGE Scoring Model — First Pass (1-2 sessions)
Once data quality confirmed, implement 0-100 score using gate + weighted sum:
- Gates: `otm_pct ≥ 15%`, `dte` between 21-45, `vix ≥ 18`, `bb_position ≠ 1` (not overbought)
- Weighted factors: `iv_pct` (9), `dte` (8), `vix` (7), `change_pct` (5), `rsi_14` (implied oversold/overbought)
- Write score back to `signal_log.sage_score` column
- Display in Signal Log and SAGE tab

### 5. BTO Signal Framework
Fib support bounce + RSI oversold + gap fill = natural BTO signals. Natural next scanner alongside STO.

### 6. CCI + Stochastic
Nick mentioned these alongside RSI. Computable from daily candles already being fetched.

---

## Other Outstanding Items (from earlier sessions)

- Wire `sharesByAcct` format in stocksData for Auto-STO scanner
- Re-sell notification after expiry close
- Confirm OI tracker cron is running
- `ticker_win_rate` and `days_since_last_sto` computed factors via SQL queries
- Confirm `signal_rules` table has: `min_dte`, `max_dte`, `min_otm_pct`, `max_otm_pct`, `min_premium`

---

## Files Delivered This Session

- `api/market-refresh.js` — full factor capture (RSI, IV, Fib, BB, Gap)
- `src/pri-tod-v3.jsx` — SAGE tab + Signal Log factor panel + options chain improvements
- `src/OptionsChain.jsx` — standalone chain project with same Fib/chart improvements
- `tests/sage_factors.test.js`
- `tests/fib_factors.test.js`  
- `tests/bb_gap.test.js`
