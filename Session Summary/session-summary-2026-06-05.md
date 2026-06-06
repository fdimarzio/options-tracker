# PRI Options Tracker — Session Summary
**Date:** June 3–6, 2026  
**Duration:** Multi-day extended session  
**Participants:** Frank DiMarzio + Claude

---

## Key Principles Established This Session

### Claude Code Commit Pattern
**Always tell Claude Code to make ONE commit at the end with all changes**, not a commit per feature. Example prompt ending:
> "One single commit at the end: 'batch description of all tasks + tests'. Do not commit after each task. Auto-approve all git operations."

### Auto-Rule Testing Framework
Any automated trading rule (auto-STO, auto-BTC, expiry protection, etc.) must have positive and negative test cases before going live. A code change this session broke the market hours gate on auto-BTC, causing after-hours order placement. Test cases prevent this.

---

## Infrastructure Built This Session

### PAM → PRI Sync
- GitHub Actions workflow (`pam-sync.yml`) pulls Deploy Options Trading App project from PAM Supabase (`ghdmvzlfenpmoiyyagqw`) into PRI mirror tables (`pam_tasks`, `pam_milestones`, `pam_projects`) every 4 hours
- Enables Claude to read backlog directly and update task status via SQL

### New Database Tables
| Table | Purpose |
|-------|---------|
| `stock_transactions` | Stock/equity trade history for tax tracking |
| `pam_projects` | Mirror of PAM projects |
| `pam_milestones` | Mirror of PAM milestones |
| `pam_tasks` | Mirror of PAM tasks |
| `rule_config_log` | Auto-snapshots `sto_momentum_config` on every save |
| `skynet_controls` | Max order value, bid/ask deviation, block if loss |
| `ticker_risk_config` | Per-ticker min OTM%, max DTE, IV thresholds, avoid flag |
| `dani_runs` | Log of DANI simulation runs |
| `sim_results` | DANI simulation output per ticker/scenario |
| `sim_summary` | Aggregated DANI simulation summary |

### New DB Columns
- `contracts`: `stop_loss_multiplier`, `time_stop_dte`, `delta_stop`, `last_exit_alert_at`
- `signal_outcomes`: `feedback_at`, `dismissed_reason`
- `stock_transactions`: `contract_id`, `rationale`
- `sto_momentum_config`: `min_iv_pct`

### New DB Triggers
- `trg_snapshot_momentum_config` — snapshots `sto_momentum_config` on every INSERT/UPDATE
- `trg_sync_signal_outcomes` — auto-creates/updates `signal_outcomes` when contract closes

---

## Features Built This Session

### UI / App
- **AllTransactionsTab** — full transaction history with filters for type, account, symbol, date range; summary cards; sortable table
- **Sleep Number widget** — largest position / total portfolio %; green/yellow/red thresholds; on dashboard
- **Skynet + Sleep Number** consolidated to one dashboard row
- **Exit plan fields** on contract detail — stop loss multiplier, time stop DTE, delta stop
- **Thumbs up/down** on signal suggestions → writes to `signal_outcomes.signal_quality`
- **Dismissed reason dropdown** on signal suggestions
- **Totals row** on contracts tab based on active filter
- **Advanced filter** on contracts tab — Call/Put, opt type, strategy, account
- **Wheel P&L view** — groups contracts by `strategy_group_id` where strategy = Wheel
- **Auto-refresh** — 5-minute interval on open contracts, last updated timestamp, on/off toggle
- **Rationale field** on stock transaction BUY rows

### API / Backend
- **Schwab import** extended to pull EQUITY transactions into `stock_transactions`
- **ETrade import** extended to pull EQUITY transactions including dividends, interest, tax withholding
- **Backfill script** `scripts/backfill-stock-transactions.js` — YTD pull from both brokers
- **Pushover notifications** now include profit $ amount alongside %
- **Chase auto-deactivation** fix — `chase_active` set to false on fill
- **IV floor gate** — skip auto-STO if IV < 25% (configurable via `sto_momentum_config.min_iv_pct`)
- **Stop loss disabled for DTE≤3** — contracts with DTE≤3 get `stop_loss_multiplier=null`
- **ticker_risk_config** lookup in scanner — per-ticker OTM%, AVOID flag
- **Expiry protection rule #4** — 3:00 PM ET warning + 3:30 PM ET auto-close; LEAP exclusion (DTE>30 skipped); dry_run=TRUE
- **Auto-BTC wired to signal_rules** — reads `min_profit_pct` from DB instead of hardcode
- **Market hours gate** — ⚠️ DEPLOYED THIS SESSION after after-hours order bug

