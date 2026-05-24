# PRI Options Tracker — Session Summary
**Date:** May 20, 2026  
**Previous session:** session_summary_20260519.md

---

## What We Worked On Today

### 1. Pending Orders Cleanup
- Deleted stale dry-run orders (IDs 62 and 63 — JPM and NVDA) from `trade_orders` table
- Root cause: `status = 'pending_approval'` (not 'PENDING APPROVAL' as assumed)

### 2. SAGE Scoring Model — Major Refactor
- **Removed** `dte`, `time_of_day`, `days_since_last_sto` from scoring (circular/redundant)
- **Added** `weight` column to `scoring_factors` table and populated all weights
- **Added** missing factors to DB: `iv_rank`, `iv_percentile`, `iv_pct`, `fib_*`, `bb_pct_b`, `gap_flag`, `sr_*`
- **Redesigned** from 0-100 score to **flag-based risk model**
- **Created** three new tables: `sage_flags`, `sage_thresholds`, `ticker_tiers`
- `claude.js` now loads scoring config dynamically from DB (no code deploy needed to adjust weights)

### 3. Chain Data Fix
- **Bug:** `chain-refresh` and `market-refresh` ran simultaneously — chain data always stale when signals fired
- **Fix:** `market-refresh.js` now calls `fetchLiveChain()` at signal-fire time instead of relying on cached blob
- `dte` and `time_of_day` removed from `scoring_factor_values` writes

### 4. Backtesting
- Built `backtest.js` — 6 months of Schwab price history, 17 tickers, simulated covered calls
- Built `backtest_v2.js` — expanded to 52 tickers (your holdings + S&P 500 top options volume)
- Added **Black-Scholes premium estimation** using 20-day historical volatility
- **Key findings:**
  - Overall win rate: 81.7% at 2.5% OTM
  - HIGH_VOL tickers (WDC, AMD, OKLO) win only 69.4% — worst EV
  - Current SAGE score was **inverting outcomes** (≥65 scored worse than <65)
  - RSI and BB%B have zero predictive value — removed
  - Gap flag was backwards — should be negative signal
  - CAT: never reaches positive EV at any OTM% — weekly calls not worth it
  - Best new tickers to add: JNJ, V, WFC, BAC, META, CRM, GS, BX, PLTR
  - Best BTO tickers: MU ($+2.86 EV), AMD ($+2.42), INTC ($+0.73), CAT ($+0.71)

### 5. Opportunity Scanner (New Tab)
- Built `OpportunityScannerTab` component — continuous two-pass scanner
- **Pass 1:** Quote scan of 52 tickers in batches, streams tickers in log
- **Pass 2:** Live chain fetch for shortlisted candidates, ranks top 3 options
- **STO ranking:** premium / (otm_pct × √dte) — rewards premium yield vs risk
- **BTO ranking:** (wr × avg_profit) / premium — EV per dollar spent
- Manual ticker scan input (type any ticker + hit SCAN)
- Accessible from burger menu → Opportunity Scanner

### 6. Strategy Linking
- Added `strategy_group_id` and `strategy_type` columns to `contracts` table
- Built UI in contract detail modal to link legs together
- Supported strategies: Straddle, Strangle, Vertical Spread, Collar, Covered Call, Iron Condor, Wheel, Long Call Hedge, Custom
- Same-ticker filtering, show/hide closed contracts, combined P&L display

### 7. Split Transaction Fix
- **Bug:** Two partial fills of same STO in same batch both inserted as separate rows
- **Root cause:** `openContracts` loaded once at start; newly inserted contracts not added to in-memory list
- **Fix:** After inserting new STO/BTO, immediately push to `openContracts` so subsequent fills can merge
- **Tests:** Added `tests/auto-import.test.js` (Vitest format, 8 tests)
- **package.json:** Changed `test:unit` from `vitest run tests/utils.test.js` to `vitest run tests/` — now runs ALL test files
- **Data fix:** Merged AMZN ETrade (IDs 96+97) and NOW Schwab (IDs 102+103) manually in DB

