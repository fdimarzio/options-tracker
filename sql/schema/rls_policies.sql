-- sql/schema/rls_policies.sql
-- Captured verbatim from the live DB (options-tracker, ufagnokxmetushstgrip) via
-- pg_policies on 2026-08-02. Source of truth going forward — see
-- sql/schema/README.md. Do not edit the DB directly.
--
-- Both tables: RLS enabled, one permissive "Allow all" policy (roles=public,
-- cmd=ALL, qual=true, with_check=true) — same pattern used by every other
-- app-owned table in this project (sage_attention, chase_log's own precedent, etc).
-- These are app-internal tables with no end-user-facing auth model; access control
-- is at the Supabase API-key layer (anon vs service key), not row-level.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE POLICY (Postgres has no
-- CREATE OR REPLACE POLICY) — safe to re-run.

ALTER TABLE public.earnings_dates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.earnings_dates;
CREATE POLICY "Allow all" ON public.earnings_dates FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.chase_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.chase_log;
CREATE POLICY "Allow all" ON public.chase_log FOR ALL USING (true) WITH CHECK (true);
