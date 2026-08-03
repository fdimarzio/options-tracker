-- sql/schema/sync_signal_outcomes.sql
-- Captured verbatim from the live DB (options-tracker, ufagnokxmetushstgrip) via
-- pg_get_functiondef()/pg_get_triggerdef() on 2026-08-02. Source of truth going
-- forward — see sql/schema/README.md. Do not edit the DB directly.
--
-- When a contract transitions to Closed with a non-null profit, backfills the
-- outcome onto every linked signal_outcomes row and creates one for any
-- signal_log entry for this contract that doesn't have a signal_outcomes row yet.
--
-- Idempotent: safe to re-run.

CREATE OR REPLACE FUNCTION public.sync_signal_outcomes_on_contract_close()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Only act when contract transitions to Closed and has a profit
  IF NEW.status = 'Closed' AND OLD.status != 'Closed' AND NEW.profit IS NOT NULL THEN
    -- Update all existing signal_outcomes for this contract
    UPDATE signal_outcomes
    SET
      outcome_profit       = NEW.profit,
      outcome_profit_pct   = NEW.profit_pct,
      outcome_days_held    = NEW.days_held,
      outcome_close_method = NEW.close_method,
      outcome_closed_at    = COALESCE(outcome_closed_at, (NEW.close_date::date + interval '17 hours')),
      signal_quality       = CASE WHEN NEW.profit > 0 THEN 'good' WHEN NEW.profit < 0 THEN 'bad' ELSE 'neutral' END,
      updated_at           = now()
    WHERE contract_id = NEW.id;

    -- Also create outcome records for any signal_log entries not yet linked
    INSERT INTO signal_outcomes (signal_id, contract_id, decision, outcome_profit, outcome_profit_pct, outcome_days_held, outcome_close_method, outcome_closed_at, signal_quality, created_at, updated_at)
    SELECT
      sl.id,
      NEW.id,
      'traded',
      NEW.profit,
      NEW.profit_pct,
      NEW.days_held,
      NEW.close_method,
      (NEW.close_date::date + interval '17 hours'),
      CASE WHEN NEW.profit > 0 THEN 'good' WHEN NEW.profit < 0 THEN 'bad' ELSE 'neutral' END,
      now(),
      now()
    FROM signal_log sl
    LEFT JOIN signal_outcomes so ON so.signal_id = sl.id
    WHERE sl.contract_id = NEW.id
      AND so.id IS NULL;  -- only if not already linked
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE TRIGGER trg_sync_signal_outcomes
  AFTER UPDATE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION sync_signal_outcomes_on_contract_close();
