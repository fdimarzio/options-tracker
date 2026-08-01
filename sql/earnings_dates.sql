-- sql/earnings_dates.sql
-- FOR FRANK — apply manually via the Supabase SQL editor. Not run automatically
-- by any script or CI job in this repo.
--
-- Backs earnings-date awareness in the Skynet STO scanners (api/market-refresh.js)
-- and the nightly refresh in scripts/earnings-refresh.js. Built after AMZN was
-- sold across its earnings date and took a large loss on the surprise move.

CREATE TABLE IF NOT EXISTS earnings_dates (
  symbol         text PRIMARY KEY,
  next_earnings  date,
  prev_earnings  date,
  source         text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE earnings_dates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON earnings_dates FOR ALL USING (true) WITH CHECK (true);

-- avoid_earnings_days — configurable buffer (days) added before next_earnings when
-- deciding whether an expiry is too close to earnings. Reused by name on the
-- avoid_earnings signal_rules row below; default 0 (block only if expiry is on/after
-- the earnings date itself).
ALTER TABLE signal_rules ADD COLUMN IF NOT EXISTS avoid_earnings_days integer;

-- avoid_earnings rule — NOT inserted as enabled by default. Per the "no automated
-- behavior without a signal_rules row" architecture rule, this INTRODUCES a new
-- filter on live STO candidate generation (unlike protect_leaps_ltcg, which only
-- ever prevents a close) — so it stays off until Frank explicitly flips it on,
-- exactly like btc_expiry_skip's rollout. Flip `enabled` to true when ready.
INSERT INTO signal_rules (rule_type, name, enabled, dry_run, avoid_earnings_days)
SELECT 'avoid_earnings', 'Avoid STO expiries straddling earnings', false, false, 0
WHERE NOT EXISTS (SELECT 1 FROM signal_rules WHERE rule_type = 'avoid_earnings');