### Code Quality
- Silent error handling improved across all `api/` files
- Dead code removed
- Hardcoded values flagged with TODO comments

---

## DANI Run 4 — Key Findings

### Simulation Data
- 9 million real options chain snapshots, May 23–June 5 2026
- 42 scenarios tested (8 tickers × 6 profit target/stop loss combinations)

### Top Findings
| Finding | Action |
|---------|--------|
| AMD 13% win rate on covered calls | Set to AVOID in `ticker_risk_config` |
| WDC 36% win rate, net -$11,593 | Set to AVOID in `ticker_risk_config` |
| CEG +$173 EV/trade, 93% win rate | Confirmed in scanner |
| Stop losses HURT on 2-3 DTE | DTE≤3 gets no stop loss |
| 85% target > 65% target | Signal rules updated |
| change_pct strongest SAGE predictor | Weight raised to 1.57 |

### Scoring Weight Changes (DANI Run 4)
| Factor | Old | New |
|--------|-----|-----|
| change_pct | 1.0 | 1.57 |
| ticker_win_rate | 1.0 | 1.39 |
| dte | 1.0 | 1.13 |
| time_of_day | 1.0 | 0.52 |

---

## Critical Bug Fixed — After-Hours Order Placement

**What happened:** Claude Code added auto-BTC wiring to read from signal_rules. The market hours check was missing or broken. After 4:00 PM ET on June 5, the market-refresh cron kept firing and placing BTC orders on AMZN $260 and CEG $275 every 5 minutes.

**Orders placed after hours:**
- Order 108: AMZN BTC $260 — cancelled by broker
- Order 109: CEG BTC $275 — cancelled by broker  
- Order 110: AMZN BTC $260 — submitted (cancel manually)
- Order 111: CEG BTC $275 — cancelled
- Order 112: AMZN BTC $260 — submitted (cancel manually)
- Order 113: CEG BTC $275 — submitted (cancel manually)

**Fix:** Market hours gate added to ALL order placement logic. No orders placed outside 9:30 AM – 4:00 PM ET Monday–Friday.

**Lesson:** Any code change to order placement logic requires market hours test case.

---

## Testing Framework — New Requirement

All auto-trading rules must have positive AND negative test cases:

### Required Test Cases Per Rule
| Rule | Positive Case | Negative Case |
|------|-------------|---------------|
| Auto-BTC | Contract at 85% profit, within market hours → fires | Contract at 85% profit, after 4pm → does NOT fire |
| Auto-STO | Stock meets momentum criteria, market open → fires | Same criteria, pre-market → does NOT fire |
| Expiry protection | STO contract ITM at 3:25 PM on expiry → fires | BTO contract ITM at 3:25 PM → does NOT fire (BTO only) |
| IV floor gate | IV=40% → scans | IV=20% → skips |
| Stop loss DTE | DTE=7, loss=2x → closes | DTE=2, loss=2x → does NOT close |

**PAM task created:** "Add automated test cases for all Skynet auto-rules"

---

## Pending Items Carried Forward

### Needs Your Action
- Run Schwab import to close AMZN $270 and PANW $302.50 expired June 5
- Cancel any remaining after-hours orders in Schwab/ETrade (orders 112, 113)
- Schwab re-auth due June 6 — do first thing tomorrow
- Manually cancel or let expire: AMZN $270 BTO and PANW $302.50 BTO (expired worthless)

### Claude Code Still Pending
- ETrade account value wrong on stocks tab and analytics tab
- Portfolio value not summing all 3 accounts correctly
- Starting balance $6k → $900k fix (partially deployed, ETrade field wrong)
- `scripts/backfill-stock-transactions.js` not yet run

### Research / Deferred
- DANI Run 5 — after 10 more trading days (~June 20)
- Live VIX feed into SAGE scoring
- AMD/WDC as BTO candidates — define rules first
- Podcast/social media sentiment — needs external API strategy
- Treasury liquidity M2, Market edge oscillator, JDPQ — research tasks
- Two cron jobs (1/min 9-11am) — Frank to configure

---

## Session Stats
- **Tasks closed:** ~35+
- **DB migrations:** 12
- **New tables:** 9
- **Files modified:** 8+ (market-refresh.js, schwab-transactions.js, etrade-transactions.js, pri-tod-v3.jsx, pam-sync.js, backfill-stock-transactions.js, schwab-orders.js)
- **DANI runs:** 1 (Run 4)
- **Simulation records:** 42 scenarios across 9M snapshots
