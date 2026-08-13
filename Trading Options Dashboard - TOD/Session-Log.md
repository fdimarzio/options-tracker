# Session Log

Chronological history of development sessions.

---

## August 5, 2026

**Focus:** Scheduler consolidation follow-through, live-bug fixes found during verification, PR #3 merged to production. Full writeup → [[Release-Notes-2026-08-05]].

- **pg_cron purge fix:** 6am run had failed with a statement timeout (batch size 2,000,000) — lowered to 50,000 rows, schedule tightened to every 15 min. Confirmed running clean.
- **GitHub Actions → cron-jobs.org/pg_cron consolidation continued:** removed the redundant `Option Snapshot Purge` Action (pg_cron now sole owner) and slimmed `market-refresh.yml` to just the Schwab keepalive + weekend reconciliation (cron-jobs.org owns the daytime refresh/chain/auto-import curls now). ETrade renew step set `continue-on-error: true`.
- **Two live bugs found while verifying the earlier `iv_history`/`ecosystem_heartbeat` upsert fix:** `portfolio_snapshots` insert was missing `on_conflict=snapshot_date` (409ing ~every 5 min, confirmed in Postgres logs); `trade_orders` select referenced a nonexistent `auto_execute` column, silently breaking Skynet auto-STO `open_method` tagging. Both fixed.
- **`/api/etrade` now classifies failure reason** (token_expired / signature_invalid / consumer_key_invalid / etc.) instead of a bare error string.
- **Deployed:** PR #3 merged into `main` → production, commit `653a44d`. Vercel deploy confirmed live via `version.json` build timestamp.
- **Still open:** Earnings Dates Refresh workflow re-run and Market Refresh token-keeper verification are pending a manual trigger (no authenticated GitHub access from this session). Uncommitted work (`test-skynet-rules.js` Skynet gate change, `reconcile-statements.js` rewrite, schwab service-key swap) deliberately left uncommitted for separate review. See [[Release-Notes-2026-08-05]] for full detail.

## August 3, 2026

**Focus:** Got everything deployed, fixed a blind data pipeline, moved purge to pg_cron, groomed backlog, shipped feature PR #2. Full writeup → [[session-summary-2026-08-03]].

