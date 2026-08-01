-- sql/protect_leaps_ltcg.sql
-- FOR FRANK — apply manually via the Supabase SQL editor. Not run automatically
-- by any script or CI job in this repo.
--
-- Backs the LEAPS long-term-cap-gains guard in the Skynet auto-BTC scanner
-- (api/market-refresh.js): a contract originally opened with > 365 days to
-- expiration is never auto-closed on a routine profit-threshold hit, even
-- once its remaining DTE has dropped well below 365 — e.g. a covered call
-- opened at 400 DTE, now at 150 DTE, still isn't touched. Per the "no
-- automated behavior without a signal_rules row + dry_run" architecture rule,
-- this is DB-gated rather than a hardcoded on/off switch.
--
-- 1. entry_dte lets the guard use the DTE at OPEN rather than recomputing it
--    from expires/date_exec every time (both are also fine as a fallback —
--    see COALESCE in the app code — for rows written before this column
--    existed). No backfill here; existing rows get entry_dte on next open.
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS entry_dte integer;

-- 2. protect_leaps_ltcg rule — default ON (enabled), default LIVE (dry_run
-- false), matching "default ON" in the spec: this guard fails safe (protects)
-- rather than fails open, unlike e.g. btc_expiry_skip, because the failure
-- mode of NOT protecting is unwinding a deliberate long-term tax position.
INSERT INTO signal_rules (rule_type, name, enabled, dry_run)
SELECT 'protect_leaps_ltcg', 'Protect LEAPs for LTCG', true, false
WHERE NOT EXISTS (SELECT 1 FROM signal_rules WHERE rule_type = 'protect_leaps_ltcg');
