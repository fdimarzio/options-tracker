-- 001 — Audit trail for col_prefs changes (focus: stocks_data)
--
-- STATUS: NOT APPLIED. Written for Frank to review and run in the Supabase SQL editor.
-- Not executed anywhere before delivery (no Postgres engine was available and the live
-- database was deliberately not touched) — run it on a quiet moment and use the
-- verification block at the bottom. Rollback: 001_rollback_audit_col_prefs.sql.
--
-- WHY: stocks_data is one JSON blob rewritten by the server (market-refresh, every 5 min)
-- and by browser tabs. When a user setting (autoSto, earningsDate, iv) or a share count
-- changed back, there was no way to tell WHO reverted it. This records every change with
-- the writer's identity so the question "which process wrote this?" has an answer:
--
--   jwt_role = 'service_role'   -> the server (market-refresh, scripts)
--   jwt_role = 'authenticated'  -> a signed-in browser user (jwt_sub = their auth user id)
--   jwt_role = 'anon'           -> the public anon key (should be NONE after sql/auth/002)
--   jwt_role IS NULL            -> direct SQL (SQL editor / psql); see db_user
--
-- WHAT IS LOGGED
--   * col_prefs id = 'stocks_data': one row PER TICKER whose watched fields changed
--       watched = autoSto, earningsDate, iv, shares, sharesByAcct, sharesSchwab, sharesEtrade
--     (quote fields are deliberately NOT watched: they change every 5 minutes and would
--      flood the table). Plus one row (ticker NULL, changed_fields {__ticker_count__}) whenever
--      a write REMOVES tickers from the blob — the signature of a stale/partial blob overwrite.
--   * small user-config rows (watchlist, trade_rules, profit_bands, dte_matrix, goals, ...):
--       one row with the full old/new value.
--   * NEVER logged: schwab_tokens, etrade_tokens, and the high-churn caches
--     (last_chain_refresh, last_market_refresh, notifications_sent, ...). Tokens must never be
--     copied into another table. The allow-list below is the safety mechanism — keep it an
--     allow-list.

-- ── 1. Audit table ────────────────────────────────────────────────────────────
create table if not exists public.col_prefs_audit (
  id             bigint generated always as identity primary key,
  changed_at     timestamptz not null default now(),
  pref_id        text        not null,                         -- col_prefs.id
  op             text        not null check (op in ('INSERT','UPDATE','DELETE')),
  ticker         text,                                         -- NULL for non-ticker rows / whole-blob events
  changed_fields text[]      not null default '{}',
  old_values     jsonb,
  new_values     jsonb,
  jwt_role       text,                                         -- see header
  jwt_sub        text,                                         -- auth user id when a user JWT
  db_user        text        not null default current_user,
  note           text
);

create index if not exists col_prefs_audit_pref_time_idx   on public.col_prefs_audit (pref_id, changed_at desc);
create index if not exists col_prefs_audit_ticker_time_idx on public.col_prefs_audit (ticker, changed_at desc) where ticker is not null;
create index if not exists col_prefs_audit_time_idx        on public.col_prefs_audit (changed_at desc);

comment on table public.col_prefs_audit is
  'Who changed what in col_prefs. Written only by trigger col_prefs_audit_trg. Admin-readable. Consider pruning rows older than ~180 days.';

-- Locked down from the start: nobody writes it except the (SECURITY DEFINER) trigger function.
alter table public.col_prefs_audit enable row level security;
revoke all on public.col_prefs_audit from public, anon, authenticated;
grant select on public.col_prefs_audit to authenticated;
grant all    on public.col_prefs_audit to service_role;

drop policy if exists audit_admin_read on public.col_prefs_audit;
create policy audit_admin_read on public.col_prefs_audit
  for select to authenticated using (public.app_role() = 'admin');

-- ── 2. Trigger function ───────────────────────────────────────────────────────
create or replace function public.col_prefs_audit_fn()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Allow-lists. Anything not listed is ignored (tokens and caches especially).
  watched    constant text[] := array['autoSto','earningsDate','iv','shares','sharesByAcct','sharesSchwab','sharesEtrade'];
  config_ids constant text[] := array['watchlist','watchlist_notes','watchlist_alerts','trade_rules',
                                       'profit_bands','dte_matrix','goals','opp_items','default'];
  v_id       text;
  claims     jsonb;
  v_role     text;
  v_sub      text;
  old_c      jsonb;
  new_c      jsonb;
  t          text;
  f          text;
  changed    text[];
  ov         jsonb;
  nv         jsonb;
  old_n      int;
  new_n      int;
  removed    text[];
