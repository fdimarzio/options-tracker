# TOD — Trading Options Dashboard
## App Bible: The Complete Reference

*Last updated: June 10, 2026 | Living document — updated every session*

---

## What This App Is

TOD (Trading Options Dashboard) is a full-stack options trading automation platform built to systematically generate income from an equity portfolio by selling covered calls. It integrates with Charles Schwab (taxable brokerage) and ETrade (IRA accounts), executes trades automatically via Skynet, tracks every transaction, and continuously refines its strategy through DANI simulations.

**The mission:** A self-improving trading engine that gets smarter with every trade.

---

## People

| Person | Role | PIN |
|--------|------|-----|
| Frank DiMarzio | Owner, developer, primary trader | 0116 |
| Priscilla Perutti DiMarzio | Co-user | 4223 |

---

## Accounts

| Account | Owner | Type | Broker | Tax Treatment |
|---------|-------|------|--------|---------------|
| 6501-3866 | Frank DiMarzio | Taxable brokerage | Schwab | Fully taxable |
| 227-156917-203 | Frank DiMarzio | Rollover IRA | ETrade | Tax deferred |
| 227-418222-208 | Priscilla Perutti | Traditional IRA | ETrade | Tax deferred |

**Key rule:** ETrade accounts are IRA/tax-deferred. Import all transactions for portfolio tracking, but exclude from tax calculations.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React/Next.js (`src/pri-tod-v3.jsx`, ~7,500+ lines) |
| Backend | Vercel serverless functions (`api/` directory, 9 functions) |
| Database | Supabase (PostgreSQL) — project `ufagnokxmetushstgrip` |
| Cron | GitHub Actions (every 5 min market hours via `market-refresh.js`) |
| Notifications | Pushover API |
| Brokers | Schwab OAuth 2.0 + ETrade OAuth 1.0a |
| AI | Claude (SAGE scoring, this chat session) |
| Task management | PAM → mirrored to PRI TOD via GitHub Actions every 4 hrs |

---

## Key URLs & References

| Item | Value |
|------|-------|
| App | https://options-tracker-five.vercel.app |
| Repo | github.com/fdimarzio/options-tracker |
| Supabase PRI | ufagnokxmetushstgrip |
| Supabase PAM | ghdmvzlfenpmoiyyagqw |
| PAM project ID | ad7ebc28-87cd-4a31-87e9-6389e4f7626a |
| Schwab account hash | 757F62A9417DA1B75005EAC7370D033ABF819061E60384AA3B0F68A0AAE94961 |
| Local dev | C:\Users\fmdim\options-tracker |
| Local dev command | `npm run dev -- --port 3000` |
| Schwab re-auth URL | https://options-tracker-five.vercel.app/api/schwab-auth |
| ETrade re-auth | Call 1-800-387-2331, consumer key `5974003f...` |

---

## Named Systems

### SAGE — Signal Analysis & Guidance Engine
Trade quality scoring model. Scores each potential STO signal 0–100 before it becomes an order.

**Scoring weights (DANI Run 4, June 2026):**
| Factor | Weight |
|--------|--------|
| change_pct | 1.57 |
| ticker_win_rate | 1.39 |
| DTE | 1.13 |
| time_of_day | 0.52 |
| VIX | 0.70 (live feed in progress) |

### DANI — Data-driven Automated Notes & Intelligence
Back-simulation engine. Runs against millions of real options chain snapshots to validate every trading hypothesis before it touches live trading. Every config variable is a hypothesis, not a setting.

**Run history:**
| Run | Date | Snapshots | Key findings |
|-----|------|-----------|-------------|
| Run 4 | June 5, 2026 | 9M+ (42 scenarios) | AMD/WDC → AVOID; stop loss hurts DTE≤3; BTC target 85% > 65%; change_pct weight → 1.57 |
| Run 5 | ~June 20, 2026 | TBD | Day-of-week, cron window, all config vars as named scenarios |

### Skynet — Automated Trading Engine
All automation rules. DB-driven via `signal_rules` table — no hardcoded values.

