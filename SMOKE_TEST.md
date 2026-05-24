# PRI Options Tracker — Smoke Test Checklist
Run these checks before every production deploy.
Last updated: 2026-05-14

## Auth
- [ ] Login with correct PIN works
- [ ] Wrong PIN shows error
- [ ] 5 wrong PINs triggers lockout

## Dashboard
- [ ] Total Profit shows (not $0)
- [ ] Profit YTD < Total Profit (if pre-2026 trades exist)
- [ ] Open contracts count correct
- [ ] KPI cards render without errors

## Contracts Tab
- [ ] Contracts table loads (check row count matches DB)
- [ ] Profit % shows on closed contracts
- [ ] Close button on open Schwab contract → shows API close form (not manual)
- [ ] Close button on open ETrade contract → shows API close form (not manual)
- [ ] Close button → "Record manually" link still present
- [ ] Pending Orders section visible (if any pending)
- [ ] Pending Orders shows Account column
- [ ] Cancel order works (two-click confirm)
- [ ] open_method / close_method tracked on new contracts

## Import Tab
- [ ] Fetch button works
- [ ] Schwab + ETrade transactions both appear
- [ ] Account filter (Schwab / ETrade 6917 / ETrade 8222) works
- [ ] "Hide Committed" toggle hides already-committed transactions
- [ ] Commit plays sound + shows profit
- [ ] Strategy dropdown shows DB strategies (not hardcoded)
- [ ] Partial fill merge — duplicate STO/BTO on same date merges qty/premium
- [ ] Expired options auto-close matching open contract

## Pending Txns (Burger Menu)
- [ ] Shows pending/committed transactions
- [ ] Strategy saves automatically on change
- [ ] Committed rows show committed_by and date

## Plan Tab
- [ ] Watchlist tickers show
- [ ] Click ticker → options chain loads automatically (no "Enter ticker" prompt)
- [ ] STO button on strike row appears
- [ ] Pushover deep-link ?action=plan&ticker=X&signal_id=Y opens Plan tab with correct ticker
- [ ] Decision banner shows on plan form when signal_id in URL
- [ ] PASSED button + notes logs to decision_log
- [ ] Banner does NOT show a Traded button (auto-logged on commit)

## Order Placement (Schwab)
- [ ] Get Live Price → shows bid/mid/ask
- [ ] Penny +/- adjusts limit price
- [ ] Est. Profit calculates correctly
- [ ] Dry Run → shows in Pending Orders as dry_run_approved
- [ ] Live Submit → appears in Schwab app
- [ ] Cancel → removes from Pending Orders
- [ ] New STO order → open_method = 'app' on contract

## Order Placement (ETrade)
- [ ] Same as Schwab flow above
- [ ] Cancel works

## Close Flow (Schwab)
- [ ] Pushover deep-link ?action=close&id=X&signal_id=Y opens close form
- [ ] Decision banner shows on close form
- [ ] PASSED button logs decision_log
- [ ] Submitting close auto-logs decision as 'traded'
- [ ] close_method = 'app' on manual close via app

## Analytics Tab
- [ ] Monthly breakdown shows Nov/Dec 2025 data
- [ ] Schwab stats show correct premium/profit/count (not $0)
- [ ] ETrade stats show correct premium/profit/count
- [ ] Open Date / Close Date toggle works
- [ ] MoM% and YTD% calculate correctly

## Signal Log Tab (Burger Menu → 📡)
- [ ] Tab loads without white screen
- [ ] Rows appear (not blank/loading forever)
- [ ] ALL / STO / COMMITTED / ANOMALY filters work
- [ ] PUSHED / SUPPRESSED filter works
- [ ] "log" button expands inline decision panel
- [ ] Traded / Passed / Partial saves to decision_log
- [ ] Previously logged decisions show ✓ on load (not reset after tab switch)
- [ ] Contract link dropdown shows open contracts for that symbol

## Signal Rules (Burger Menu → 🤖)
- [ ] Modal opens without crash
- [ ] All rules load from DB
- [ ] Summary stats bar shows (Fired, Pushed, Auto Closed, Auto Profit)
- [ ] Enabled toggle saves correctly
- [ ] Dry Run toggle saves correctly with ⚠ LIVE MODE warning
- [ ] Numeric fields (min_profit_pct, DTE, etc.) save correctly
- [ ] Save Changes button only appears when edits are pending
- [ ] Discard reverts changes

## Auto-BTC (market-refresh cron)
- [ ] btc_auto rule fires when STO Call profit ≥ 70%
- [ ] Dry run sends Pushover with [DRY RUN] prefix, no order placed
- [ ] Live mode places BTC limit order at midpoint
- [ ] Falls back to bid if mid unavailable
- [ ] Skips contracts with existing pending orders
- [ ] Logs to signal_log with signal_type = 'btc_auto'
- [ ] Logs to decision_log as 'traded' (live) or 'dry_run'
- [ ] close_method = 'auto' set on contract after live order

## Portfolio Snapshots
- [ ] Daily snapshot captures Schwab + ETrade values
- [ ] Portfolio chart on Stocks tab shows 90-day line
- [ ] Today's change and period change display correctly

## Mobile
- [ ] Bottom ribbon visible
- [ ] All 6 tabs accessible from ribbon
- [ ] Active tab highlighted in green
- [ ] Signal decision banner readable on mobile (not clipped)