- **Deploy fixed:** Vercel was connected to the wrong repo (`fdimarzio/pam`) → reconnected to `options-tracker`; Jul-8-onward backlog deployed (v1.0.0).
- **Skynet was blind:** Schwab refresh token expired (8am token-keeper failed) → chain/market-refresh 500'ing → no auto-BTC. Fixed by manual Schwab re-auth. See [[Cron-Jobs]].
- **Purge → pg_cron:** DB-native, daily 2am ET, 5-day retention. DB 14 GB → ~7.4 GB.
- **Backlog:** UI/Dashboard + Chase [EPIC] buckets created; done items closed.
- **Feature PR (merged):** covered-call assignment, chase ETrade-cancel routing, LEAPS LTCG UI badge, auto-import notification records, and the equity/All-Transactions import (P11 reversed — it was Frank's own tax-separation spec, safely reversible).
- **July reconciliation:** all three accounts tie within commissions (8222 exact, 6917 +$241, Schwab ~$20 after settlement + INTC assignment). Stored in `reconciliation_results`. See [[Reconciliation]].

## August 2, 2026

**Focus:** Bug-fix batch (cron failures, P&L regression), 2 features shipped, backlog grooming, vault reorg. Full writeup → [[session-summary-2026-08-02]].

- **Cron:** fixed Option Snapshot Purge (never completed; drained 42.5M→15.4M rows, added 4 FK indexes, optimized function; disk reclamation deferred) and Market Refresh duplicate-key inserts (upserts + removed racing workflow). See [[Cron-Jobs]].
- **P&L regression:** root cause was the DB trigger `update_contract_profit` (sign handling dropped ~7/31) — fixed direction-aware; also fixed `profit_pct` units (fraction, UI ×100). Lesson: version-control DB triggers. See [[Database-Schema]].
- **Features:** LEAPS LTCG protection ([[Skynet]] auto-BTC guard, live); earnings-date awareness (`earnings_dates` + FMP, opt-in); worthless-expiration reconciliation; short-put assignment handling (commit 9c16232).
- **[[Chase]]:** made observable (`chase_log` + logging; old loop confirmed deleted → bug 5454 likely resolved).
- **Vault:** tagged all session logs, moved to `Session Logs/`, graph filtered to concepts.

## July 19, 2026

**Focus:** Obsidian vault wired as second brain; full 84-task backlog groomed; P1–13 Claude Code batch shipped.

### Vault / process
- Linked all 15 orphaned session summaries to [[TOD-Overview]] / [[Session-Log]]; added [[START-HERE]] bootstrap note (fresh sessions just need folder access).
- Groomed live PAM backlog → [[Backlog-Groomed-2026-07-19]]; built [[claude-code-prompt-P1-13-2026-07-19]] (per-task what + pos/neg, Golden Rules embedded, single-commit footer).
- Note: DB priority field = `sort_order`; it ranks the Chase epic on top (2–12) — not yet reconciled with the risk-first order we ran.

### P1–13 shipped (single commit)
- **P1 ETrade NAV** — real bug was `carryForward()` filtering non-existent cols (`etrade_value_stale` vs real `etrade_stale`); every fallback silently 400'd. Fixed + hard skip/alert when unresolvable + token-keeper now fails loudly.
- **P2** — Stocks-tab widgets read raw manual `cashData.schwab` instead of the live→snapshot→manual chain; fixed 3 call sites.
- **P3** — open_method verified clean, 0 mismatches, no backfill.
- **P4** — `skynet_controls.master_enabled` master kill-switch + dashboard toggle; fixed latent `?enabled=eq.true` filter hiding the row when false.
- **P5** — settled-funds warn-only via live broker settled-cash (Schwab `cashAvailableForTrading`, ETrade `cashAvailableForInvestment`); never blocks.
- **P6** — old `runSnapshotPurge` had silently stopped 10+ days (cron drift missed its 9:30–9:35 window); replaced with standalone GH Action + RPC-batched delete, size-gated, active-ticker protected.
- **P7** — settlement_date verified on both tables; ETrade has NO settlement field (limits P5 for ETrade).
- **P8** — SQL only.
- **P9** — auto-BTC groups same-position STO rows, one summed order.
- **P10** — Phase A audit only (see below); Phase B deferred.
- **P11** — fixed live cron + reverted an uncommitted working-tree change that had flipped stock import to include ETrade; Schwab-only restored.
- **P12** — skip-BTC-at-expiry existed but hardcoded 2%; moved to DB `signal_rules` row `btc_expiry_skip` (reuses `min_otm_pct`).
- **P13** — `signal_rules` id=5 already gone; nothing to delete.

### Pending Frank actions (as of 2026-07-19)
- **SQL FOR FRANK applied 2026-07-19 (via Cowork):** `master_enabled` col, purge RPCs + config, profit trigger, `btc_expiry_skip` rule (id=7), 19-row NAV backfill, 206-row ETrade delete. **NOT applied:** P8 unique index — blocked by 10 duplicate contract groups (dedup first); `VACUUM ANALYZE option_snapshots` after first purge.
- **Manual ETrade re-auth** at `/api/etrade?action=auth` — token stale since 2026-07-17.
- **PAM task closeout** (14 tasks — see below).

### Follow-ups spun off
- Fill-import matcher (`matchToOpen` in auto-import.js) still closes only one contract row when several share a position — needed to complete P9 end-to-end.
- P10 Phase B: notification cooldown/suppression pending review.
- `sto_suggestion` daily dedup not holding in prod (~7.7×/day/symbol) — likely the two duplicate 5-min Market Refresh workflows racing the read-then-write check. Fix the race (or drop one workflow) before adding a cooldown layer.

---

## July 14, 2026

**Focus:** JPM/OKLO/NVDA auto-STO investigation, open_method regression, portfolio ETrade NAV bug, chase feature analysis

- **JPM auto-STO blocked all day** — root cause: `require_trend: ["bearish","neutral"]` in `signal_rules.momentum_filters`. JPM was strongly bullish (+4.85%). Fix: `UPDATE signal_rules SET momentum_filters = momentum_filters - 'require_trend' WHERE id = 1`
- **OKLO auto-STO fired correctly** (ETrade 8222, 9x $48 Call 2026-07-17) but `open_method=null` — trade_order 297 had `approved_by=skynet_auto_sto` but status=`cancelled` (chase cancelled it). auto-import filters `status=in.(filled,submitted)` — excludes cancelled. Contract 1777730812430 backfilled to `open_method=auto`
- **NVDA open_method=null** — trade_order 298 had no `approved_by` (Schwab path bug). Contract 1777730812427 backfilled to `open_method=auto`
- **Chase fires simultaneously with auto-STO** — chase was monitoring a prior OKLO order, hit floor ($1.47), stopped — same cycle auto-STO fired fresh. Chase also marking new auto-STO trade_orders as cancelled. Frank flagged chase feature may need full rebuild. Logged as PAM bug
- **Portfolio ETrade NAV stuck at $110,558** — `etrade.js` balance handler: `rtv.totalAccountValue` and `rtv.netMv` both absent from ETrade API, fallback `totals.totalMarketValue` also 0, only `cashBal` ($110,558) captured. Snapshot writes once/day on first run — never corrects itself. Real ETrade value ~$475k. June 22 snapshot correctly captured $898k total (only correct day)
- **Code fixes deployed to Claude Code:** (1) `auto-import.js` line 718 — remove `status=in.(filled,submitted)` filter + Schwab `approved_by=skynet_auto_sto` fix, (2) `etrade.js` — broaden NAV field chain + sum positions.marketValue as fallback, (3) `market-refresh.js` — allow snapshot re-run if `etrade_value <= 150000`
- **3 PAM bug tasks entered** for chase, open_method status filter, and ETrade NAV

---

## July 5, 2026

**Focus:** Vault continuation, task validation, portfolio spike fix

### Key Findings
- Confirmed June 22 `portfolio_snapshots` spike: `etrade_value=475,170` (bad), all other June/July rows show 110,558 (correct). Code fix from commit 1a8f185 is working going forward. Manual SQL fix needed for June 22 row.
- `option_snapshots` purge (commit 1a8f185 task #12): NOT running. Still 6,960 MB, 21.7M rows, oldest June 2. PAM task `81d8be7e` still pending. Need to identify action name and trigger manually.
- `ecosystem_heartbeat`: Only two stale entries from May 26 (auto-import, market-refresh) — heartbeat writes appear broken/incomplete even though market-refresh is clearly running (option_snapshots newest = July 3).
- Two PAM tasks marked done June 27 in commit 1a8f185: `5e04d586` (Partial-fill loop) and `7f73b2db` (ETrade auto-STO tagged manual).

### Fix Deployed
- **ETrade IRA balance bug fixed** — `api/etrade.js` was passing `instType: "BROKERAGE"` on the balance API call for IRA accounts, causing ETrade to return 0 NAV. Removed the param. Committed and pushed; Vercel auto-deployed. `portfolio_snapshots` will show real IRA values from next market-refresh.
- Frank manually re-authorizes ETrade OAuth daily via `/api/etrade?action=auth`

### Pending from this session
- option_snapshots purge still not running — investigate action name and trigger manually
- Validate test cases locally (`npm test`)
- Mark PAM tasks done: `5690437c` (portfolio fix), `81d8be7e` (purge) once confirmed

---

## June 10, 2026

**Focus:** Reconciliation + live trading bugs

### Key Accomplishments
- Schwab reconciliation working end-to-end using settlement dates
- `settlement_date` added to both `contracts` (T+1) and `stock_transactions` (T+2)
- All equity passes green ✅ across all 5 months, both brokers
- ETrade chase loop fixed (change-order API — modifies price in place vs Schwab cancel+resubmit)
- Auto-BTC fill loop fixed: immediate contract close on fill + filled-order guard prevents re-firing
- ETrade phantom import fixed: composite fingerprint dedup (stock+opt_type+strike+expires+account+date_exec+premium)
- 19 new test cases

### Bugs Fixed
- Schwab PDF parser (`parseSchwabTotals`): regex, `afterP` logic, `purchMatches`
- ETrade chase loop: no ETrade-specific change-order path
- Auto-BTC: fill detection deferred to auto-import → contract stayed Open, BTC re-fired 30+ times (CAT $930)
- ETrade partial fill guard: qty comparison → tx ID comparison
- ETrade phantom open contract: same trade re-issued with different ID

### Files Changed
- `api/market-refresh.js` — chase ETrade path, fill detection closes contract, BTC guard
- `api/auto-import.js` — skipParentClose, tx ID guard, ETrade fingerprint dedup, settlement_date
- `api/schwab-orders.js` — etrade-change-order action
- `scripts/reconcile-statements.js` — Schwab parser fix, settlement_date queries

---

## June 8, 2026

**Focus:** Auto-STO fix + reconciliation overhaul + +$1,906 trading day

### Key Accomplishments
- Fixed `contractDryRun` bug → auto-STO working (5 STOs fired)
- Day P&L: **+$1,906.20**, 39 contracts
- Cross-account BTC matching bug fixed
- Chase step-down per cycle (not ask-tracking)
- All 15 PDFs loading in reconciliation
- Reconciliation tab added to app
- 16 new test cases

### Bugs Fixed
- `contractDryRun is not defined` → changed to `isDryRun` in STO scope
- Cross-account BTC matching: ETrade cost assigned to Schwab STO
- Chase: stationary ask = no movement → step-down per cycle regardless
- False rejection Pushover alerts during chase cancel/resubmit cycles
- `open_method`/`close_method` set at placement, not fill time

---

## June 2, 2026

- Chase loop (`runChaseLoop()`) added to market-refresh — cancel + resubmit Schwab, modify-in-place for ETrade
- `action=reprice`, `action=chase-start`, `action=chase-stop` added to schwab-orders.js
- `inferStrategy` added to auto-import — auto-assigns strategy on import (OTM Covered Call, Naked Call, etc.)
- Gamified import notifications — cashregister sound for profit, falling for loss
- Watchlist tickers now included in market-refresh snapshot loop
- Monthly Reports tab added to Analytics
- Order detail + reprice UI + Chase modal (🎯 button)
- `price_at_execution` backfill for contracts missing stock price at import
- GitHub Actions token-keeper fixed (was calling non-existent endpoint)
- CLOSE_NOW notification spam fixed (capped to once per 15 min)
- 46 new chase tests; total suite: 316 passing

---

## June 3–6, 2026

**Multi-day session. Major infrastructure build.**

- [[DANI]] Run 4 — 9M snapshots, 42 scenarios; AMD/WDC → AVOID; BTC target 85%; change_pct weight 1.57
- PAM → PRI sync built (GitHub Actions, every 4 hrs)
- 9 new DB tables: `stock_transactions`, PAM mirrors, `rule_config_log`, `skynet_controls`, `ticker_risk_config`, `dani_runs`, `sim_results`, `sim_summary`
- Schwab + ETrade equity import extended to `stock_transactions`
- After-hours order bug: market hours gate was missing after Claude Code auto-BTC wiring — 6 orders placed after 4pm, all cancelled by broker. **Market hours gate now enforced everywhere.**
- All auto-trading rules now require positive + negative test cases
- Stop loss disabled for DTE≤3
- IV floor gate added (skip auto-STO if IV < 25%)
- Expiry protection rule #4 (3pm warning + 3:30pm auto-close, dry_run=true)
- AllTransactionsTab, Sleep Number widget, exit plan fields, thumbs up/down on signals
- ~35 PAM tasks closed

---

## June 7, 2026

- PAM sync fix
- Claude Code batches 1–3
- `vercel.json` created (fixed all `/api/*` 404s)
- Schwab re-auth
- January statements reconciled
- Session summary + App Bible created

---

## June 5–6, 2026

- [[DANI]] Run 4 (9M+ snapshots, 42 scenarios)
- [[Skynet]] went live
- Market hours bug fixed (after-hours orders)
- PAM sync built
- 12 DB tables created

---

## May 30, 2026

- CRON_SECRET rotated — old secret found in git history (`session_summary_20260523.md`)
- [[DANI]] Run 3 — 15 tickers; JPM best risk-adjusted (13.68x EV/Risk, 100% hit rate); optimal exit 80-90%
- MIKE Financial Dashboard rebuilt from scratch (`mike.jsx`) — QuickBooks-style, tabs for Income/Expenses/Rentals/Reports
- Contract decay chart rebuilt (dual-axis: stock price + option decay)
- Plan tab replaced with Watchlist + Opportunities tab
- Top tab bar removed, bottom nav only

---

## May 29, 2026

- [[DANI]] Run 1 — first simulation (3.15M rows, 4 trading days); short DTE 1-3d confirmed highest conviction
- `dani-simulate.js` built
- Momentum + OTM-by-DTE integration: `otm_dte_table` and `momentum_filters` JSONB columns on `signal_rules`
- Accounting mode added to dashboard (cash basis: premium received → open date, cost to close → close date)
- Auto-BTC `auto_execute` bug fixed — LIVE toggle now sets both `dry_run=false` AND `auto_execute=true`
- Partial BTO close fixed in auto-import; premium sign enforcement
- 38 momentum filter tests; total: 275 passing

---

## May 27, 2026

- API consolidation: 12 → 9 Vercel functions (merged schwab-callback, schwab-token-refresh → schwab-auth; schwab-transactions → schwab-orders)
- Momentum system activated — `price_snapshots` table created and writing every 5 min
- BRIA foundation built (`api/bria.js`), GitHub repo created
- Recurring anomaly fix; anomaly dismiss button added
- OTM-by-DTE table and momentum_filters wired into STO scanner
- CRON_SECRET bug: all 4 cron-job.org jobs were using wrong secret, updated

---

## May 23, 2026

- Option chain snapshots (`option_snapshots` table) — 8 OTM + 8 ITM strikes, every market-refresh
- Trend features added to snapshots (vix, sma20/50/200, rsi14, trend_regime, day_of_week)
- [[DANI]] simulation grid expanded to 1,440 variants
- Ecosystem architecture designed — four agents: Options Tracker, PAM, [[BRIA]], [[MIA]]
- Interface tables created: `bria_signals`, `mia_events`, `dani_recommendations`, `ecosystem_heartbeat`
- GEV added as research ticker (always snapshotted)
- OKLO $59 Call assigned ITM (called away)

---

## May 20, 2026

- Backtest (`backtest_v2.js`) — 52 tickers, Black-Scholes premium estimation; overall 81.7% win rate at 2.5% OTM
- SAGE scoring refactored: flag-based risk model; new tables `sage_flags`, `sage_thresholds`, `ticker_tiers`
- Chain data bug fixed — `market-refresh` now calls `fetchLiveChain()` at signal-fire time (not cached)
- Opportunity Scanner tab built — two-pass, scans 52 tickers, streams results
- Strategy linking added — `strategy_group_id` + `strategy_type` on contracts; Wheel P&L view
- Import tab restored as inline component (no longer depends on ImportPage.jsx)
- Supabase RLS security alert received (not yet resolved)

---

## May 18–19, 2026

- Auto-STO went live — first real orders placed (AMZN $270 Call, both accounts)
- [[SAGE]] Attention Scanner rebuilt as live/proactive (no signal history dependency)
- BTO Opportunity Scanner added
- IV Rank / IV Percentile infrastructure — `iv_history` table, `computeAndStoreIVRank()`
- Support/Resistance auto-detection — `computeSupportResistance()`, stores to `support_resistance` table
- `expiry-2pm` auto-closer removed entirely (violated Golden Rule #1 — no `signal_rules` gate)
- API consolidation planned (12 → 9) — schwab-auth.js written but NOT yet deployed

---

## May 16–17, 2026

- Claude API proxy built (`api/claude.js` — 12th and final Vercel function slot)
- Skynet Learning Infrastructure: `signal_outcomes`, `scoring_factors`, `scoring_factor_values`, `scoring_weights`
- Skynet tab renamed 🤖 SKYNET; Signal Rules made a real tab
- Auto-STO scanner in market-refresh (dry_run=true by default)
- Expiry Day Scenario Matrix (8 scenarios)
- SAGE scoring model — full 20-factor infrastructure complete

---

## May 13, 2026

- Positions-driven STO scanner built
- `signal_rules` table created (all trading logic in DB)
- `signal_log` table created (every signal logged)
- `portfolio_snapshots` table — daily account value snapshots
- Portfolio value chart added (SVG line chart, 90-day)
- Signal Log tab added to UI
- Composite fingerprint dedup for ETrade — unstable transaction IDs
- ETrade token auto-renewal cron (every 90 min)

---

## May 2026

- Auto-STO/BTC wired
- Schwab/ETrade integrations
- [[SAGE]] scoring model rebuilt
- Pushover notifications

---

## April 2026

- Initial app build
- Contract tracking
- Import tab
- Dashboard

---

## Session Summary Files

Full write-ups for each session (chronological):

- [[SESSION_SUMMARY_20260513]] — May 13
- [[session_summary_20260516]] — May 15–16
- [[session_summary_20260518]] — May 17–18
- [[session_summary_20260519]] — May 18
- [[session_summary_20260520]] — May 20
- [[session_summary_20260523]] — May 23
- [[session_summary_20260527]] — May 27
- [[session_summary_20260529]] — May 29
- [[session_summary_20260530]] — May 30
- [[session_summary_20260602]] — June 2
- [[session-summary-2026-06-05]] — June 3–6
- [[session-summary-2026-06-07]] — June 7
- [[session-summary-2026-06-08]] — June 8
- [[session-summary-2026-06-10]] — June 10
- [[session-summary-2026-07-17]] — July 17

---

## Related

- [[Known-Issues]] — what's pending from each session
- [[TOD-Overview]]
