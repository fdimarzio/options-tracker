# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/) — see `docs/RELEASING.md` for the
bump-on-release process.

## [Unreleased]

## [1.1.0] - 2026-10-01

Bundles everything landed on `main` since v1.0.0 (2026-08-02): a watchdog for
the scheduled-job ecosystem, the earnings-refresh move to Finnhub, snapshot-alert
de-noising, covered-call/chase/LEAPS work merged from the feature branch, and the
Schwab realized-G/L reconciliation fixes to the auto-importer.

### Added
- Watchdog (Phase 1 + 2a): a health monitor over the scheduled-job ecosystem —
  flags stale/failed cron jobs and stale data, with per-job heartbeats for
  chain-refresh, chase, and extend-etrade-token (plus checks and tests).
- Covered-call assignment handling, chase-engine ETrade cancel routing, and
  LEAPS long-term-cap-gains surfacing in the UI.
- Earnings heads-up: a Pushover alert when a covered name's earnings is within
  10 days.
- Auto-import Pushover notifications now list the actual imported records
  instead of a bare count.
- Completed the `stock_transactions` ledger (resolves P11): ETrade equity flows
  in guarded by account, plus FEE handling and a since-date backfill.
- Chain-refresh and auto-STO universe is now derived from current holdings
  rather than manual per-symbol flags.
- ETrade failure-reason classification (token_expired / signature_invalid /
  consumer_key_rejected) so outages are diagnosable.

### Changed
- earnings-refresh: switched from the (now fully gated) FMP calendar to
  Finnhub's free earnings calendar, queried per-symbol.
- Trimmed `market-refresh.yml` to only what cron-jobs.org doesn't cover and
  removed a redundant GitHub Actions option-snapshot purge.

### Fixed
- The recurring ~6am "Portfolio snapshot stale" false alarm: suppress the
  expected morning ETrade-stale window, and stop the prior-snapshot lookup from
  re-reading today's own just-written row on morning re-runs.
- earnings-refresh silently no-op'd on a dead FMP endpoint; added a fail-loud
  guard.
- LEAP-protection alert spam (dedup + logging + cooldown-rule coverage); LEAP
  threshold corrected to ≥365 DTE and `entry_dte` always populated on import.
- ETrade snapshot freeze: stale-baseline outlier guard + balance NAV fallback,
  and stray/empty accounts no longer stale the whole snapshot.
- Idempotent `portfolio_snapshots` upsert + `trade_orders` open_method
  detection.
- auto-import equity parser attributed the wrong symbol (CURRENCY_USD cash leg
  instead of the security) on Schwab TRADEs; 12 historical rows corrected.
- auto-import silently dropped equity TRADEs with no recognized security item
  (lost the 2026-06-11 PANW/TKO/UPS sells); now logged to import_anomalies.
- BTC/STC closer rows no longer carry realized profit/close_date — P&L lives
  solely on the parent opener, preventing double-counts in ad-hoc queries.

### Data
- Backfilled 3 missing Schwab sells (2026-06-11); relabeled 7 CURRENCY_USD
  rows; nulled profit on 50 historical closer rows.

## [1.0.0] - 2026-08-02

Baseline release — bundles the fixes and features shipped 2026-08-01 through
2026-08-02, plus the SDLC guardrails (CI gate, versioned DB schema, semver,
rollback/release docs) added in this same release.

### Added
- LEAPS long-term-cap-gains guard: a contract opened with >365 DTE is never
  auto-closed by the Skynet BTC scanner on a routine profit-threshold hit,
  even once its remaining DTE has dropped well below 365.
- Earnings-date awareness: Skynet's STO scanners now exclude candidate
  expiries on/after a symbol's next earnings date (configurable buffer),
  refreshed nightly from a market-data provider.
- Chase engine observability: every chase step now logs to a queryable
  `chase_log` table (order id, symbol, side, price before/after, bound, step
  #, market-guard results, outcome, dry_run) instead of being invisible
  between Pushover notifications.
- Automatic short-put assignment detection: a broker EQUITY BUY matching an
  open short put's strike/quantity/timing now closes the put and links the
  share purchase automatically, instead of requiring manual reconciliation.
- Unified notification cooldown (CLOSE_NOW / itm_warning / sto_suggestion) —
  configurable via a `signal_rules` row, default 60 minutes — replacing three
  separate ad-hoc dedup mechanisms.
- Weekend settlement reconciliation: the import job now runs Saturday and
  Sunday mornings, and its transaction-fetch window covers the actual gap
  since the last run instead of a fixed "today"/"yesterday" window, so a
  Friday-expiry assignment or worthless close settling over the weekend is no
  longer missed.
- CI gate (`.github/workflows/ci.yml`): every PR into `main` runs the full
  Vitest suite, `node --check` on changed `api/*.js` files, and an esbuild
  syntax check on changed `.jsx` files. Manual step for repo settings (branch
  protection requiring this check) is not part of this change — see the PR
  description.
- `sql/schema/`: version-controlled source of truth for DB triggers,
  functions, and RLS policies that were previously only live in the
  database — see `sql/schema/README.md` for why.
- Semantic versioning: `package.json` now carries a version, surfaced in the
  app's menu footer and regenerated into `public/version.json` at build time.
- `docs/ROLLBACK.md` and `docs/RELEASING.md`.

### Fixed
- Long (BTO) closed-position profit/profit_pct was computed with the wrong
  sign/formula for long positions (correct only for shorts) in three
  separate close paths; consolidated behind one shared, direction-aware
  helper (`computeClosePnl`).
- Market Refresh's `iv_history` and `ecosystem_heartbeat` upserts were
  missing the `on_conflict` target needed for PostgREST's merge-duplicates
  resolution to hit the real unique constraint instead of the primary key,
  so re-runs 409'd instead of updating; also removed a duplicate GitHub
  Actions workflow that was racing the real one on the same 5-minute cron.
- Option Snapshot Purge timed out on every run (500k-row batches); reduced
  to 20k-row batches with retention-based protection for referenced
  snapshots moved into the DB function itself.
