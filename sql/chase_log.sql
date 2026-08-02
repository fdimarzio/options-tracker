-- sql/chase_log.sql
-- FOR FRANK — apply manually via the Supabase SQL editor. Not run automatically
-- by any script or CI job in this repo.
--
-- Chase is currently unobservable: trade_orders.chase_last_step_at is null on
-- every row, no chase rows exist in signal_log, and there's no way to tell
-- whether the engine is progressing or safe to flip dry_run off. This table is
-- purpose-built for the chase engine's shape (order id, symbol, side, old->new
-- price, bound, step #, interval, market-guard results, outcome, dry_run) —
-- kept separate from signal_log/decision_log, which are shaped around
-- factor-scored STO/BTC suggestions, not high-frequency (every 15-20s per
-- active order) price-step events.

CREATE TABLE IF NOT EXISTS chase_log (
  id                 bigserial PRIMARY KEY,
  order_id           bigint NOT NULL,
  symbol             text,
  opt_type           text,       -- STO | BTO | STC | BTC
  side               text,       -- SELL | BUY (derived from opt_type)
  step_num           integer,
  from_price         numeric,
  to_price           numeric,
  chase_bound        numeric,
  min_interval_secs  integer,
  bid                numeric,
  ask                numeric,
  mid                numeric,
  guard_tripped      boolean NOT NULL DEFAULT false,
  guard_reasons      jsonb,
  outcome            text NOT NULL,  -- stepped | rested | cancelled | filled | partial_fill | apply_failed | error
  dry_run            boolean NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chase_log_order_id_idx  ON chase_log (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chase_log_created_idx   ON chase_log (created_at DESC);

ALTER TABLE chase_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON chase_log FOR ALL USING (true) WITH CHECK (true);
