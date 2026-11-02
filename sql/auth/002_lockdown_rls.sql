-- 002 — THE ACTUAL LOCK. DO NOT RUN until all of these are true:
--   [ ] 001 applied and both app_users rows have email + role
--   [ ] new client deployed and you have signed in successfully (claim_app_user bound your row)
--   [ ] Vercel env SUPABASE_SERVICE_KEY is set (server code now prefers it)
--   [ ] GitHub Actions secrets SUPABASE_SERVICE_KEY set (earnings-refresh, monthly-reconcile,
--       watchdog, pam-sync already use it; etrade-auto-auth uses anon + service)
--   [ ] local scripts (scripts/dani-simulation.js, backfill-stock-transactions.js,
--       reconcile-statements.js) run with SUPABASE_SERVICE_KEY exported
--
-- Effect: the public anon key (which ships in the browser bundle) can no longer read or
-- write ANY table. Only signed-in, allow-listed users (role-aware) and the service key.
-- Rollback: sql/auth/002_rollback_open_rls.sql
--
-- Replaces the old "Allow all (USING true)" policies on every table in public (50 of the
-- 57 live policies were USING (true); 9 of 53 tables had RLS disabled entirely — all get RLS).

DO $$
DECLARE t record; p record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'app_users' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t.tablename LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t.tablename);
    END LOOP;
    EXECUTE format('CREATE POLICY app_read  ON public.%I FOR SELECT TO authenticated USING (public.is_app_user())', t.tablename);
    EXECUTE format('CREATE POLICY app_write ON public.%I FOR ALL    TO authenticated USING (public.app_role() IN (''admin'',''trader'')) WITH CHECK (public.app_role() IN (''admin'',''trader''))', t.tablename);
  END LOOP;
END $$;

-- app_users: everyone allow-listed can read the roster; only admins can change it.
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE p record; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='app_users' LOOP
    EXECUTE format('DROP POLICY %I ON public.app_users', p.policyname);
  END LOOP;
END $$;
CREATE POLICY app_users_read  ON public.app_users FOR SELECT TO authenticated USING (public.is_app_user());
CREATE POLICY app_users_admin ON public.app_users FOR ALL    TO authenticated USING (public.app_role() = 'admin') WITH CHECK (public.app_role() = 'admin');

-- Maintenance RPCs (run_snapshot_purge, purge_ticker, update_contract_profit, ...) are
-- currently executable by the anonymous role. Anon keeps nothing; signed-in users and
-- the service key keep access.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon;
GRANT  EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;
