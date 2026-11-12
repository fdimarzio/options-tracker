-- 003 — Seed stock_user_settings from the legacy fields inside col_prefs 'stocks_data',
--       PRESERVING TODAY'S PRODUCTION AUTO-STO BEHAVIOR
--
-- STATUS: NOT APPLIED. Run AFTER 002 and BEFORE deploying the new code.
-- Idempotent (ON CONFLICT DO NOTHING): safe to re-run; never overwrites an existing
-- stock_user_settings row. Does NOT modify or delete anything in col_prefs — the legacy
-- fields stay in the blob so a rollback is possible.
--
-- THE PROBLEM THIS SOLVES
--   Old rule (what production does today, api/_lib/tickerUniverse.js before this change):
--       eligible  <=>  total shares >= 100  AND  autoSto is NOT explicitly false
--     i.e. "never set" counted as eligible.
--   New rule (explicit opt-in):
--       eligible  <=>  total shares >= 100  AND  stock_user_settings.auto_sto = true
--     auto_sto = false, NULL, or no row  =>  not eligible.
--   Flipping the rule without seeding would silently stop trading every ticker whose
--   autoSto was never set. So this migration SEEDS exactly the symbols that are eligible
--   today:
--
--       auto_sto := (autoSto = true)                                   -- explicit yes, carried over
--                   OR (seed_legacy_eligibility
--                       AND autoSto IS DISTINCT FROM false              -- not explicitly opted out
--                       AND total_shares >= 100)                        -- same share rule as the scanner
--
--   autoSto = false stays false. Tickers below 100 shares with no explicit true get no row.
--   total_shares mirrors tickerUniverse.totalShares(): sum(sharesByAcct) when that object is
--   non-empty, otherwise `shares`.
--
--   Snapshot of production on 2026-11-11 (read-only query) — this seeds exactly these 10 as
--   auto_sto = true:  AAPL, AMZN, CAT, CEG, JPM, MCD, NVDA, SPCX, TSLA, WDC
--   (AAPL/AMZN/CAT/CEG/JPM/NVDA/WDC are explicit true; MCD/SPCX/TSLA are "never set" with
--    exactly 100 shares). AMD has autoSto=false in the blob and stays false. OKLO is explicit
--    true with 1 share: carried over as true (harmless — the scanner still needs >= 100 shares).
--   The set is recomputed from the blob at run time, so use the PREVIEW below right before running.
--
--   To seed ONLY explicit trues (strict opt-in, nothing inferred) set seed_legacy_eligibility := false.
--
-- !! RUN THIS WHILE ETRADE POSITIONS ARE POPULATED !!  Overnight, ETrade's token expires and
-- market-refresh zeroes every ETrade-held ticker's shares in the blob. Seeding then misses
-- ETrade-only names that have no explicit autoSto (this happened on 2026-11-12: MCD and SPCX were
-- missed and had to be added by 003b_seed_etrade_only_symbols.sql). Before running, check that
-- ETrade-held tickers show shares > 0 in the PREVIEW below.
--
-- NOTE ON AMD: the blob says false (the UI toggle never persisted — that is the original bug).
-- If you want it on, switch it on in the Stocks tab after the new code is deployed.

-- ── 0. PREVIEW (read-only) — exactly what step 1 will write ───────────────────
-- with t as (
--   select upper(e.key) as ticker, e.value as v,
--          case when jsonb_typeof(e.value->'sharesByAcct') = 'object' and e.value->'sharesByAcct' <> '{}'::jsonb
--               then (select coalesce(sum(x.v::numeric), 0) from jsonb_each_text(e.value->'sharesByAcct') x(k, v))
--               else coalesce((e.value->>'shares')::numeric, 0) end as total_shares
--   from public.col_prefs c, jsonb_each(c.cols) e
--   where c.id = 'stocks_data' and e.key <> '__cash__' and jsonb_typeof(e.value) = 'object'
-- )
-- select ticker, v->>'autoSto' as legacy_autosto, total_shares,
--        ((v->>'autoSto') = 'true' or ((v->>'autoSto') is distinct from 'false' and total_shares >= 100)) as will_be_auto_sto
-- from t
-- where (v ? 'autoSto') or total_shares >= 100
-- order by will_be_auto_sto desc, ticker;

