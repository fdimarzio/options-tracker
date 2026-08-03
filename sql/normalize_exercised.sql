-- sql/normalize_exercised.sql
-- FOR FRANK — apply manually via the Supabase SQL editor. Not run automatically
-- by any script or CI job in this repo.
--
-- contracts.exercised currently holds a mix of 'Yes' / 'true' / 'No' / null. The
-- 'true' (boolean-as-text) values came from api/auto-import.js's handleAssignment()
-- writing a raw JS boolean `true` instead of the string 'Yes' the rest of the app
-- uses (UI dropdowns, parseEtradeTx, parseSchwabEquityTx-derived inserts) — now
-- fixed going forward in the same change that adds short-put assignment detection.
-- This backfills existing rows to just 'Yes' / 'No'. Idempotent — safe to re-run.

UPDATE contracts SET exercised = 'Yes'
WHERE exercised IN ('true', 'True', 'TRUE', 'yes', 'YES')
  AND exercised IS DISTINCT FROM 'Yes';

UPDATE contracts SET exercised = 'No'
WHERE (exercised IS NULL OR exercised NOT IN ('Yes'))
  AND exercised IS DISTINCT FROM 'No';
