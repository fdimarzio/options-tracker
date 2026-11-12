-- 004 — OPTIONAL: audit changes to stock_user_settings (who flipped auto_sto?)
--
-- STATUS: NOT APPLIED. Requires 001 (public.col_prefs_audit) AND 002 (the table).
-- Writes into the same col_prefs_audit table with pref_id = 'stock_user_settings', so
-- queries_audit.sql style queries work for both. Nothing here changes any setting.

create or replace function public.stock_user_settings_audit_fn()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claims  jsonb;
  v_role  text;
  v_sub   text;
  o       jsonb;
  n       jsonb;
  changed text[] := '{}';
  f       text;
  ov      jsonb := '{}'::jsonb;
  nv      jsonb := '{}'::jsonb;
  fields  constant text[] := array['auto_sto','earnings_date','iv_manual'];
  v_ticker text;
begin
 -- FAIL-SAFE: audit logging must never be able to abort a user's settings save.
 begin
  begin
    claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    claims := null;
  end;
  v_role := coalesce(claims->>'role', nullif(current_setting('request.jwt.claim.role', true), ''));
  v_sub  := coalesce(claims->>'sub',  nullif(current_setting('request.jwt.claim.sub',  true), ''));

  if TG_OP = 'DELETE' then
    o := to_jsonb(OLD); n := null; v_ticker := OLD.ticker;
  elsif TG_OP = 'INSERT' then
    o := null; n := to_jsonb(NEW); v_ticker := NEW.ticker;
  else
    o := to_jsonb(OLD); n := to_jsonb(NEW); v_ticker := NEW.ticker;
  end if;

  foreach f in array fields loop
    if (o -> f) is distinct from (n -> f) then
      changed := changed || f;
      ov := ov || jsonb_build_object(f, o -> f);
      nv := nv || jsonb_build_object(f, n -> f);
    end if;
  end loop;

  if array_length(changed, 1) is not null then
    insert into public.col_prefs_audit (pref_id, op, ticker, changed_fields, old_values, new_values, jwt_role, jwt_sub)
    values ('stock_user_settings', TG_OP, v_ticker, changed, ov, nv, v_role, v_sub);
  end if;
  return null;
 exception when others then
  raise warning 'stock_user_settings_audit_fn: audit skipped, caller write unaffected (%): %', sqlstate, sqlerrm;
 end;
 return null;
end;
$$;

revoke all on function public.stock_user_settings_audit_fn() from public, anon, authenticated;

drop trigger if exists stock_user_settings_audit_trg on public.stock_user_settings;
create trigger stock_user_settings_audit_trg
  after insert or update or delete on public.stock_user_settings
  for each row execute function public.stock_user_settings_audit_fn();

-- Rollback:
--   drop trigger  if exists stock_user_settings_audit_trg on public.stock_user_settings;
--   drop function if exists public.stock_user_settings_audit_fn();
--
-- Example: who changed auto_sto?
--   select changed_at, ticker, old_values->'auto_sto' as was, new_values->'auto_sto' as now, jwt_role, jwt_sub
--   from public.col_prefs_audit where pref_id = 'stock_user_settings' and 'auto_sto' = any (changed_fields)
--   order by changed_at desc;
