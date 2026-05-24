# PRI Options Tracker — Session Summary
**Date:** May 18, 2026  
**Handoff document for next Claude chat session**

---

## Project Overview

**App:** PRI (Premium Recurring Income) Options Tracker — React/Vite + Supabase + Vercel  
**Mission:** Systematically generating income from an equity portfolio by selling covered calls, while building an intelligent automation layer that executes trades across brokers, tracks performance, and continuously refines its own decision-making through AI-driven pattern recognition. The goal: a self-improving engine that gets smarter with every trade it makes.

**Main file:** `src/pri-tod-v3.jsx`  
**Deployed:** `https://options-tracker-five.vercel.app`  
**12 Vercel serverless functions** (at limit — consolidation planned, see below)

**Key API files:**
- `api/claude.js` — AI proxy + SAGE scan + BTO scan
- `api/market-refresh.js` — core cron, signal detection, auto-STO/BTC
- `api/chain-refresh.js` — option chains for all held tickers + autoSto tickers
- `api/schwab-orders.js` — order placement/preview
- `api/schwab-proxy.js` — Schwab data proxy
- `api/schwab-auth.js` — OAuth step 1
- `api/schwab-callback.js` — OAuth step 2
- `api/schwab-token-refresh.js` — daily token keeper
- `api/schwab-transactions.js` — standalone transaction lookup (no callers, candidate for deletion)
- `api/auto-import.js` — transaction reconciliation
- `api/etrade.js` — ETrade proxy
- `api/oi-tracker.js` — daily OI snapshots

**Second project:** Standalone options chain viewer at `C:\Users\fmdim\options-chain` using `src/OptionsChain.jsx`

**Supabase URL:** `https://ufagnokxmetushstgrip.supabase.co`  
**Cron/auth secret:** `CronSecret2026!`  
**Schwab re-auth:** `https://options-tracker-five.vercel.app/api/schwab-auth`  
**ETrade re-auth:** `https://options-tracker-five.vercel.app/api/etrade?action=auth&secret=CronSecret2026!`

---

## What Was Built Today

### 1. Auto-STO Scanner — Now Live
- Scans held tickers with `autoSto: true` in `stocks_data`, fires real orders via Schwab/ETrade
- **Deployed and fired live today**: AMZN ($270 Call May 29, Schwab 3866 ×7 + ETrade 6917 ×3) and JPM (manual adjustment)
- Signal type: `sto_auto` in `signal_log`
- Rule controlled via `signal_rules` table (`rule_type = 'sto'`, `dry_run = false`, `auto_execute = false`)
- **Key rule: no auto-execute logic should ever live in JS** — everything must have a `signal_rules` row

### 2. Chain Refresh Fixed
- Now fetches Mon/Wed/Fri expirations for next 16 days (not just Fridays)
- Also fetches chains for `autoSto = true` tickers, not just open contracts
- AMZN, NVDA etc. get MWF coverage so scanner can pick nearest valid expiry

### 3. Strike Selection Improved
- Nearest valid expiry wins (not furthest)
- OTM floor scales with DTE: ≤3d = minOTM×1.0, 4-7d = ×1.5, 8-14d = ×2.5
- Scoring by premium yield / OTM risk (`mid/stockPrice/otmPct`) — rewards efficient premium not just highest dollar

### 4. Notification Deep Links
- Pushover notification now links to: `/?tab=stocks&ticker=AMZN&strike=272.5&expiry=...&qty=7&price=3.90&account=...&action=sto`
- Opens Stocks tab → ticker expanded → `ChainOrderPanel` pre-filled with all order details
- Yellow banner: "🔔 Pre-loaded from SAGE signal — review and confirm before placing"
- Dry run notification includes full order JSON for review

### 5. SAGE Attention Scanner — Rebuilt as Live/Proactive
- No longer depends on signal history — computes all factors live on demand
- Fetches live quotes + 3-month daily candles + chain IV via Schwab API on each scan
- Scores all holdings with ≥100 shares in real time
- Manual ticker input to add any ad-hoc ticker to scan
- `⛓ chain` button on each row — navigates to Stocks tab with that ticker's chain