begin
 -- FAIL-SAFE: this trigger sits on col_prefs, which also holds broker tokens and the market-refresh
 -- output. Audit logging must NEVER be able to abort or roll back the caller's write. Everything
 -- below runs in an inner block whose handler downgrades any error to a WARNING.
 begin
  -- Explicit IF branches: never reference NEW in a DELETE or OLD in an INSERT.
  if TG_OP = 'DELETE' then
    v_id := OLD.id;  old_c := OLD.cols;  new_c := null;
  elsif TG_OP = 'INSERT' then
    v_id := NEW.id;  old_c := null;      new_c := NEW.cols;
  else
    v_id := NEW.id;  old_c := OLD.cols;  new_c := NEW.cols;
  end if;

  if v_id is distinct from 'stocks_data' and not (v_id = any (config_ids)) then
    return null;                                   -- not audited (tokens, caches, ...)
  end if;

  -- PostgREST exposes the caller's JWT as a GUC. Newer: request.jwt.claims (json);
  -- older: request.jwt.claim.<name>. Direct SQL has neither -> NULL.
  begin
    claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    claims := null;
  end;
  v_role := coalesce(claims->>'role', nullif(current_setting('request.jwt.claim.role', true), ''));
  v_sub  := coalesce(claims->>'sub',  nullif(current_setting('request.jwt.claim.sub',  true), ''));

  -- updated_at-only writes carry no information.
  if TG_OP = 'UPDATE' and old_c is not distinct from new_c then
    return null;
  end if;

  -- ── small config rows: log the whole old/new value once ─────────────────────
  if v_id <> 'stocks_data' then
    insert into public.col_prefs_audit (pref_id, op, changed_fields, old_values, new_values, jwt_role, jwt_sub)
    values (v_id, TG_OP, array['cols'], old_c, new_c, v_role, v_sub);
    return null;
  end if;

  -- ── stocks_data: per-ticker diff of the watched fields ──────────────────────
  if old_c is not null and jsonb_typeof(old_c) <> 'object' then old_c := null; end if;
  if new_c is not null and jsonb_typeof(new_c) <> 'object' then new_c := null; end if;

  for t in
    select k from (
      select jsonb_object_keys(coalesce(old_c, '{}'::jsonb)) as k
      union
      select jsonb_object_keys(coalesce(new_c, '{}'::jsonb)) as k
    ) s
    where k <> '__cash__'
  loop
    changed := '{}';
    ov := '{}'::jsonb;
    nv := '{}'::jsonb;
    foreach f in array watched loop
      -- SQL NULL (field absent) vs JSON null (field present, null) count as different on purpose:
      -- "the key disappeared" is exactly the kind of overwrite this exists to catch.
      if (old_c -> t -> f) is distinct from (new_c -> t -> f) then
        changed := changed || f;
        ov := ov || jsonb_build_object(f, old_c -> t -> f);
        nv := nv || jsonb_build_object(f, new_c -> t -> f);
      end if;
    end loop;
    if array_length(changed, 1) is not null then
      insert into public.col_prefs_audit (pref_id, op, ticker, changed_fields, old_values, new_values, jwt_role, jwt_sub)
      values (v_id, TG_OP, t, changed, ov, nv, v_role, v_sub);
    end if;
  end loop;

  -- ── whole-blob shrink: tickers that existed before and are gone now ──────────
  select count(*) into old_n from jsonb_object_keys(coalesce(old_c, '{}'::jsonb));
  select count(*) into new_n from jsonb_object_keys(coalesce(new_c, '{}'::jsonb));
  if new_n < old_n then
    select array_agg(k order by k) into removed
    from jsonb_object_keys(coalesce(old_c, '{}'::jsonb)) k
    where not (coalesce(new_c, '{}'::jsonb) ? k);
    insert into public.col_prefs_audit (pref_id, op, changed_fields, old_values, new_values, jwt_role, jwt_sub, note)
    values (v_id, TG_OP, array['__ticker_count__'],
            jsonb_build_object('count', old_n, 'removed', to_jsonb(removed)),
            jsonb_build_object('count', new_n),
            v_role, v_sub, 'blob_shrank');
  end if;

  return null;
 exception when others then
  raise warning 'col_prefs_audit_fn: audit skipped, caller write unaffected (%): %', sqlstate, sqlerrm;
 end;
 return null;
end;
$$;

-- Trigger functions are not meant to be called directly.
revoke all on function public.col_prefs_audit_fn() from public, anon, authenticated;

-- ── 3. Trigger ────────────────────────────────────────────────────────────────
drop trigger if exists col_prefs_audit_trg on public.col_prefs;
create trigger col_prefs_audit_trg
  after insert or update or delete on public.col_prefs
  for each row execute function public.col_prefs_audit_fn();

-- ── 4. Verification (run after applying) ──────────────────────────────────────
-- a) trigger exists:
--    select tgname, tgenabled from pg_trigger where tgrelid = 'public.col_prefs'::regclass and not tgisinternal;
-- b) after the next market-refresh run (<= 5 min), rows appear only when a watched field changed:
--    select changed_at, ticker, changed_fields, jwt_role from public.col_prefs_audit order by id desc limit 20;
-- c) token rows are NOT audited — this must return 0:
--    select count(*) from public.col_prefs_audit where pref_id in ('schwab_tokens','etrade_tokens');
-- See queries_audit.sql for the investigation queries.
