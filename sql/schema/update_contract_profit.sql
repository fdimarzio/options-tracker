-- sql/schema/update_contract_profit.sql
-- Captured verbatim from the live DB (options-tracker, ufagnokxmetushstgrip) via
-- pg_get_functiondef()/pg_get_triggerdef() on 2026-08-02. This IS the source of
-- truth going forward — see sql/schema/README.md. Do not edit the DB directly.
--
-- Recomputes contracts.profit/profit_pct server-side whenever cost_to_close is
-- set on an UPDATE — the same direction-aware formula as api/_lib/pnl.js's
-- computeClosePnl() (BTO: premium + cost_to_close; else: premium - cost_to_close;
-- profit_pct is a FRACTION, e.g. 1.0 = 100% — the UI multiplies by 100).
--
-- Idempotent: safe to re-run.

CREATE OR REPLACE FUNCTION public.update_contract_profit()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.premium IS NULL OR NEW.premium = 0 THEN
    NEW.profit := NULL;
    NEW.profit_pct := NULL;
  ELSE
    IF NEW.opt_type = 'BTO' THEN
      NEW.profit := NEW.premium + COALESCE(NEW.cost_to_close, 0);
    ELSE
      NEW.profit := NEW.premium - COALESCE(NEW.cost_to_close, 0);
    END IF;
    NEW.profit_pct := ROUND(NEW.profit / ABS(NEW.premium), 4);  -- FRACTION (UI multiplies by 100)
  END IF;
  RETURN NEW;
END;
$function$;

-- Fires only when cost_to_close is included in the UPDATE's column list (Postgres
-- `UPDATE OF` semantics — triggers on the column being SET, not on its value
-- actually changing). Every close path in this codebase sets cost_to_close on
-- close, so this recomputes profit/profit_pct server-side on every close,
-- redundantly alongside (and after) whatever the app already computed and sent.
CREATE OR REPLACE TRIGGER trg_update_contract_profit
  BEFORE UPDATE OF cost_to_close ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION update_contract_profit();
