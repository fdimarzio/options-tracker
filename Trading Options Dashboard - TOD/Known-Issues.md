# Known Issues & Deferred Items

Last updated: September 16, 2026

---

## 🔴 Current (2026-09-15) · see [[Session-Log]]

| Item | Status | Notes |
|------|--------|-------|
| ETrade snapshot 65-day freeze (2026-09-17) | ✅ fixed | `portfolio_snapshots.etrade_value` stuck at $110,558 (`etrade_stale=true`) for 65 days while real NAV was ~$487K. Root cause: the outlier guard (`api/market-refresh.js` ~L3173) compared each fresh pull against the *prior* snapshot's `total_value` without checking whether that prior value was itself stale — once one bad pull got carried forward, every correct fresh pull afterward looked like a >15% outlier vs. the stale baseline and got carried forward again, a self-perpetuating lock. Fix: guard now also requires the prior row's `etrade_stale` to be `false` before it fires. Also hardened `api/etrade.js` `action=balance` to fall back to positions+cash (same as `action=positions`) instead of throwing when the NAV field is missing. Today's row was corrected manually in the DB. Regression tests: `tests/etrade-snapshot-unfreeze.test.js`. Could not confirm from Vercel logs which exact path fired historically (CLI unauthenticated, non-interactive session) — the outlier-guard self-lock is the confirmed cause by code inspection; the `action=balance` fallback is defensive/may be moot. |
| Aug 17 pipeline outage | ✅ recovered | Schwab 7-day token expired → market/chain-refresh + Skynet dead 12 days; cron-jobs.org auto-disabled the jobs. Fixed via manual re-enable + Schwab re-auth. Pipeline healthy 9/15. See [[Cron-Jobs]] |
| Vacation transaction backlog | ✅ contracts reconciled (9/16) | **All stranded legs now Closed** — JPM $355 & $367.5 legs reconciled to their Schwab BTCs (9/16 open+Aug-closed pass). Aug closed set audited: 0 mismatches, realized +$17,629.96. See [[Reconciliation]]. **`import_anomalies` still 60 unresolved** — separate anomaly pass still owed. PAM `ef68bb0f` |
| Importer split-fill bug 🐛 | 🆕 bug (high) | Multi-lot BTC split fills close ONE leg, create a qty-2 BTC row, and leave the sibling leg **Open/garbled** ("Split fill merged" + "Remaining 1 of 2"). Stranded both JPM $355 (id ...592) & $367.5 (id ...542) — both fixed 9/16. No other legs left *Open* (checked); pattern recurs across Jun/Jul closed history. Fix `matchToOpen`/split-fill handler. PAM `7ec20868`; full-history audit PAM `6b7c9111` |
| Earnings Dates Refresh | ⚠️ still broken | `earnings_dates` = 0 rows. `FMP_API_KEY` must be a **GitHub Actions secret** (was set in Vercel = wrong place); may also need a paid FMP tier. PAM `50a7c7c5` |
| DB orphaned disk | ⚠️ support ticket | `VACUUM FULL` reclaimed real bloat (data ~45 MB on 8/30); DB now **5.06 GB** (new snapshots + orphaned files). Orphaned files need a Supabase support ticket. Cost-only. PAM `ab83a88b`; blocks cost-lowering `e0e52f86` |
| Dynamic ticker universe | ✅ merged & live | `deriveTickerUniverse()` live (PR #4). Dry-run path proven safe (PR #5). **Watch the first REAL Schwab `sto_auto` fill** (none confirmed yet). PAM `5095bc5b` |
| LEAP-protect alert spam | ✅ resolved | Fixed + deployed (PR #6, `dfc211d`): notifications_sent dedup → alerts once/day. Confirmed 9/15: `signal_log` has `leap_protection` rows, dedup key present, WDC alerted 1×/6h. PAM `e7b6a4bc` |
| Broker re-auth automation | 🆕 planned (med) | Root-cause fix for the outage — ETrade daily / Schwab weekly. PAM `ff25f8cc` + harden `a189a5cc` |
| Chase feature | 🔶 scaffolded, disabled | Rule `enabled=false, dry_run=true`. Build sequence: engine → resolver → safety toggles → tests → dry-run validation → go-live. Epic PAM `6d306a7b` |
| Resolved & closed this session | ✅ | Two-cron-jobs, Market-Refresh token-keeper, git-remote corruption, VACUUM, LEAPS-protect (live), disk reclamation (data-level), LEAP alert spam, dynamic universe |
| Uncommitted working-tree pile | ⚠️ review | ~116 uncommitted/untracked items (deleted Session Summary docs, modified `.github/workflows/` + `api/`/`scripts/`, vault, statement PDFs) — some touch the trading path (PAM `97aa5c34`, `f4844faa`, `395512df`). Selective commit only — do NOT blanket-commit |

---

## ✅ Resolved 2026-07-19 (P1–13 batch — see [[Session-Log]] · [[Backlog-Groomed-2026-07-19]])

| Item | Notes |
|------|-------|
| ETrade NAV freeze (P1) | Root cause: `carryForward()` filtered non-existent cols (`etrade_value_stale`). Fixed + skip/alert. Backfill SQL pending (19 rows) |
| Analytics ~$6k total (P2) | Stocks-tab widgets read raw manual `cashData`; fixed to live→snapshot→manual chain |
| open_method regression (P3) | Verified clean, 0 mismatches |
| Auto-BTC aggregation (P9) | Groups same-position STO rows → one order (see fill-import follow-up below) |
| option_snapshots purge (P6) | Old job silently dead 10+ days; rebuilt as GH Action. Purge-RPC SQL pending |
| Schwab-only stock import (P11) | Restored + reverted stray ETrade-include change. ETrade backfill DELETE pending (206 rows) |
| Skip-BTC-at-expiry (P12) | Moved from hardcoded 2% to DB `signal_rules` row. Insert SQL pending |
| settlement_date (P7) | Verified present on both tables (ETrade has no settlement field) |
| signal_rules id=5 (P13) | Already gone — nothing to delete |

## ⚠️ New / Pending from 2026-07-19

| Item | Notes |
|------|-------|
| ✅ SQL FOR FRANK applied 2026-07-19 | `master_enabled` col, purge RPCs + config row, profit trigger, `btc_expiry_skip` rule (id=7), P1 backfill (19 rows stale), P11 ETrade delete (206 rows) — all run via Cowork |
| ⚠️ P8 unique index NOT applied | 10 pre-existing duplicate contract groups (`schwab_transaction_id IS NULL`) block the unique index — **dedup those 10 groups first, then create the index**. Also run `VACUUM ANALYZE option_snapshots` after the first purge fires |
| **ETrade re-auth** | Token stale since 7/17 — hit `/api/etrade?action=auth` |
| Skynet master kill-switch (P4) | Shipped; inert until `skynet_controls.master_enabled` SQL is run |
| Settled Funds warn-only (P5) | Shipped; ETrade lacks a settlement-date field so ETrade settled-cash uses broker field only |
| DB profit trigger + unique index (P8) | SQL ready — run in Supabase |
| Fill-import matcher (PAM `650f734d`) | `matchToOpen` in auto-import.js closes only one contract row per shared position — completes P9 end-to-end |
| Notifications | P10 Phase B (cooldown, PAM `6f59a67a`) pending; `sto_suggestion` daily dedup not holding ~7.7×/day (PAM `666ad1b1`) — likely duplicate cron race |
| Duplicate Market Refresh workflows | Both fire every 5 min — left untouched pending [[DANI]] Run 5 |
| Top-bar master kill-switch | Added to the sticky TOPBAR (🟢 AUTO ON / 🔴 AUTO OFF, every tab). Code in working tree `src/pri-tod-v3.jsx` (23 insertions), esbuild-validated. Sandbox lacks GitHub creds — **commit + push from Frank's machine to deploy** |

---

## Blocked

| Issue | Notes |
|-------|-------|
| ETrade `signature_invalid` | Needs phone reset — call 1-800-387-2331, consumer key starts `5974003f` |

---

## Pending (PAM)

| Issue | Notes |
|-------|-------|
| BTC aggregation bug | Auto-BTC fires once per STO row instead of aggregating → multiple orders for fragmented positions |
| Reconciliation loop engineering | Monthly GitHub Action to alert on new diffs/regressions |
| Chase feature rebuild | Chase fires simultaneously with auto-STO (no shared state), may cancel newly placed auto-STO orders. OKLO trade_order 297 ended up `cancelled` — believed caused by chase. Frank flagged full rebuild needed |
| open_method status filter bug | `auto-import.js` line 718 filtered `status=in.(filled,submitted)` — cancelled auto-STO trade_orders skipped. Fix deployed (status filter removed). Also: Schwab auto-STO path missing `approved_by=skynet_auto_sto` tag — fix deployed |

---

## Pending (Code / DB)

| Issue | Notes |
|-------|-------|
| ETrade balance backfill | `portfolio_snapshots` June 23–July 14 have stale `etrade_value=110558`. Fix deployed to `etrade.js` + `market-refresh.js` (staleness re-run threshold ≤$150k). Will self-correct going forward. Historical rows need backfill once correct ETrade value confirmed |
| option_snapshots purge not running | 6.96 GB, 21.7M rows, oldest June 2. Code committed in 1a8f185 but purge hasn't executed. Check trigger/action name and fire manually. PAM: `81d8be7e` |
| DB profit trigger | Run `update_contract_profit()` trigger SQL in Supabase — see [[Database-Schema]] |
| Unique index on contracts | Prevent dupe inserts where `schwab_transaction_id IS NULL` — see [[Database-Schema]] |
| June 8 open_method backfill | SQL in June 8 session summary to tag today's auto contracts |
| ETrade options diffs Feb–May | Equity passes green; work through options diffs month by month — see [[Reconciliation]] |
| Settlement_date holiday edge cases | Simple T+1/T+2 backfill doesn't know holidays — correct manually as found |
| Two cron jobs (1/min) | Wait for [[DANI]] Run 5 to validate 9:30–10:30am window first |

---

## Dry Run (Not Yet Live)

| Item | Status | Notes |
|------|--------|-------|
| ITM expiry auto-close | dry_run=true | Wait for first dry_run to fire before going live |

---

## Deferred (Lower Priority)

| Issue | Notes |
|-------|-------|
| MIKE deployment | Deployed but empty — needs backfill + reconciliation first |
| BRIA agent | Built — env vars not configured in Vercel |
| RLS col_prefs | SUPABASE_SERVICE_KEY not loading correctly post-deploy |
| getAccountHash bug | Orders 82/83/86/96 stuck as submitted not filled |
| ETrade env var VITE_ prefix | Backfill script needs `ETRADE_*` not `VITE_ETRADE_*` |

---

## Related

- [[Session-Log]] — when each issue was introduced/fixed
- [[Skynet]] — trading automation issues
- [[Reconciliation]] — recon-specific issues
- [[Database-Schema]] — pending schema items