### 6. BTO Opportunity Scanner — New
- Separate scoring model (inverted from STO): rewards RSI oversold, near Fib support, lower BB band, gap-down fill, low IV
- Shows: 💚 Strong BTO Signal / 🟢 BTO Signal / 🟡 Watch / 🔴 Weak
- Manual ticker input for any symbol (not just holdings)
- `⛓ chain` button per row
- Both panels live in SAGE Explorer tab

### 7. SAGE Score Labels Improved
- Spectrum: 💚 Strong STO Signal (≥80) / 🟢 STO Signal (≥65) / 🟡 Watch (45-64) / 🔴 Not a Candidate (<45)
- LIVE toggle now green (not dark/invisible) for STO rule card

### 8. IV Rank / IV Percentile — Infrastructure Built
- New `iv_history` table: stores daily ATM IV per ticker (one row per symbol per day)
- `computeAndStoreIVRank()` in market-refresh: stores reading + computes rank vs 252-day history
- `iv_rank` (0-100, higher = IV near yearly high = great to sell) now highest weight (9) in SAGE
- `iv_percentile` also captured
- Raw `iv_pct` weight dropped from 9 → 5 (less meaningful without context)
- **SQL run:** `iv_history` and `support_resistance` tables created in Supabase

### 9. Support/Resistance Auto-Detection — Built
- `computeSupportResistance()` detects swing highs/lows from daily candles
- Clusters nearby levels (within 1.5%) into zones, tracks `strength` (touch count)
- Stores to `support_resistance` table, refreshed each market-refresh run
- New factors: `sr_near_resistance` (+4 STO score), `sr_near_support` (-4 STO score), `sr_nearest_dist_pct`, `sr_nearest_strength`
- Both SAGE scanner and market-refresh factor capture include S/R

### 10. SAGE Plain English Interpretation
- Each ticker row in SAGE scanner shows "SAGE INTERPRETATION" box
- Explains every factor in plain English with emoji indicators
- Covers: change%, IV%, RSI, Bollinger Bands, Fibonacci, VIX, Gap, IV Rank, S/R levels

### 11. Bug Fixes
- **IV% normalization**: Schwab returns volatility already as % (e.g. 46.5), was being multiplied by 100 again → fixed in both `claude.js` and `market-refresh.js`
- **`sto_auto` signals missing from signal log**: `logSignal` was passing `symbol` but DB column is `stock` → fixed
- **`expiry-2pm` rogue auto-closer**: was closing losing puts without a `signal_rules` gate — completely removed
- **`etNow` / `vix` scoping bugs**: both were defined inside inner try blocks but referenced in sibling blocks → hoisted to top-level scope
- **Schwab preview action names**: were using `action=preview` (close) instead of `preview-new` (open) for auto-STO orders → fixed
- **`open_method = 'auto'`**: now tagged on auto-placed contracts after successful order
- **`close_method = 'auto'`**: now always written for live btc_auto orders (removed `orderResult?.ok` gate)
- **Sub-100 share tickers filtered**: SAGE scanner now requires ≥100 shares to be writable

### 12. Dashboard Updates
- AUTO OPENED stat added to SKYNET AUTOMATION section
- AUTO PLACED + EST PREMIUM stats added to STO Scanner rule card
- Stats query now fetches `open_method` and `close_method` fields

### 13. UI Cleanup
- Removed: Import JSON burger menu item, Pending Transactions tab, all related state/components
- STO rule card: LIVE toggle now in header (same as BTC rules), green when live, yellow when dry run

---

## SAGE Scoring Model — Current State

**Architecture:** Hard gates → weighted sum → 0-100 score  
**Threshold:** 65/100 to be STO Favorable

### Hard Gates (fail = score irrelevant):
- `bb_position > 0` — overbought (upper BB)
- `vix < 18` — market too calm
- `change_pct < 0.5%` — stock not moving enough

### Weights (as of today):
| Factor | Weight | Notes |
|--------|--------|-------|
| `iv_rank` | 9 | PRIMARY IV signal — where IV sits in 52-week range |
| `dte` | 8 | Peaks at 30 days; sweet spot 21-45 |
| `vix` | 7 | Market volatility floor |
| `iv_percentile` | 6 | % of days with lower IV than today |
| `rsi_14` | 6 | Oversold = good; overbought = penalized |
| `change_pct` | 5 | Stock must be up ≥0.5% |
| `iv_pct` | 5 | Raw IV% (less meaningful without rank context) |
| `fib_near_resistance` | 4 | Natural ceiling above current price |
| `fib_broke_below` | 4 | Downward momentum |
| `sr_near_resistance` | 4 | S/R detected resistance nearby |
| `bb_pct_b` | 3 | Lower %B = more room to stay OTM |
| `gap_flag` | 2 | Gap = elevated IV |
| `fib_near_support` | -5 | Penalty — bounce risk |
| `sr_near_support` | -4 | Penalty — S/R support nearby |

