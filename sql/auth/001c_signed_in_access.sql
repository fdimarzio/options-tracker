-- 001c — Let signed-in, allow-listed users reach the tables that only had anon / service_role policies
--
-- STATUS: APPLIED to production on 2026-11-27 (migration "auth_001c_signed_in_access_policies").
-- Rollback: 001c_rollback_signed_in_access.sql
--
-- WHY: the Supabase Auth rollout made the browser sign in as role `authenticated`. 001 added the
-- allow-list functions but only 002 (never applied) created policies for that role. 30 RLS tables had
-- policies for anon / service_role only, so a signed-in user read ZERO ROWS (no error) and could not
-- write: Stocks positions, watchlist, quotes (col_prefs), orders, Skynet rules, signal log, ...
--
-- ADDITIVE ONLY. This is not the lockdown in 002: nothing is removed or revoked, the public anon
-- policies are untouched. Read = allow-listed user; write = admin / trader.
--
-- PERFORMANCE: the checks are wrapped in (select ...) so Postgres evaluates them ONCE PER QUERY.
-- The unwrapped form ran once per row and hit the statement timeout on option_snapshots (~3M rows)
-- in the dry run. Keep the wrapper in any future policy.
--
-- NOTE: col_prefs holds the broker token rows, so allow-listed users can read them. The anon key can
-- already read them; only the lockdown (002) closes that.

do $$
declare t record;
begin
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname
                      and (p.roles::text like '%authenticated%' or p.roles::text like '%public%'))
  loop
    execute format('create policy signed_in_read on public.%I for select to authenticated using ((select public.is_app_user()))', t.relname);
    execute format('create policy signed_in_write on public.%I for all to authenticated using ((select public.app_role()) in (''admin'',''trader'')) with check ((select public.app_role()) in (''admin'',''trader''))', t.relname);
  end loop;
end $$;
