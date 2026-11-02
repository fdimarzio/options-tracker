-- 001 — ADDITIVE, safe to run before deploying the new client. Does not change any
-- existing access: RLS policies on other tables are untouched (see 002).
--
-- Turns app_users into the sign-in allow-list: one row per human, bound to a
-- Supabase Auth user on first successful sign-in.

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS email        text,
  ADD COLUMN IF NOT EXISTS role         text NOT NULL DEFAULT 'viewer',
  ADD COLUMN IF NOT EXISTS auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
ALTER TABLE public.app_users ADD  CONSTRAINT app_users_role_check CHECK (role IN ('admin','trader','viewer'));

CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_lower_idx ON public.app_users (lower(email));

-- Fill in the real addresses, then run (kept out of the repo on purpose):
--   UPDATE public.app_users SET email = lower('<frank-email>'),     role = 'admin' WHERE id = 'frank';
--   UPDATE public.app_users SET email = lower('<priscilla-email>'), role = 'admin' WHERE id = 'priscilla';

-- Is the caller a bound, allow-listed user?  SECURITY DEFINER so it can read
-- app_users regardless of that table's own RLS (avoids recursion).
CREATE OR REPLACE FUNCTION public.is_app_user() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.app_users WHERE auth_user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.app_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM public.app_users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

-- Called by the client right after sign-in. Returns the caller's app_users row, binding
-- auth.uid() to the allow-listed email the first time. Binding by auth user id (not by
-- email on every request) means a later identity-provider email change or an unverified
-- IdP email claim cannot take over an existing account (the "nOAuth" class of attack).
CREATE OR REPLACE FUNCTION public.claim_app_user()
RETURNS TABLE (id text, name text, initials text, color text, role text, email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  uid  uuid := auth.uid();
  mail text;
BEGIN
  IF uid IS NULL THEN RETURN; END IF;

  SELECT lower(a.email) INTO mail FROM auth.users a WHERE a.id = uid AND a.email_confirmed_at IS NOT NULL;

  -- Bind on first sign-in. Concurrent callers are safe: the loser's UPDATE matches 0 rows
  -- and falls through to the SELECT below, which sees the winner's committed binding.
  IF mail IS NOT NULL THEN
    UPDATE public.app_users u SET auth_user_id = uid
    WHERE lower(u.email) = mail AND u.auth_user_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.app_users x WHERE x.auth_user_id = uid);
  END IF;

  RETURN QUERY
    SELECT u.id, u.name, u.initials, u.color, u.role, u.email
    FROM public.app_users u WHERE u.auth_user_id = uid;
END $$;

REVOKE ALL ON FUNCTION public.is_app_user(), public.app_role(), public.claim_app_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_app_user(), public.app_role(), public.claim_app_user() TO authenticated;
