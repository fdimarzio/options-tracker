# sql/schema/ — source of truth for versioned DB objects

These files are the **source of truth** for the trigger functions, triggers, and
RLS policies listed below. Any change to one of these objects must land here
first — as a PR, reviewed like any other code change — and then be applied to
the database. Do not edit the database directly and backfill the file later;
do not edit the file without also applying it.

**Why this exists:** on 2026-08-02, `update_contract_profit` was changed
directly in the database (via the Supabase SQL editor, outside version
control) and silently broke P&L calculations app-wide — there was no diff to
review, no record of what changed or why, and no way to tell what the
"correct" version even was until someone diffed the live function against
memory. This directory makes that class of incident structurally harder:
the DB definition is always one `git blame` away from an explanation.

## Files

| File | Objects |
|---|---|
| `update_contract_profit.sql` | `update_contract_profit()` function + `trg_update_contract_profit` trigger on `contracts` |
| `sync_signal_outcomes.sql` | `sync_signal_outcomes_on_contract_close()` function + `trg_sync_signal_outcomes` trigger on `contracts` |
| `purge_option_snapshots.sql` | `purge_option_snapshots_batch()` function + `purge_option_snapshots_backlog()` procedure |
| `rls_policies.sql` | RLS policies for `earnings_dates` and `chase_log` |

## Conventions

- Every statement is idempotent — `CREATE OR REPLACE FUNCTION`/`PROCEDURE`,
  `CREATE OR REPLACE TRIGGER` (Postgres 14+), and for policies (which have no
  `CREATE OR REPLACE`) `DROP POLICY IF EXISTS` followed by `CREATE POLICY`. Any
  file here should be safe to re-run against the live database with no
  side effects if nothing changed.
- One file per object, or a small group of directly-related objects (a trigger
  function + the trigger that calls it, or a feature's set of RLS policies) —
  not one giant schema dump. Keeps diffs and `git blame` meaningful.
- These files were seeded on 2026-08-02 from the exact live definitions
  (`pg_get_functiondef()`, `pg_get_triggerdef()`, `pg_policies`) — not
  reconstructed from memory or from earlier one-off `sql/*.sql` proposal
  files in this repo, some of which had already been superseded by changes
  applied directly to the database (see `purge_option_snapshots.sql`'s header
  for one example). Going forward, this directory is authoritative instead.
- This directory does not yet cover every DB object in the project (tables,
  indexes, other functions/triggers) — it covers what's been touched by
  incidents or recent feature work so far. Expand it as more objects are
  touched, rather than trying to backfill everything at once.

## Applying a change

1. Edit the relevant file here (or add a new one) and open a PR — same CI gate
   as any other change (see `.github/workflows/ci.yml`).
2. Once merged, apply the statement(s) via the Supabase SQL editor (or
   `apply_migration` if you're doing it through an MCP-connected session).
3. If you're touching a trigger function that affects P&L or other financial
   calculations, sanity-check it against the equivalent app-side logic —
   e.g. `update_contract_profit()` here must stay in sync with
   `computeClosePnl()` in `api/_lib/pnl.js`. They're independent
   implementations of the same formula; nothing currently enforces they can't
   drift, which is exactly how the 2026-08-02 incident happened.
