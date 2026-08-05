---
tags: [release, deployment]
---

# Release Notes — August 5, 2026

**PR #3 merged → `main` → production.** Merge commit `653a44d`, deployed via Vercel. Confirmed live: `version.json` build timestamp (`2026-08-05T21:57:13Z`) matches the merge, app loads clean, no console errors.

## Shipped (5 commits)

1. **`bccec53`** — Removed the redundant `Option Snapshot Purge` GitHub Action. pg_cron now owns the purge exclusively (`purge_option_snapshots_batch`, every 15 min, 50k-row batches — batch size lowered from 2M earlier the same session after it caused a statement timeout on the 6am run).
2. **`b917a13`** — Two live bugs found while verifying the `iv_history`/`ecosystem_heartbeat` upsert fix:
   - `portfolio_snapshots` insert was missing `on_conflict=snapshot_date`, causing a live 409 roughly every 5 minutes (confirmed in Postgres logs).
   - `trade_orders` select referenced a nonexistent `auto_execute` column, so PostgREST 400'd the whole query and Skynet auto-STO detection silently never set `open_method=auto`.
3. **`1e019ba`** — `/api/etrade` now classifies *why* a call failed (`token_expired`, `signature_invalid`, `consumer_key_invalid`, etc.) instead of a bare error string.
4. **`58d57b4`** — Connected 3 orphaned vault notes into the graph (`TOD-App-Bible`, `API_Consolidation_TestPlan`, `etrade-portfolio-value-fix-prompt`).
5. **`ee09f22`** — Slimmed `market-refresh.yml`: removed the daytime market-refresh/chain-refresh/auto-import curl job (cron-jobs.org now owns those on matching schedules); kept the Schwab refresh-token keepalive and weekend settlement reconciliation; ETrade renew step set to `continue-on-error: true` since cron-jobs.org's Extend ETrade Token job already covers it.

762–770 tests passing throughout (test count grew as workflow-source assertions were updated to match the new state).

## Verification status (as of this note)

| Item | Status |
|---|---|
| Vercel production deploy | ✅ Confirmed live |
| Earnings Dates Refresh | ⚠️ Still failing as of last check (4/4 runs, missing `FMP_API_KEY`). Secret now set — re-run pending, needs a manual "Run workflow" trigger since this session had no authenticated GitHub access to trigger it directly. |
| Market Refresh (slimmed workflow) | ⏳ Not yet exercised — no run since the merge. Next scheduled fire ~11:50pm ET tonight or 8am ET tomorrow. |

## Explicitly NOT in this release

Left uncommitted in the working tree for separate review — not part of this deploy:

- **`scripts/test-skynet-rules.js`** — edits a Skynet gate test to assume an "IV floor removed, `min_premium` gate instead" change, but no matching change exists in `api/market-refresh.js`. Possibly unfinished/orphaned work on the auto-trade path.
- **`scripts/reconcile-statements.js`** — a substantial (789-line) rewrite of the offline broker-statement reconciliation tool.
- **`api/schwab-auth.js`, `api/schwab-proxy.js`, `api/chain-refresh.js`, `api/oi-tracker.js`** — a coherent anon-key → service-key swap for `schwab_tokens`/`col_prefs` reads/writes. Looks complete and low-risk, just uncommitted.

## Related

[[Session-Log]] [[Cron-Jobs]] [[Known-Issues]]
