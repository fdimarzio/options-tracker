-- ETrade Auth Log — tracks every auth attempt (start, callback, renew)
-- Apply in Supabase SQL Editor before merging the PR.
--
-- Enables watchdog to monitor ETrade auth health and detect silent failures
-- before they cascade into stale portfolio data.

CREATE TABLE IF NOT EXISTS etrade_auth_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action      TEXT        NOT NULL,       -- 'auth_start', 'callback', 'renew'
  success     BOOLEAN     NOT NULL,
  error_reason TEXT,                      -- classification or message on failure
  token_expiry TIMESTAMPTZ,              -- when this token expires (midnight ET)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for watchdog queries: "last successful auth" and "recent failures"
CREATE INDEX IF NOT EXISTS idx_etrade_auth_log_created
  ON etrade_auth_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_etrade_auth_log_success
  ON etrade_auth_log (success, created_at DESC);

-- Allow PostgREST inserts from the service key (anon has no access)
ALTER TABLE etrade_auth_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_key_insert" ON etrade_auth_log
  FOR INSERT TO service_role
  WITH CHECK (true);

CREATE POLICY "service_key_select" ON etrade_auth_log
  FOR SELECT TO service_role
  USING (true);

-- Anon can read (for dashboard display) but not write
CREATE POLICY "anon_select" ON etrade_auth_log
  FOR SELECT TO anon
  USING (true);
