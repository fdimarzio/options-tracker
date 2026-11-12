-- Rollback for 002 + 003. NOT APPLIED.
--
-- Use only if you are also reverting the application code to the pre-stock_user_settings
-- release (which reads autoSto / earningsDate / iv from the stocks_data blob).
--
-- Step 1 copies the current settings BACK into the blob so the old code sees them.
-- NOTE: the old code treated "never set" as eligible and only an explicit false as opted
-- out. Rows backfilled as auto_sto=false therefore become explicit opt-outs again — the
-- conservative direction (fewer auto-STOs than before, never more). Re-enable per ticker.
-- Step 2 drops the table. Export it first if you may want the data:  select * from public.stock_user_settings;

begin;

update public.col_prefs c
set cols = (
      select c.cols || coalesce(jsonb_object_agg(
               s.ticker,
               coalesce(c.cols -> s.ticker, '{}'::jsonb)
                 || jsonb_build_object('autoSto', s.auto_sto)
                 || case when s.earnings_date is not null then jsonb_build_object('earningsDate', s.earnings_date::text) else '{}'::jsonb end
                 || case when s.iv_manual     is not null then jsonb_build_object('iv', s.iv_manual)                     else '{}'::jsonb end
             ), '{}'::jsonb)
      from public.stock_user_settings s
    ),
    updated_at = now()
where c.id = 'stocks_data';

drop trigger  if exists stock_user_settings_touch_trg on public.stock_user_settings;
drop function if exists public.stock_user_settings_touch();
drop table    if exists public.stock_user_settings;

commit;
