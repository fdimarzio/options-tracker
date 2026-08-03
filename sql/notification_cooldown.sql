-- sql/notification_cooldown.sql
-- FOR FRANK — apply manually via the Supabase SQL editor. Not run automatically
-- by any script or CI job in this repo.
--
-- Backs the unified notification cooldown for CLOSE_NOW / itm_warning /
-- sto_suggestion (api/market-refresh.js) — these were firing on every 5-min
-- refresh for the same ticker/contract. Deliberately NOT reusing
-- contracts.last_exit_alert_at: that column already belongs to the separate
-- stop_loss/time_stop/delta_stop exit-plan mechanism, which suppresses
-- itself once per CALENDAR DAY per contract regardless of which of those
-- three tripped. Writing CLOSE_NOW/itm_warning into the same column would
-- make an early CLOSE_NOW alert silently suppress a real stop-loss alert
-- later the same day — a correctness/safety regression outside this
-- feature's scope (CLOSE_NOW/itm_warning/sto_suggestion only). This table
-- keeps the three in scope here independent of that mechanism and of each
-- other (per-alert-type keys), per (dedup_key, alert_type).

CREATE TABLE IF NOT EXISTS notification_log (
  id            bigserial PRIMARY KEY,
  dedup_key     text NOT NULL,   -- contract id, or "SYMBOL|account" for sto_suggestion
  alert_type    text NOT NULL,   -- 'close_now' | 'itm_warning' | 'sto_suggestion'
  last_sent_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dedup_key, alert_type)
);

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON notification_log FOR ALL USING (true) WITH CHECK (true);

-- cooldown_minutes — configurable without a redeploy; default 60 if this row
-- doesn't exist yet (see resolveCooldownMinutes in api/_lib/notificationCooldown.js).
ALTER TABLE signal_rules ADD COLUMN IF NOT EXISTS cooldown_minutes integer;

INSERT INTO signal_rules (rule_type, name, enabled, dry_run, cooldown_minutes)
SELECT 'notification_cooldown', 'Alert cooldown (CLOSE_NOW / itm_warning / sto_suggestion)', true, false, 60
WHERE NOT EXISTS (SELECT 1 FROM signal_rules WHERE rule_type = 'notification_cooldown');