**Honest status:** Weights are hand-tuned by intuition, not data. Need 50-100 `sto_auto` trades with outcomes before logistic regression can determine real weights.

### DTE Scoring Curve:
```
DTE:    21    25    30    35    40    45
Score:  0%   44%  100%   67%   33%    0%
```
**Note:** Frank targets shorter trades (2-7 DTE) — the DTE curve may need rebalancing once outcome data accumulates.

---

## Factor Infrastructure — Complete (20 factors)

| Factor | Source |
|--------|--------|
| `change_pct` | market-refresh |
| `vix` | market-refresh |
| `dte` | market-refresh |
| `otm_pct` | market-refresh |
| `rsi_14` | computeRSI() from daily candles |
| `iv_pct` | getAtmIv() from chain data |
| `iv_rank` | computeAndStoreIVRank() — needs history to build |
| `iv_percentile` | computeAndStoreIVRank() — needs history to build |
| `iv_history_days` | days of history accumulated so far |
| `fib_proximity_pct` | computeFibFactors() |
| `fib_level` | computeFibFactors() |
| `fib_broke_below` | computeFibFactors() |
| `fib_near_resistance` | computeFibFactors() |
| `fib_near_support` | computeFibFactors() |
| `bb_pct_b` | computeBollingerBands() |
| `bb_width` | computeBollingerBands() |
| `bb_position` | computeBollingerBands() |
| `gap_pct` | computeGapFlag() |
| `gap_flag` | computeGapFlag() |
| `gap_direction` | computeGapFlag() |
| `sr_nearest_type` | computeSupportResistance() |
| `sr_nearest_price` | computeSupportResistance() |
| `sr_nearest_dist_pct` | computeSupportResistance() |
| `sr_nearest_strength` | computeSupportResistance() |
| `sr_near_resistance` | computeSupportResistance() |
| `sr_near_support` | computeSupportResistance() |
| `sr_resistance_price` | computeSupportResistance() |
| `sr_support_price` | computeSupportResistance() |

---

## Signal Rules (signal_rules table)

| Rule | Type | Status | Key Settings |
|------|------|--------|--------------|
| Auto BTC after 3pm | btc_auto | ON / not live | min_profit 50%, fires after 3pm, Calls only |
| Auto BTC default | btc_auto | ON / not live | min_profit 70%, all day, Calls only |
| Default STO | sto | ON / LIVE | min_change 0.5%, 9:45am, DTE 1-14, min_premium $100, OTM 1-10% |

**Critical rule:** No automated behavior should exist in JS without a corresponding `signal_rules` row. The `expiry-2pm` block was a violation of this — it was removed entirely today.

---

## Live Trades Today (May 18)

### AMZN $270 Call May 29 — Auto-placed
| Account | Qty | Premium | Status |
|---------|-----|---------|--------|
| Schwab 3866 | 7 | $3,075 | **Closed** — auto-BTC profit $1,019 |
| ETrade 6917 | 3 | $1,318 | **Closed** — auto-BTC profit $458 |

**Note:** $270 strike only 0.75% OTM with 11 DTE — too tight. New chain-refresh + strike selection logic will prevent this going forward. Should have been May 21 expiry at ~$272.50.

### Current Open Positions
- AMZN $270 Call May 29 — Schwab 3866 ×7 @ $3,075 (`open_method = 'auto'`)
- AMZN $270 Call May 29 — ETrade 6917 ×3 @ $1,318 (`open_method = 'auto'`)
- AAPL $297.5 Put — Open (wheel strategy — do NOT auto-close)
- AAPL $302.5 Put — Closed at loss (wheel, BTC paid manually)
- TKO / OKLO — closed manually via app (expired May 15, were stuck Open)

**Wheel strategy note:** AAPL puts are wheel trades. Set `strategy = 'wheel'` on any put where assignment is acceptable. The btc_auto rule only processes Calls so puts are safe, but good to tag anyway.

---

