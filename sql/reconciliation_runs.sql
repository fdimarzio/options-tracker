-- sql/reconciliation_runs.sql
-- FOR FRANK — apply manually via the Supabase SQL editor. Not run automatically
-- by any script or CI job in this repo.
--
-- History/result store for the automatic monthly broker reconciliation job
-- (scripts/monthly-reconcile.js, .github/workflows/monthly-reconcile.yml). One
-- row per reconciliation run: the per-account summary, any coverage gaps, and
-- the list of discrepancies that needed review. This is an IDENTIFY-ONLY record
-- — the job never modifies transactions/contracts to force the books to
-- balance; it only writes its findings here so there's a durable, reviewable
-- trail and so each run can diff against the previously reconciled state.

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id            bigserial PRIMARY KEY,
  month         text        NOT NULL,            -- 'YYYY-MM' reconciled
  ran_at        timestamptz NOT NULL DEFAULT now(),
  clean         boolean     NOT NULL DEFAULT false, -- true = everything tied, no gaps
  summary       jsonb,                            -- { scopes:[...], coverageGaps:[...], totals:{...} }
  discrepancies jsonb                             -- ["<label> | MISSING_FROM_APP|...", ...]
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_month
  ON reconciliation_runs (month, ran_at DESC);

ALTER TABLE reconciliation_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON reconciliation_runs;
CREATE POLICY "Allow all" ON reconciliation_runs FOR ALL USING (true) WITH CHECK (true);

-- The job's run-to-run dedup state (so it only alerts on NEW discrepancies) is
-- kept in the existing col_prefs table under id = 'monthly_reconcile_state',
-- the same mechanism the watchdog uses ('watchdog_state') — no extra table.
