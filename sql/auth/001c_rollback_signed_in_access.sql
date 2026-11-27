-- Rollback for 001c. Drops ONLY the two policies 001c created, by name. NOT APPLIED.
-- Warning: this returns the app to showing no positions / orders / rules to signed-in users.

do $$
declare p record;
begin
  for p in select tablename, policyname from pg_policies
           where schemaname = 'public' and policyname in ('signed_in_read', 'signed_in_write')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;
