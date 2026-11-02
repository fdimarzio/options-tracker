-- 003 — run after the new client has been live and verified. Destroys the plaintext PINs.
ALTER TABLE public.app_users DROP COLUMN IF EXISTS pin;