### 8. Import Tab Restored
- **Problem:** Import tab was rendering `ImportPage.jsx` as standalone app (showed login screen)
- **Fix:** Built `ImportDailyTab` component inline in `pri-tod-v3.jsx` — no dependency on `ImportPage.jsx`
- Shows: Auto-committed today, Anomalies, Manual entries
- Columns: Stock, Type, Side, Strike, Qty, O/C, Premium, Account, Time
- Import is on **bottom ribbon** (not burger menu)

### 9. Supabase RLS
- Received Supabase security alert — RLS disabled on all tables
- SQL provided to enable RLS + add permissive anon policies (not yet run — to do tonight)

### 10. Resume / Anthropic Application
- Built two tailored resumes for Anthropic roles:
  - `DiMarzio_Resume_ClaudeCode_Anthropic.docx`
  - `DiMarzio_Resume_Monetization_Anthropic.docx`
- Both highlight $41,630 profit in first six months, Options Tracker project, two acquisitions

---

## Current State of Key Files

### Deployed Today
- `claude.js` — flag-based SAGE model, DB-driven
- `market-refresh.js` — live chain fetch at signal time, removed dte/time_of_day from factor writes
- `pri-tod-v3.jsx` — Opportunity Scanner, Import tab, Strategy linking, SAGE flag UI
- `auto-import.js` — partial fill merge fix
- `tests/auto-import.test.js` — new Vitest test file
- `package.json` — runs all tests in `tests/` folder

### Database Changes Today
- `trade_orders`: deleted IDs 62, 63 (stale pending dry-runs)
- `contracts`: merged IDs 96+97 (AMZN ETrade), 102+103 (NOW Schwab)
- `contracts`: added `strategy_group_id bigint`, `strategy_type text`
- `scoring_factors`: added `weight` column, populated all factors, disabled RSI/BB from scoring
- New tables: `sage_flags` (12 rows), `sage_thresholds` (4 rows), `ticker_tiers` (17 rows)
- `scoring_factor_values`: iv_rank, fib_*, bb, gap, sr now storing correctly going forward

---

## Open Items / Next Steps

### High Priority
1. **Run RLS SQL** — enable Row Level Security on all Supabase tables (SQL ready, not yet run)
2. **SAGE score gating** — scores computed but auto-STO still not gated by SAGE flag model
3. **API consolidation deploy** — `schwab-auth.js` consolidation written but not deployed

### Medium Priority
4. **Tastytrade IV integration** — needed for real IV history instead of HV estimates
5. **Ticker tier gate in auto-STO** — block/widen OTM for high_risk tickers in market-refresh
6. **Expiry day handling** — design as `signal_rules` row, dry-run first
7. **BTO scanner signals** — opportunity scanner finds BTO candidates but no auto-placement yet

### Backtest Follow-up
8. **Rebuild SAGE weights** based on backtest findings (RSI/BB removed, gap flipped negative)
9. **OTM% adjustment** by tier — PLTR/ORCL viable at 4-5% OTM; AMD/WDC/OKLO not worth it
10. **Premium quality tracking** — winning $0.10 ≠ winning $1.20; add to outcome tracking

### App
11. **Push notifications** for Opportunity Scanner hits
12. **Expand scanner universe** beyond 52 tickers toward full S&P 500

---

## Open Positions (as of May 20)
- AMZN $267.50 Call May 22 — Schwab (7) + ETrade (3) — auto-opened
- AAPL $297.50 Put May 20 — do NOT auto-close (wheel)
- NVDA $227.50 Call May 22 — ETrade (3) — STO
- JPM $302.50 Call May 22 — Schwab (2) — STO
- OKLO $59 Call May 22 — ETrade 8222 (8) — STO
- WDC $477.50 Call May 22 — Schwab (1) — STO
- NOW $120 Call Oct 16 — Schwab (3) — BTO

## ETrade Token
- Re-authorized manually today at ~12pm ET
- Cron job renews hourly — confirmed working
