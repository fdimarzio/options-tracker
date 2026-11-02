-- Emergency rollback for 002: restores the previous wide-open policy on every table.
DO $$
DECLARE t record; p record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t.tablename LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t.tablename);
    END LOOP;
    EXECUTE format('CREATE POLICY "Allow all" ON public.%I FOR ALL USING (true) WITH CHECK (true)', t.tablename);
  END LOOP;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;
