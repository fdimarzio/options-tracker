# PRI Options Tracker — Session Summary 2026-05-13

## Current State
- **Deployed at:** `options-tracker-five.vercel.app`
- **Stack:** React/Vite + Supabase + Vercel
- **Main files:** `src/pri-tod-v3.jsx`, `src/ImportPage.jsx`, `api/etrade.js`, `api/auto-import.js`, `api/market-refresh.js`, `api/schwab-orders.js`

---

## What Was Built This Session

### Positions-Driven STO Scanner (market-refresh.js)
- Fetches Schwab + ETrade equity positions via `fetchAllPositions()`
- Calculates uncovered shares per symbol per account
- Reads rules from new `signal_rules` DB table (not hardcoded)
- Logs every signal (pushed + suppressed) to new `signal_log` table
- 9:45am ET hard block enforced via `min_time_et` in `signal_rules`
- Re-notify threshold raised from $25 to $50

### signal_rules Table (new)
- All trading logic centralized in DB — no more hardcoded thresholds
- Seeded with one STO rule: min_time=9:45am, stock up ≥0.5%, DTE 1-14, OTM 1-10%, min premium $50
- Close rules intentionally NOT seeded — use DTE/OTM matrix instead

### signal_log Table (new)
- Every signal logged with: symbol, account, stock_price, change_pct, VIX, IV, time_of_day, day_of_week, strike, expires, DTE, OTM%, suggested_qty, est_premium, profit_at_signal, profit_pct_at_signal, pushed (bool)
- `pushed=false` for suppressed signals (e.g. before 9:45am) — captures what was filtered
- Foundation for scoring model and backtesting

### decision_log Table (new, not yet wired to UI)
- Schema: signal_id, contract_id, decision (traded/passed/partial/expired), reason, notes
- UI to be built next session

### portfolio_snapshots Table (new)
- Daily snapshot: schwab_value, etrade_value, schwab_cash, etrade_cash, total_cash, total_positions, open_contracts_value, total_value, daily_change, daily_change_pct
- Captured once per day on first market-refresh cron run
- ETrade positions API now returns `accountValue` and `cash`

### Portfolio Value Chart (stocks tab)
- Replaced Monopoly board with SVG line chart showing 90-day portfolio value
- Shows total value, today's change, period change since first snapshot
- Breakdown: Schwab / ETrade / Cash / Open Contracts
- Will populate as daily snapshots accumulate

### Signal Log Tab (new, burger menu → 📡 Signal Log)
- Table view of signal_log with filters by type
- Columns: Time, Type, Symbol, Account, Price, Chg%, VIX, Strike, Exp, DTE, OTM%, Qty, Est$, Profit%, Pushed
- Shows pushed ✓/✗ to distinguish sent vs suppressed signals

### Stocks Tab — Share Counts Fixed
- Schwab shares: `Math.floor(longQuantity)` — no more fractional display (100.09 → 100)
- ETrade shares: auto-fetched on Live Data refresh, written to `stocksData.sharesEtrade`
- Both Schwab and ETrade Qty columns in stocks table
- Green dot (Schwab live) / yellow dot (ETrade live)
- Market value calculated from `currentPrice × (schwabQty + etradeQty)` for ETrade-only rows
- `sharesSchwab` zeroed out for tickers no longer in Schwab positions
- `allSymbols` now driven by actual holdings — stocks with 0 shares auto-removed

### Auto-Import Fixes (auto-import.js)
- **Composite fingerprint dedup** — ETrade transactions with unstable IDs now matched by stock|opt_type|strike|expires|account|premium|qty|date_exec
- **Expired options** — ETrade "Option Expired" and Schwab "EXPIRED" transaction types handled; auto-closes matching open contract with 100% profit (STO) or full loss (BTO)
- **Partial fill merge** — STO/BTO transactions matching same stock+opt_type+strike+expires+account+date_exec are merged (qty added, premium summed) instead of creating duplicate rows
- **Anomaly dedup** — only truly new anomalies trigger Pushover; existing ones blocked silently
- **Schwab account name** — now stored as `"Schwab 3866"` (full name with last 4 digits) instead of plain `"Schwab"`