**Active rules:**
| Rule | Type | Tickers | Threshold | Status |
|------|------|---------|-----------|--------|
| Default BTC | btc_auto | All | 85% profit | Live |
| After-3pm BTC | btc_auto | All | 75% profit | Live |
| JPM/WDC/AAPL/CAT BTC | btc_auto | JPM, WDC, AAPL, CAT | 85% profit | Live |
| Auto-STO scanner | sto | All configured | Various | Live |
| ITM expiry auto-close | expiry_protection | All STO | n/a | dry_run=true |
| LEAPS LTCG protection | protect_leaps_ltcg | All STO | orig DTE > 365 | Live |

**LEAPS LTCG protection:** both auto-BTC paths (default + after-3pm) skip any contract whose *original* DTE at open — `COALESCE(entry_dte, expires - date_exec)` — was over 365 days, even once its remaining DTE has dropped well below that. A LEAP opened to be held past the 1-year long-term-capital-gains mark is never auto-closed on a routine profit hit; it just sits protected until manually closed. Shown in the Skynet tab (rule card has a plain-language description instead of numeric fields) and as a 🔒 LTCG badge on qualifying open contracts in the Contracts view.

**Known issue:** Auto-BTC fires once per open STO row instead of aggregating — creates multiple BTC orders for fragmented positions. Fix pending.

**Auto-STO performance (as of June 8, 2026):**
- Auto-BTC: 90%+ win rate, $5,752+ total profit
- June 8: +$1,906.20 P&L, 39 contracts, 5 auto-STOs fired after `contractDryRun` bug fix
- 3 fully automated (auto open + auto close): 100% win rate, $532 avg profit

### BRIA — Morning Briefing Agent
Separate Vercel project (`bria-agent` repo). Built but env vars not yet configured.

### MIKE — LLC Financial Dashboard
Separate GitHub repo. Shares Supabase backend with TOD. Frank PIN: 0116, Priscilla PIN: 4223. Deployed but `stock_transactions` backfill needed before useful.

---

## Database — Key Tables

| Table | Purpose | Notes |
|-------|---------|-------|
| `contracts` | All options trades | STO/BTC/BTO/STC; open and closed. `settlement_date` = T+1 biz day from `date_exec` for Schwab (used for statement reconciliation) |
| `trade_orders` | All broker order submissions | With fill status and price history |
| `signal_log` | All SAGE signals | With scoring factors |
| `signal_outcomes` | Win/loss outcome per signal | Linked to contracts via contract_id |
| `signal_rules` | **Auto-trading rules** | ALL thresholds here — never hardcode |
| `sto_momentum_config` | Momentum filter config | UI-editable; all auto-STO gates |
| `ticker_risk_config` | Per-ticker config | min_otm_pct, max_dte, IV thresholds, AVOID flag |
| `skynet_controls` | Safety limits | Max order value $10k, bid/ask deviation 15% |
| `rule_config_log` | Config snapshot history | Auto-snapshots on every save |
| `stock_transactions` | Equity trade history | Schwab + ETrade; imported for tracking/tax. `settlement_date` = T+2 biz days from `trade_date` for Schwab |
| `portfolio_snapshots` | Daily account values | schwab_value + etrade_value + total_value |
| `price_snapshots` | Intraday prices | IV, Greeks, per ticker |
| `iv_history` | IV history | Per ticker, daily |
| `col_prefs` | App preferences + broker tokens | Schwab + ETrade OAuth tokens stored here |
| `pam_tasks` | PAM backlog mirror | Read-only — sync every 4 hrs; NEVER write here |
| `pam_milestones` | PAM milestones mirror | Read-only |
| `pam_projects` | PAM projects mirror | Read-only |
| `dani_runs` | DANI simulation log | Per run metadata |
| `sim_results` | DANI simulation results | Per scenario |

---

## Code Patterns & Architecture Rules

### The Golden Rules
1. **All automation must be DB-gated.** No automated behavior in JS without a corresponding `signal_rules` row with `dry_run` control.
2. **Never hardcode thresholds.** All values (profit %, OTM%, DTE limits) come from the DB.
3. **PAM mirror is read-only.** Never write to `pam_tasks`. All PAM changes go in the PAM database (`ghdmvzlfenpmoiyyagqw`), not the mirror.
4. **Every auto-trading rule needs test cases** before going live — positive AND negative.
5. **Market hours gate on everything.** No orders outside 9:30am–4:00pm ET Mon–Fri.

