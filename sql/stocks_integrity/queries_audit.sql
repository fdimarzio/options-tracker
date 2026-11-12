-- Example investigation queries for public.col_prefs_audit (see 001_audit_col_prefs.sql).
-- Read-only. Run in the Supabase SQL editor as a project admin.

-- 1. The question that started this: who changed autoSto, and from what to what? (last 30 days)
select changed_at, ticker, old_values->'autoSto' as was, new_values->'autoSto' as now,
       jwt_role, jwt_sub, db_user
from public.col_prefs_audit
where pref_id = 'stocks_data' and 'autoSto' = any (changed_fields)
  and changed_at > now() - interval '30 days'
order by changed_at desc;

-- 2. History of one ticker (every watched field)
select changed_at, op, changed_fields, old_values, new_values, jwt_role
from public.col_prefs_audit
where pref_id = 'stocks_data' and ticker = 'AMD'
order by changed_at desc
limit 50;

-- 3. WHO is writing user-owned fields? (browser vs server) — per day, last 14 days.
--    After the stocks_data integrity change, user fields should only ever come from
--    authenticated users (or nothing once they move to stock_user_settings).
select date_trunc('day', changed_at)::date as day, coalesce(jwt_role, '(direct sql)') as writer, count(*) as changes
from public.col_prefs_audit
where pref_id = 'stocks_data'
  and changed_fields && array['autoSto','earningsDate','iv']
  and changed_at > now() - interval '14 days'
group by 1, 2
order by 1 desc, 2;

-- 4. Whole-blob overwrite detector: writes that REMOVED tickers (stale/partial blob upserts)
select changed_at, jwt_role, jwt_sub,
       (old_values->>'count')::int as tickers_before, (new_values->>'count')::int as tickers_after,
       old_values->'removed' as removed_tickers
from public.col_prefs_audit
where note = 'blob_shrank'
order by changed_at desc
limit 50;

-- 5. Share-count changes (who moved a position count, and was it the server?)
select changed_at, ticker, old_values->'shares' as was, new_values->'shares' as now, jwt_role
from public.col_prefs_audit
where pref_id = 'stocks_data' and 'shares' = any (changed_fields)
order by changed_at desc
limit 100;

-- 6. Any write from the PUBLIC anon key (should be zero once sql/auth/002_lockdown_rls.sql is applied)
select changed_at, pref_id, ticker, changed_fields
from public.col_prefs_audit
where jwt_role = 'anon'
order by changed_at desc
limit 100;

-- 7. Sanity: tokens must never appear here (expect 0)
select count(*) as token_rows_audited
from public.col_prefs_audit
where pref_id in ('schwab_tokens', 'etrade_tokens');
