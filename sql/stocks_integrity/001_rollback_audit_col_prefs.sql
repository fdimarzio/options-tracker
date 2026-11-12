-- Rollback for 001_audit_col_prefs.sql. NOT APPLIED.
-- Export the audit rows first if you want to keep them:
--   copy (select * from public.col_prefs_audit) to ... / or  select * from public.col_prefs_audit;

drop trigger  if exists col_prefs_audit_trg on public.col_prefs;
drop function if exists public.col_prefs_audit_fn();
drop table    if exists public.col_prefs_audit;