### Covered Shares Mismatch Fix (market-refresh.js)
- Old contracts stored as `"Schwab"`, positions come in as `"Schwab 3866"`
- Fix: when building coveredMap, plain `"Schwab"` keys are expanded to match all `"Schwab XXXX"` position keys
- TODO: run SQL to backfill old contracts: `UPDATE contracts SET account = 'Schwab 3866' WHERE account = 'Schwab';`

### New Opening Orders — Schwab + ETrade (schwab-orders.js)
- `preview-new` — Schwab STO/BTO preview (uses Schwab live price, SELL_TO_OPEN/BUY_TO_OPEN)
- `approve-new` — Schwab STO/BTO submit
- `etrade-preview-new` — ETrade STO/BTO preview (Schwab price + ETrade preview endpoint for previewId)
- `etrade-place-new` — ETrade STO/BTO place using previewId
- Safety check that blocked non-closing orders removed (now commented out)

### ETrade Token Auto-Renewal (etrade.js)
- `action=renew` — calls `/oauth/renew_access_token`, handles plain text response
- Cron job added at cron-job.org: every 90 min Mon-Fri during market hours
- morning alert in market-refresh: Pushover at 9-10am ET if token is from previous day
- Still requires one manual re-auth per day (ETrade OAuth 1.0a limitation)

---

## Cron Jobs (cron-job.org)
| Job | URL | Schedule |
|-----|-----|----------|
| Market Refresh | `/api/market-refresh?secret=CronSecret2026!` | Every 5 min, Mon-Fri |
| Chain Refresh | `/api/chain-refresh?secret=CronSecret2026!` | Every 15 min, Mon-Fri |
| Auto Import | `/api/auto-import?secret=CronSecret2026!` | Every 5 min, Mon-Fri |
| ETrade Renew | `/api/etrade?action=renew&secret=CronSecret2026!` | Every 90 min, Mon-Fri |

---

## Database Tables (new this session)
- `signal_log` — every signal fired (pushed + suppressed)
- `decision_log` — user decisions on signals (schema created, UI not yet built)
- `signal_rules` — all trading rules centralized (STO rule seeded)
- `portfolio_snapshots` — daily portfolio value snapshots

---

## Next Priorities

### 1. SQL Backfill
```sql
UPDATE contracts SET account = 'Schwab 3866' WHERE account = 'Schwab';
```

### 2. Decision Log UI
- After each signal in Signal Log tab, allow logging: traded / passed / reason
- Links signal_id + contract_id when a trade was placed

### 3. Trading Model Dashboard
- Score-based view (0-100) combining signal conditions
- Visualize signal history vs outcomes
- Rule editor for signal_rules table

### 4. Assigned/Exercised Handling
- OKLO PUT assigned example: close STO with cost_to_close=0, profit=full premium, exercised=true
- Need `exercised` boolean column on contracts table

### 5. IV Tracking
- IV rank/percentile per ticker (not just raw IV)
- Add to signal_log at fire time
- Add iv_at_open, iv_at_close to contracts table

### 6. Earnings Proximity
- Add to chain-refresh: days to next/last earnings per ticker
- Use in STO scanner — don't suggest STO within N days of earnings

### 7. Backtesting Engine
- Replay historical signal_log rows against different rule sets
- Measure: contract profit + portfolio value change

### 8. Scoring Model
- 0-100 score per opportunity
- Inputs: stock change%, time of day, VIX, IV rank, DTE, OTM%, earnings proximity
- Eventually: auto-execute when score > threshold

### 9. External Data Feeds
- News sentiment
- Kalshi prediction markets
- Podcast mentions

---

## Key Notes
- Ultimate objective: grow total portfolio value (Schwab + ETrade)
- STO suggestions: stock must be up ≥0.5% and after 9:45am ET — timing model to be refined with data
- Close signals: use DTE/OTM matrix (not signal_rules) for thresholds
- For STC (closing a long): no time restriction — take profit when available
- Scoring model planned: -1 to +1 or 0-100 based on conditions + learned patterns

## Secret
`CronSecret2026!` — used in all API calls

## ETrade Re-auth URL
`https://options-tracker-five.vercel.app/api/etrade?action=auth&secret=CronSecret2026!`

Good luck with the next session!