-- ── 1. Seed (row-by-row so one bad value cannot abort the whole migration) ─────
do $$
declare
  seed_legacy_eligibility constant boolean := true;   -- false => carry over explicit trues only
  r              record;
  v_date         date;
  v_iv           numeric;
  v_shares       numeric;
  v_auto         boolean;
  n_explicit     int := 0;
  n_seeded       int := 0;
  n_false        int := 0;
  n_other        int := 0;
  n_skipped      int := 0;
  seeded_list    text[] := '{}';
begin
  for r in
    select upper(e.key) as ticker, e.value as v
    from public.col_prefs c, jsonb_each(c.cols) e
    where c.id = 'stocks_data' and e.key <> '__cash__' and jsonb_typeof(e.value) = 'object'
  loop
    begin
      -- same total-shares rule as api/_lib/tickerUniverse.js
      if jsonb_typeof(r.v->'sharesByAcct') = 'object' and r.v->'sharesByAcct' <> '{}'::jsonb then
        select coalesce(sum(x.v::numeric), 0) into v_shares from jsonb_each_text(r.v->'sharesByAcct') x(k, v);
      else
        v_shares := coalesce((r.v->>'shares')::numeric, 0);
      end if;

      v_date := case when r.v->>'earningsDate' ~ '^\d{4}-\d{2}-\d{2}$' then (r.v->>'earningsDate')::date end;
      v_iv   := case when r.v->>'iv' ~ '^\d+(\.\d+)?$'               then (r.v->>'iv')::numeric end;

      v_auto := ((r.v->>'autoSto') = 'true')
                or (seed_legacy_eligibility
                    and (r.v->>'autoSto') is distinct from 'false'
                    and v_shares >= 100);

      -- Only create a row when it carries information.
      continue when not (v_auto or (r.v ? 'autoSto') or v_date is not null or v_iv is not null);

      insert into public.stock_user_settings (ticker, auto_sto, earnings_date, iv_manual)
      values (r.ticker, v_auto, v_date, v_iv)
      on conflict (ticker) do nothing;

      if found then
        if (r.v->>'autoSto') = 'true' then
          n_explicit := n_explicit + 1;
        elsif v_auto then
          n_seeded := n_seeded + 1;
          seeded_list := seeded_list || r.ticker;
        elsif (r.v->>'autoSto') = 'false' then
          n_false := n_false + 1;
        else
          n_other := n_other + 1;
        end if;
      end if;
    exception when others then
      n_skipped := n_skipped + 1;
      raise notice 'stock_user_settings seed SKIPPED % (%): %', r.ticker, sqlstate, sqlerrm;
    end;
  end loop;

  raise notice 'stock_user_settings seed: % explicit-true carried over, % seeded from legacy eligibility (%), % explicit-false kept, % other rows, % skipped',
    n_explicit, n_seeded, seeded_list, n_false, n_other, n_skipped;
end $$;

-- ── 2. Verification — run all three; the first two must return 0 rows ─────────
-- (a) Anything eligible under the OLD rule that is NOT opted in now (must be empty when seeded with seed_legacy_eligibility = true):
-- with t as (
--   select upper(e.key) as ticker, e.value as v,
--          case when jsonb_typeof(e.value->'sharesByAcct') = 'object' and e.value->'sharesByAcct' <> '{}'::jsonb
--               then (select coalesce(sum(x.v::numeric), 0) from jsonb_each_text(e.value->'sharesByAcct') x(k, v))
--               else coalesce((e.value->>'shares')::numeric, 0) end as total_shares
--   from public.col_prefs c, jsonb_each(c.cols) e
--   where c.id = 'stocks_data' and e.key <> '__cash__' and jsonb_typeof(e.value) = 'object'
-- )
-- select t.ticker from t
-- where t.total_shares >= 100 and (t.v->>'autoSto') is distinct from 'false'
--   and not exists (select 1 from public.stock_user_settings s where s.ticker = t.ticker and s.auto_sto is true);
--
-- (b) Anything opted in now that the OLD rule would NOT have traded and is not an explicit true (must be empty):
-- select s.ticker from public.stock_user_settings s
-- where s.auto_sto is true
--   and not exists (select 1 from public.col_prefs c, jsonb_each(c.cols) e
--                   where c.id = 'stocks_data' and upper(e.key) = s.ticker and jsonb_typeof(e.value) = 'object'
--                     and ((e.value->>'autoSto') = 'true' or (e.value->>'autoSto') is distinct from 'false'));
--
-- (c) The final opted-in list:
-- select ticker, auto_sto, earnings_date, iv_manual from public.stock_user_settings order by auto_sto desc, ticker;
