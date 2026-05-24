# PRI Options Tracker — Session Summary (May 15-16 2026)

## Stack
- React/Vite + Supabase + Vercel
- `src/pri-tod-v3.jsx` (6323 lines)
- `api/` — 12 Vercel serverless functions (at limit)
- Tests: `tests/utils.test.js` (298 passing)

## Key Files
- `api/market-refresh.js` — cron every 5min, all Skynet logic
- `api/auto-import.js` — imports Schwab/ETrade transactions
- `api/schwab-orders.js` — order placement
- `api/claude.js` — NEW: Claude API proxy (chat + skynet_analysis)
- `api/chain-refresh.js`, `api/etrade.js`, `api/notify.js` (legacy), `api/oi-tracker.js`
- `api/schwab-auth.js`, `api/schwab-callback.js`, `api/schwab-proxy.js`, `api/schwab-token-refresh.js`

## Completed This Session

### Auto-STO (Skynet Phase 1)
- Auto-STO scanner in market-refresh.js
- Whitelist via `autoSto` boolean on Stocks tab per ticker
- dry_run=true by default (safe)
- Splits orders by account (Schwab shares → Schwab API, ETrade → ETrade)
- Best strike = highest premium within OTM% range
- Next expiry after today meeting DTE range
- Re-entry allowed after BTC (different strike/expiry = new key)
- Signal rule now has: dry_run toggle, MIN CHANGE%, MIN/MAX DTE, MIN/MAX OTM%, MIN PREMIUM, MIN VIX, MIN TIME ET
- auto_execute removed — rule ON/OFF + dry_run is sufficient
- sharesByAcct format needed in stocksData (currently stores sharesSchwab/sharesEtrade separately — scanner needs to handle both)

### Signal Rules / Skynet Tab
- Renamed to "🤖 SKYNET" in tab bar, burger menu, page header
- Signal Rules now a real tab (not modal)
- STO rule editor: all fields including dry_run toggle with ⚠ LIVE MODE warning
- btc_auto rules: time-based (after 3pm → 60%, default 70%), min_time_et/max_time_et fields visible
- 📈 STO MOMENTUM FILTERS section with 4 indicators editable in UI
- 🧠 SKYNET INTELLIGENCE section with Claude analysis button

### Claude API
- `api/claude.js` — 12th and final Vercel function
- Mode "chat" — analytics AI assistant (was broken, now fixed)
- Mode "skynet_analysis" — fetches scoring_factor_values, signal_outcomes, weights, factors → Claude analyzes patterns → suggests weight changes
- Model: `claude-sonnet-4-5-20250929`
- Env var: `VITE_ANTHROPIC_API_KEY` (already in Vercel)
- `api/notify.js` — removed from browser call (market-refresh handles all notifications)

### Skynet Learning Infrastructure
- `signal_outcomes` table — written by auto-import when contract closes
- `scoring_factors` table — 15 factors seeded with descriptions
- `scoring_factor_values` — written at signal fire time for ALL signal types (STO, btc_auto, close, suppressed)
- `scoring_weights` — equal weights seeded
- `scoring_weight_history` — audit trail
- `writeFactorValues()` helper function in market-refresh
- `decision_log.contract_id` — added for signal→decision→contract chain
- Backfill SQL provided for historical signal_log data

### Dashboard
- 🤖 SKYNET AUTOMATION panel: Auto Closed %, App Closed %, Manual %, Skynet Profit, mini stacked bar
- `toApp()` fixed to map `open_method`/`close_method` from DB (was missing — caused $0 stats)
- Backfill SQL provided: UPDATE contracts SET close_method='auto' FROM trade_orders...

### Expiry Day Scenario Matrix (market-refresh.js)
- 8 scenarios: expiry_high_profit (≥65%), expiry_otm_up, expiry_itm_up, expiry_otm_down, expiry_itm_down, wheel_otm, wheel_itm_shallow, wheel_itm_deep
- 2pm auto-close for stock-down expiry-day contracts (skips wheel puts)
- Wheel detection: `contract.strategy?.toLowerCase().includes("wheel")`
- `shouldNotify` throttle: EXPIRY_WAIT/WHEEL fire once per day max
- Scenario-specific Pushover messages with emoji and action hints
- [DECISION] Expiry day matrix is part of Skynet model, NOT shown on dashboard

### Bug Fixes
- `quotes is not defined` in market-refresh — fixed by passing quotes as parameter to evaluateSignal()
- `pendingContractIds` moved to outer scope (shared by btc_auto and expiry-2pm scanners)
- Market hours gate: 9:35am-4:00pm ET for all notifications
- Partial close in-memory state update: after partial fill, parent.qty/premium updated so second fill matches
- Auto-fill trade_orders status=filled when contract closes via auto-import
- Orphan BTC prevention: `alreadyHandledByTradeOrder()` skips if Skynet already placed the order
- Close_method/open_method missing from toApp() mapping
- Import tab permanent badge: dismissed legacy pending_transactions ids 52,88,89,90
- AMZN BTO partial close: qty corrected to 4, premium to $1050.65

### SQL Migrations Applied This Session
```sql
ALTER TABLE signal_rules ADD COLUMN IF NOT EXISTS auto_execute boolean default false;
ALTER TABLE signal_rules ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE signal_rules ADD COLUMN IF NOT EXISTS rationale text;
ALTER TABLE decision_log ADD COLUMN IF NOT EXISTS contract_id bigint references contracts(id);
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS momentum_indicators jsonb;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS rule_id bigint references signal_rules(id);
ALTER TABLE trade_orders ADD COLUMN IF NOT EXISTS filled_at date;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS open_method text;  -- already existed
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS close_method text; -- already existed
-- New tables: signal_outcomes, scoring_factors, scoring_factor_values, scoring_weights, scoring_weight_history, price_snapshots, sto_momentum_config
```

### Current signal_rules Table
| id | rule_type | name | min_profit_pct | min_time_et | dry_run | enabled | priority |
|----|-----------|------|---------------|-------------|---------|---------|----------|
| 1 | sto | Default STO | — | 09:45 | true | true | 10 |
| 2 | btc_auto | Auto BTC default | 70 | null | false | true | 10 |
| 3 | btc_auto | Auto BTC after 3pm | 60 | 15:00 | false | true | 20 |

### Still Needed for Auto-STO
1. Confirm signal_rules has: min_dte, max_dte, min_otm_pct, max_otm_pct, min_premium columns
2. sharesByAcct format in stocksData — scanner reads sd.sharesByAcct but app stores sharesSchwab/sharesEtrade
3. ETrade STO order placement not wired (schwab-orders only handles Schwab)
4. Re-sell notification after expiry close not built
5. OI tracker cron — confirm running

### Tests (298 passing)
- Full simulation framework: makeRule(), makeQuote(), makeMomentumConfig(), makePriceHistory(), makeChain(), makeStocksData()
- evaluateAutoSto() pure function mirrors market-refresh logic
- All 15 auto-STO decision points tested with fake data
- Dynamic dates (no hardcoded 2026-05-15)

## Cron Jobs (cron-job.org)
- market-refresh: every 5min
- chain-refresh: every 15min  
- auto-import: every 5min
- schwab-token-refresh: every 90min
- ETrade renew: every 90min