### Key Learnings (June 10, 2026)
- **Fill detection must close the contract** — don't rely on auto-import to close after a BTC fill. Fill detection has all the info (stock, strike, expires, fill_price, qty) and should close immediately. auto-import then creates the BTC row for audit trail with `skipParentClose=true`.
- **ETrade transaction IDs are not stable** — the same economic transaction can appear with different IDs across API calls. The transaction ID pre-check must be supplemented with a composite fingerprint dedup (stock+opt_type+strike+expires+account+date_exec+premium ±$0.10).
- **BTC guard prevents re-firing** — before placing any auto-BTC order, check if a `filled` trade_order already exists. This prevents the cascade of rejected BTC orders after a fill that hasn't yet propagated to contract status.
- **Chase loop must handle ETrade separately** — ETrade uses `PUT /v1/accounts/{accountIdKey}/orders/change.json` to modify price in place. Schwab cancels + resubmits. Never send a Schwab API call for an ETrade order.
- **Settlement date = accounting date** — always use settlement date for Schwab reconciliation. Both `contracts` and `stock_transactions` have `settlement_date` columns for this purpose.
- **Partial fill guard: tx ID, not qty** — the ETrade partial fill guard must compare transaction IDs, not quantities. A smaller second fill (qty=1 after qty=2) is a legitimate new partial, not a re-issue.

### Key Learnings (June 8, 2026)
- **`contractDryRun` is BTC-scope only** — STO block must use `isDryRun`. Any variable used in order placement must be verified in scope.
- **BTC matching must filter by account first** — never fall through to cross-account match. Same stock/strike/expiry in two accounts is common (AMZN, AAPL both accounts).
- **Chase must step down on a timer, not track ask** — wide-spread options (CAT) will never fill if chase only moves when market moves.
- **Contract tagging at fill time, not placement time** — contract doesn't exist yet when order is placed. Tag after fill confirmation.
- **profit/profit_pct are stored, not computed** — manual cost_to_close updates need corresponding profit recalc. DB trigger is the permanent fix.

### React/DB Mapping
`pri-tod-v3.jsx` uses camelCase in React (`strategyGroupId`) mapped to snake_case in DB (`strategy_group_id`) via `toApp`/`toDB` mappers at ~lines 13–100. New DB columns must be added to both mappers.

### Vercel Requirements
- `vercel.json` with API rewrite rules is REQUIRED or SPA catch-all swallows all `/api/*` routes → 404
- Current working `vercel.json`:
```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```
- Vercel Hobby plan: 12 serverless function limit (currently at 9), daily cron only
- All cron/background jobs run via GitHub Actions instead

### Environment Variables
- `vercel env pull --environment=production` to get all production keys into `.env.local`
- `vercel env pull` (no flag) only pulls development vars — many keys will be missing
- Run scripts locally: `node --env-file=.env.local scripts/scriptname.js`
- ETrade env var mismatch: Vercel has `VITE_ETRADE_*`, scripts need `ETRADE_*` (no VITE_ prefix)

---

## Development Workflow

```
PAM (enter tasks)
    ↓ GitHub Actions every 4 hrs
pam_tasks mirror in PRI TOD DB
    ↓ Claude queries mirror
Backlog grooming (this chat)
    ↓ DB-only changes: apply directly via Supabase MCP
    ↓ Code changes: build Claude Code batch prompt
Claude Code executes
    ↓ One commit per batch, test cases required
Verify in app + DB
    ↓ Confirmed working
Mark done in PAM DB (ghdmvzlfenpmoiyyagqw)
    ↓ Run PAM sync (GitHub Actions → manual trigger)
Clean mirror
```

### Claude Code Prompt Template
Every Claude Code prompt must end with:
> "One single commit at the end: '[description]'. Do not commit after each task. Auto-approve all git operations."

