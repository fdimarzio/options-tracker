-- 003 — Backfill stock_user_settings from the legacy fields inside col_prefs 'stocks_data'
--
-- STATUS: NOT APPLIED. Run AFTER 002 and BEFORE deploying the new code.
-- Idempotent (ON CONFLICT DO NOTHING) — safe to re-run; it never overwrites a row that
-- already exists in stock_user_settings. It does NOT modify or delete anything in
-- col_prefs: the legacy fields are left in the blob so a rollback is possible.
--
-- MAPPING (explicit opt-in)
--   autoSto = true          -> auto_sto = true
--   autoSto = false / unset -> auto_sto = false
--   earningsDate 'YYYY-MM-DD' -> earnings_date;   iv numeric -> iv_manual
-- Consequence you should expect: any ticker that was auto-STO-eligible only because
-- autoSto was NEVER SET (old behaviour: eligible by default) will NOT be eligible after
-- this migration until you switch it on in the Stocks tab. That is the intended
-- change. To instead preserve today's effective eligibility, run the OPTIONAL block at
-- the bottom. (AMD currently has autoSto=false in the blob, so it backfills as false.)

-- ── 0. PREVIEW (read-only) — what will be inserted? ───────────────────────────
-- select upper(e.key) as ticker,
--        coalesce((e.value->>'autoSto') = 'true', false) as auto_sto,
--        e.value->>'earningsDate' as earnings_date, e.value->>'iv' as iv_manual
-- from public.col_prefs c, jsonb_each(c.cols) e
-- where c.id = 'stocks_data' and e.key <> '__cash__' and jsonb_typeof(e.value) = 'object'
--   and (e.value ? 'autoSto' or nullif(e.value->>'earningsDate','') is not null or nullif(e.value->>'iv','') is not null)
-- order by 1;

-- ── 1. Backfill (row-by-row so one bad value cannot abort the whole migration) ─
do $$
declare
  r         record;
  v_date    date;
  v_iv      numeric;
  inserted  int := 0;
  skipped   int := 0;
begin
  for r in
    select upper(e.key) as ticker, e.value as v
    from public.col_prefs c, jsonb_each(c.cols) e
    where c.id = 'stocks_data'
      and e.key <> '__cash__'
      and jsonb_typeof(e.value) = 'object'
      and (e.value ? 'autoSto'
           or nullif(e.value->>'earningsDate', '') is not null
           or nullif(e.value->>'iv', '') is not null)
  loop
    begin
      v_date := case when r.v->>'earningsDate' ~ '^\d{4}-\d{2}-\d{2}$' then (r.v->>'earningsDate')::date end;
      v_iv   := case when r.v->>'iv' ~ '^\d+(\.\d+)?$'               then (r.v->>'iv')::numeric end;

      insert into public.stock_user_settings (ticker, auto_sto, earnings_date, iv_manual)
      values (r.ticker, coalesce((r.v->>'autoSto') = 'true', false), v_date, v_iv)
      on conflict (ticker) do nothing;

      if found then inserted := inserted + 1; end if;
    exception when others then
      skipped := skipped + 1;
      raise notice 'stock_user_settings backfill SKIPPED % (%): %', r.ticker, sqlstate, sqlerrm;
    end;
  end loop;
  raise notice 'stock_user_settings backfill: % inserted, % skipped (existing rows are left untouched)', inserted, skipped;
end $$;

-- ── 2. Verification ───────────────────────────────────────────────────────────
-- select ticker, auto_sto, earnings_date, iv_manual from public.stock_user_settings order by ticker;
--
-- Every ticker that has autoSto=true in the blob must be auto_sto=true here (expect 0 rows):
-- select upper(e.key) from public.col_prefs c, jsonb_each(c.cols) e
-- where c.id = 'stocks_data' and e.key <> '__cash__' and jsonb_typeof(e.value) = 'object'
--   and (e.value->>'autoSto') = 'true'
--   and not exists (select 1 from public.stock_user_settings s where s.ticker = upper(e.key) and s.auto_sto);
--
-- Tickers that WERE eligible under the old default (>=100 shares, autoSto not false) but are NOT opted in now:
-- select upper(e.key) as ticker,
--        coalesce((select sum(v::numeric) from jsonb_each_text(e.value->'sharesByAcct') x(k, v)), (e.value->>'shares')::numeric, 0) as shares
-- from public.col_prefs c, jsonb_each(c.cols) e
-- where c.id = 'stocks_data' and e.key <> '__cash__' and jsonb_typeof(e.value) = 'object'
--   and (e.value->>'autoSto') is distinct from 'false'
--   and not exists (select 1 from public.stock_user_settings s where s.ticker = upper(e.key) and s.auto_sto)
--   and coalesce((select sum(v::numeric) from jsonb_each_text(e.value->'sharesByAcct') x(k, v)), (e.value->>'shares')::numeric, 0) >= 100
-- order by 1;

-- ── 3. OPTIONAL — preserve the OLD effective eligibility (uncomment to use) ───
-- Opts in every held ticker (>= 100 shares) that the old rule would have traded, i.e. autoSto was not an explicit false.
-- insert into public.stock_user_settings (ticker, auto_sto)
-- select upper(e.key), true
-- from public.col_prefs c, jsonb_each(c.cols) e
-- where c.id = 'stocks_data' and e.key <> '__cash__' and jsonb_typeof(e.value) = 'object'
--   and (e.value->>'autoSto') is distinct from 'false'
--   and coalesce((select sum(v::numeric) from jsonb_each_text(e.value->'sharesByAcct') x(k, v)), (e.value->>'shares')::numeric, 0) >= 100
--   and upper(e.key) ~ '^[A-Z0-9.-]{1,12}$'
-- on conflict (ticker) do update set auto_sto = true;