## API Consolidation — Planned (NOT YET DEPLOYED)

**Target:** 12 → 9 functions, freeing 3 slots

**New merged `schwab-auth.js`** (replaces 3 files):
- `action=auth` → redirect to Schwab login
- `action=callback` → exchange code for tokens
- `action=refresh` → token keeper (cron job)
- `action=status` → health check

**Delete:** `schwab-callback.js`, `schwab-token-refresh.js`, `schwab-transactions.js`

**Before deploying — must do first:**
1. Schwab Developer Portal: update redirect URI to `/api/schwab-auth?action=callback`
2. Vercel env var `SCHWAB_CALLBACK_URL`: update to same
3. cron-job.org: update token keeper URL to `/api/schwab-auth?action=refresh`

**App audit result:** `pri-tod-v3.jsx` does NOT call any of the three files being deleted. No UI changes needed.

---

## External Data Sources — IV History

**Problem:** `iv_rank` and `iv_percentile` need historical IV data. Currently accumulating from Schwab daily — will take months to be meaningful.

**Best solution identified:** Tastytrade API
- Has dedicated `/market-metrics` endpoint returning IV rank + IV percentile per ticker
- Free — requires a Tastytrade account (free to open)
- Once a Tastytrade account is set up, build `tastytrade-iv.js` (uses 1 of 3 freed slots)
- Fetch daily after market close, backfill `iv_history` table immediately

**Other options researched:**
- CBOE DataShop — paid
- Alpaca — partial IV data
- Yahoo Finance — fragile scraping, ToS gray area, avoid
- Interactive Brokers API — rich but requires IB account

---

## Pending / Next Session Priorities

### 1. Tastytrade IV Integration (high value)
- Frank needs a free Tastytrade account
- Build `tastytrade-iv.js` to fetch IV rank/percentile daily for all 14 tickers
- Backfill `iv_history` immediately rather than waiting months

### 2. API Consolidation Deploy
- Merge schwab-auth/callback/token-refresh into one file
- Delete schwab-transactions.js
- Do Schwab portal + cron + env var updates first (checklist above)

### 3. DTE Scoring Rebalance
- Frank targets shorter trades (2-7 DTE)
- Current curve peaks at 30 days — may undervalue short-term high-IV trades on AMZN/OKLO
- Revisit once outcome data accumulates

### 4. SAGE Scoring First Pass
- Wire score into auto-STO decision (currently scores but doesn't gate orders)
- Gate: only fire STO if SAGE score ≥ threshold (currently 65)
- Show score in Signal Log for each auto-STO

### 5. Expiry Day Handling (properly this time)
- Design as a `signal_rules` row with `rule_type = 'expiry_notify'`
- Dry run first: send Pushover "expires today, currently OTM — confirm close?"
- Never auto-close without a dry-run validated rule

### 6. Fibonacci + S/R Integration into Strike Selection
- Current strike selection uses DTE-scaled OTM floor
- Better: use Fib resistance and S/R levels to inform strike placement
- "Place strike above nearest resistance" rather than fixed % OTM

### 7. CCI + Stochastic
- Nick Homira mentioned these alongside RSI
- Computable from daily candles already being fetched
- Add as factors in market-refresh and SAGE scanner

---

## Other Outstanding Items

- Wire `sharesByAcct` format in stocksData for Auto-STO scanner account allocation
- Re-sell notification after expiry close (wheel cycle)
- Confirm OI tracker cron is running
- `ticker_win_rate` and `days_since_last_sto` as computed factors via SQL
- Session summary → `min_dte`, `max_dte`, `min_otm_pct` gates in STO rule only advisory for scanner; OTM scaling is in code

---

## Files Changed This Session

- `api/market-refresh.js` — auto-STO live, factor capture, IV rank, S/R, scoping fixes, expiry-2pm removed
- `api/chain-refresh.js` — Mon/Wed/Fri expirations, autoSto tickers
- `api/claude.js` — sage_scan live (Schwab data), bto_scan new, IV/S/R factors, weights updated
- `api/schwab-auth.js` — NEW merged file (auth + callback + token refresh) — NOT YET DEPLOYED
- `src/pri-tod-v3.jsx` — SAGE Attention Scanner, BTO Scanner, chain links, label improvements, cleanup
- `iv_sr_tables.sql` — run in Supabase (iv_history + support_resistance tables)
