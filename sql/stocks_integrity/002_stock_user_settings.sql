-- 002 — stock_user_settings: user-owned per-ticker settings, moved OUT of the stocks_data blob
--
-- STATUS: NOT APPLIED. For Frank to review and run in the Supabase SQL editor.
-- Not executed anywhere before delivery (no Postgres engine available; live DB untouched).
-- Rollback: 002_rollback_stock_user_settings.sql.
--
-- ORDER OF OPERATIONS (important — the new code FAILS CLOSED without this table):
--   1. run 002 (this file)
--   2. run 003_backfill_stock_user_settings.sql and check its verification output
--   3. THEN deploy the code that reads/writes this table
-- If the code is deployed first: auto-STO places no orders (and says so), and the Stocks
-- tab shows a "settings failed to load" banner. Nothing breaks silently.
--
-- DATA OWNERSHIP (see docs/STOCKS_DATA_OWNERSHIP.md)
--   stock_user_settings  — USER-owned. Written only by signed-in users (UI). The server
--                          (market-refresh) READS it and NEVER writes it.
--   col_prefs.stocks_data — SYSTEM-owned market data (quotes, shares). Written by
--                          market-refresh only.
--
-- AUTO-STO IS EXPLICIT OPT-IN: a ticker is eligible only when a row exists with
-- auto_sto = true (and it still needs >= 100 shares). auto_sto = false, NULL (impossible: the
-- column is NOT NULL, and the scanner only accepts a literal true anyway) or no row = not eligible.
-- (Previously "never set" meant eligible; only an explicit false opted a ticker out.)
-- Today's production behavior is PRESERVED by 003, which seeds exactly the symbols the old rule
-- trades (>= 100 shares and autoSto not explicitly false). Do not skip 003.

create table if not exists public.stock_user_settings (
  ticker        text        primary key
                            check (ticker = upper(ticker) and ticker ~ '^[A-Z0-9.-]{1,12}$'),
  auto_sto      boolean     not null default false,
  earnings_date date,
  iv_manual     numeric     check (iv_manual is null or (iv_manual >= 0 and iv_manual <= 1000)),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table  public.stock_user_settings is
  'User-owned per-ticker settings. Written by signed-in users only; market-refresh reads but never writes. Moved out of col_prefs stocks_data to remove stale-blob overwrites.';
comment on column public.stock_user_settings.auto_sto      is 'Explicit opt-in for Skynet auto-STO. false / missing row = never auto-sell covered calls on this ticker.';
comment on column public.stock_user_settings.earnings_date is 'Display only (the scanner uses the earnings_dates table).';
comment on column public.stock_user_settings.iv_manual     is 'Manually entered IV %, display only.';

-- updated_at maintenance (own function: no dependency on any shared helper)
create or replace function public.stock_user_settings_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists stock_user_settings_touch_trg on public.stock_user_settings;
create trigger stock_user_settings_touch_trg
  before update on public.stock_user_settings
  for each row execute function public.stock_user_settings_touch();

-- ── Access: same model as sql/auth/002_lockdown_rls.sql ───────────────────────
-- The public anon key gets nothing. Signed-in allow-listed users read; admin/trader write.
-- service_role (the server) bypasses RLS — it reads this table, and by convention never writes it.
alter table public.stock_user_settings enable row level security;
revoke all on public.stock_user_settings from public, anon;
grant select, insert, update, delete on public.stock_user_settings to authenticated;
grant all on public.stock_user_settings to service_role;

drop policy if exists app_read  on public.stock_user_settings;
drop policy if exists app_write on public.stock_user_settings;
create policy app_read  on public.stock_user_settings
  for select to authenticated using (public.is_app_user());
create policy app_write on public.stock_user_settings
  for all to authenticated
  using      (public.app_role() in ('admin','trader'))
  with check (public.app_role() in ('admin','trader'));

-- ── Verification (run after applying) ─────────────────────────────────────────
-- select relrowsecurity from pg_class where oid = 'public.stock_user_settings'::regclass;   -- expect true
-- select policyname, cmd, roles from pg_policies where tablename = 'stock_user_settings';    -- app_read, app_write; no anon
-- select has_table_privilege('anon', 'public.stock_user_settings', 'select');                -- expect false
