# PRI Options Tracker — Smoke Test Checklist
Run these checks before every production deploy.

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
- [ ] Close button on open contract → shows "Place Order" for Schwab/ETrade accounts
- [ ] Close button → "Record manually" link works
- [ ] Pending Orders section visible (if any pending)
- [ ] Cancel order works (two-click confirm)

## Import Tab
- [ ] Fetch button works
- [ ] Schwab + ETrade transactions both appear
- [ ] Account filter (Schwab / ETrade 6917 / ETrade 8222) works
- [ ] "Hide Committed" toggle hides already-committed transactions
- [ ] Commit plays sound + shows profit
- [ ] Strategy dropdown shows DB strategies (not hardcoded)

## Pending Txns (Burger Menu)
- [ ] Shows pending/committed transactions
- [ ] Strategy saves automatically on change
- [ ] Committed rows show committed_by and date

## Plan Tab
- [ ] Watchlist tickers show
- [ ] Click ticker → options chain loads automatically (no "Enter ticker" prompt)
- [ ] STO button on strike row appears

## Order Placement (Schwab)
- [ ] Get Live Price → shows bid/mid/ask
- [ ] Penny +/- adjusts limit price
- [ ] Est. Profit calculates correctly
- [ ] Dry Run → shows in Pending Orders
- [ ] Live Submit → appears in Schwab app
- [ ] Cancel → removes from Pending Orders

## Order Placement (ETrade)
- [ ] Same as Schwab flow above
- [ ] Cancel works

## Analytics Tab
- [ ] Monthly breakdown shows Nov/Dec 2025 data
- [ ] Open Date / Close Date toggle works
- [ ] MoM% and YTD% calculate correctly

## Mobile
- [ ] Bottom ribbon visible
- [ ] All 6 tabs accessible from ribbon
- [ ] Active tab highlighted in green