Every task in the prompt must include:
- What to build (specific, with table/column names)
- Positive test case (fires when it should)
- Negative test case (does NOT fire when it shouldn't)

### Git Bash on Windows Gotchas
- Multi-line commands trigger bracket-paste mode — use `read -s VAR` first, then paste each command as a single long line
- `jq` not installed — use `python3 -m json.tool` instead for JSON formatting
- Line endings: LF → CRLF warnings are normal, ignore them

---

## Broker Auth

### Schwab
- Access token: expires every 30 minutes (auto-refreshed by market-refresh.js)
- Refresh token: valid 7 days — re-auth required weekly
- Re-auth: navigate to `https://options-tracker-five.vercel.app/api/schwab-auth` in browser
- Tokens stored in `col_prefs` row `id='schwab_tokens'`

### ETrade
- OAuth 1.0a — tokens stored in `col_prefs` row `id='etrade_tokens'`
- Reset when broken: call 1-800-387-2331, consumer key starts with `5974003f`
- Currently: `signature_invalid` error — needs phone reset

---

## Statement Reconciliation

### Directory Structure
All PDFs live in `statements/` root (not in subfolders). Filenames auto-detected:
- Schwab: `Brokerage Statement_2026-01-31_866.PDF`
- ETrade: `ClientStatements_6917_013126.pdf` (MMDDYY format)

**15 PDFs total:** Schwab × 5 months, ETrade 6917 × 5 months, ETrade 8222 × 5 months (Jan–May 2026)

### Reconciliation Logic (two passes)
1. **Equity pass:** Statement equity BUY/SELL/DIVIDEND/INTEREST → compare vs `stock_transactions`
2. **Options pass:** Statement options BUY/SELL → compare vs `contracts`

**Important:** Statement purchase/sale totals include BOTH equity and options combined. Don't compare statement totals directly to `stock_transactions` alone — that will always show a gap.

### Script
`node --env-file=.env.local scripts/reconcile-statements.js`

Debug mode: `DEBUG=1 node --env-file=.env.local scripts/reconcile-statements.js`

### Current Status (June 10, 2026)
All equity passes are green ✅ across all 5 months for both Schwab and ETrade.

| Account | Equity | Options Collected | Options Paid |
|---------|--------|------------------|-------------|
| Schwab Jan | ✅ | -$0.01 ✅ | +$175.59 |
| Schwab Feb | ✅ | -$211.34 | $0.00 ✅ |
| Schwab Mar | ✅ | +$198.34 | -$84.55 |
| Schwab Apr | ✅ | +$13.00 | -$224.65 |
| Schwab May | ✅ | $0.00 ✅ | +$309.19 |
| ETrade Jan | ✅ | +$0.02 ✅ | -$192.51 |
| ETrade Feb | ✅ | +$368.67 | +$2.32 |
| ETrade Mar | ✅ | -$238.96 | $0.00 ✅ |
| ETrade Apr | ✅ | -$200.74 | -$2,877.09 |
| ETrade May | ✅ | -$748.94 | +$401.48 |

Results written to `reconciliation_results` table and displayed in app Reconciliation tab.

### Settlement Date — Why It Matters for Reconciliation
Schwab statements use **settlement date** (not trade date) to organize cash flow:
- **Options settle T+1** (next business day after trade)
- **Equities settle T+2** (two business days after trade)

The `contracts` table has a `settlement_date` column (T+1 from `date_exec`) and `stock_transactions` has `settlement_date` (T+2 from `trade_date`). The reconciliation script queries by `settlement_date` for Schwab accounts to match what appears on the statement.

**Holiday edge cases:** The simple T+1/T+2 backfill does not know about market holidays. If a trade's settlement falls on a holiday, manually correct the `settlement_date`. Example: May 28 (Wed) + T+1 = May 29, but May 26 (Mon) was Memorial Day — settlement is correctly May 29, not June 1.

**ETrade:** Does not use settlement_date — reconciliation uses `date_exec`.

### ETrade PDF parsing quirk
ETrade PDFs use two-column layout — pdftotext reads all labels on one line, all values on another. Parser finds `CASH FLOW` + `OPENING CASH` header, extracts signed amounts in order: `[opening, (purchases), sales, (net_unsettled), income, ..., closing]`. Purchases = first negative, sales = first positive > $100 after purchases.

---

## DANI Simulation

### Running a Simulation
```bash
node --env-file=.env.local scripts/dani-simulation.js
```

### Schedule
- Run after ~10 trading days of new data
- Next run: ~June 20, 2026
- Each run: name all scenarios explicitly in `sim_results`

### Open Questions for Run 5
1. Does day-of-week affect win rate (Mon/Fri vs Tue–Thu)?
2. Is 9:30–10:30am a higher quality signal window? (justify 1/min cron)
3. Is 0.5% pullback threshold better than 0.3%?
4. Does tightening max DTE from 4 to 3 improve EV?
5. Does 85% BTC target outperform 75% after 3pm?
6. What OTM% by IV bucket is optimal for AMD/WDC?

---

## Ticker Configuration

### AVOID (ticker_risk_config action=avoid)
| Ticker | Reason | DANI Run |
|--------|--------|----------|
| AMD | 13% win rate on covered calls | Run 4 |
| WDC | 36% win rate, net -$11,593 | Run 4 |

### Best performers (auto-BTC, June 2026)
| Ticker | Trades | Win Rate | Total Profit |
|--------|--------|----------|-------------|
| AMZN | 12 | 83.3% | $3,859 |
| JPM | 3 | 100% | $854 |
| CEG | 2 | 100% | $673 |
| NVDA | 2 | 100% | $270 |

---

## Known Issues & Deferred Items

| Issue | Status | Notes |
|-------|--------|-------|
| ETrade `signature_invalid` | Blocked | Needs phone reset 1-800-387-2331 |
| ETrade env var VITE_ prefix | Pending | Backfill script needs ETRADE_* not VITE_ETRADE_* |
| Expiry protection | dry_run=true | Wait for first dry_run to fire before going live |
| MIKE deployment | Deployed, empty | Needs backfill + reconciliation first |
| BRIA agent | Built | Env vars not configured in Vercel |
| RLS col_prefs | Deferred | SUPABASE_SERVICE_KEY not loading correctly post-deploy |
| getAccountHash bug | Open | Orders 82/83/86/96 stuck as submitted not filled |
| Two cron jobs (1/min) | Pending | Wait for DANI Run 5 to validate 9:30–10:30am window first |
| DB profit trigger | Pending | Run `update_contract_profit()` trigger SQL in Supabase |
| Unique index on contracts | Pending | Prevent dupe inserts where schwab_transaction_id IS NULL |
| BTC aggregation bug | Pending (PAM) | Auto-BTC fires per STO row — should aggregate to one order per position |
| ETrade options diffs Feb–May | In progress | Equity passes all green; options diffs remain — work through month by month |
| June 8 open_method backfill | Pending | SQL in June 8 session summary to tag today's auto contracts |
| Settlement_date holiday edge cases | Ongoing | Simple T+1/T+2 backfill doesn't know holidays — manually correct as found |
| Reconciliation loop engineering | Pending (PAM) | Monthly GitHub Action to alert on new diffs/regressions |

---

## PAM Task Management

### PAM Database
- **URL:** ghdmvzlfenpmoiyyagqw (Supabase)
- **Table:** `tasks` (not `pam_tasks` — that's the mirror)
- **Valid status values:** `pending`, `in-progress`, `done` (no `cancelled`)
- **Sort order:** multiples of 10, no duplicates
- **Milestones join:** on `name` column (not `title`)

### After Any PAM DB Changes
1. Go to GitHub → Actions → PAM Sync → Run workflow
2. Wait for completion
3. Claude re-queries mirror before next session

### Claude's PAM Access
Claude can only READ from the mirror (`pam_tasks` in PRI). All writes must be given as SQL to run in the PAM database. Claude cannot directly modify PAM.

---

## Session History

| Date | Key Accomplishments |
|------|-------------------|
| June 10, 2026 | Schwab reconciliation working end-to-end (settlement_date on contracts + stock_transactions), equity passes green all 5 months both brokers, ETrade chase fixed (change-order API), auto-BTC fill loop fixed (immediate contract close + filled-order guard), ETrade phantom import fixed (composite fingerprint dedup), 19 new test cases |
| June 8, 2026 | Fixed `contractDryRun` bug (auto-STO working), cross-account BTC matching bug, chase step-down per cycle, false rejection alerts, fill-time contract tagging, reconciliation overhaul (all 15 PDFs loading), 16 new test cases, +$1,906 trading day |
| June 7, 2026 | PAM sync fix, Claude Code batches 1-3, vercel.json created, Schwab re-auth, Jan statements reconciled, 3 PDFs built, session summary + bible created |
| June 5-6, 2026 | DANI Run 4 (9M snapshots, 42 scenarios), Skynet live, market hours bug fixed after-hours orders, PAM sync built, 12 DB tables created |
| May 2026 | Auto-STO/BTC wired, Schwab/ETrade integrations, SAGE scoring model rebuilt, Pushover notifications |
| April 2026 | Initial app build, contract tracking, import tab, dashboard |
