-- sql/reconcile_schwab_realized_gl_2026-10-01.sql
-- FOR FRANK — apply manually via the Supabase SQL editor. Not run automatically by any
-- script or CI job in this repo (this project has no automated migration runner — see
-- docs/ROLLBACK.md and sql/schema/README.md). Idempotent and guarded: safe to re-run,
-- and a no-op once applied.
--
-- Context: reconciling the Schwab account against the broker's realized-G/L report
-- (2026-10-01) surfaced three defects in api/auto-import.js, fixed in the same change as
-- this file:
--   1. parseSchwabEquityTx attributed the CURRENCY_USD cash leg's "symbol" instead of the
--      real security on Schwab TRADEs (12 rows mislabeled).
--   2. a TRADE with no recognised security leg was silently dropped (lost the 2026-06-11
--      PANW/TKO/UPS sells); now logged to import_anomalies.
--   3. BTC/STC closer rows carried realized profit; P&L belongs solely on the parent
--      opener (canonical rule: pri-tod-v3.jsx:4269 and the `originals` filter at :4980).
--
-- This file: (A) nulls the latent double-count on historical closer rows, and (B) records,
-- for reproducibility, the data corrections already hand-applied in prod on 2026-10-01.


-- ── (A) Null realized profit on BTC/STC closer rows ──────────────────────────────────
-- Profit lives on the parent opener, never on the closer. ~50 rows today — latent (no UI
-- impact, the `originals` filter already excludes closers), but a double-count landmine
-- for any ad-hoc query that sums contracts.profit without that filter. The code fix stops
-- new closers from getting profit; this clears the historical ones.
UPDATE contracts
   SET profit = null
 WHERE parent_id IS NOT NULL
   AND opt_type IN ('BTC','STC')
   AND profit IS NOT NULL;


-- ── (B1) Backfill the 3 Schwab SELLs dropped on 2026-06-11 ───────────────────────────
-- Dropped by defect #2 (TRADE with no parsed security leg → silent null). Guarded by the
-- synthetic schwab_transaction_id 'RECON-2026-06-11-<SYM>' via WHERE NOT EXISTS, so this
-- inserts only if the row isn't already present.
--
-- CONFIRM BEFORE APPLYING (these were hand-applied in prod; values reconstructed here from
-- the reconciliation note): `account` is set to the funded Schwab account, and `price` is
-- derived as net_amount / quantity. Adjust if the prod rows used different values.
INSERT INTO stock_transactions
  (schwab_transaction_id, symbol, transaction_type, asset_type, quantity, price, net_amount, trade_date, account, description)
SELECT 'RECON-2026-06-11-PANW', 'PANW', 'SELL', 'EQUITY', 1,     267.92,  267.92,  '2026-06-11T16:00:00Z', 'Schwab 3866', 'Reconciliation backfill 2026-10-01: Schwab realized-G/L SELL missed by auto-import (defect #2)'
WHERE NOT EXISTS (SELECT 1 FROM stock_transactions WHERE schwab_transaction_id = 'RECON-2026-06-11-PANW');

INSERT INTO stock_transactions
  (schwab_transaction_id, symbol, transaction_type, asset_type, quantity, price, net_amount, trade_date, account, description)
SELECT 'RECON-2026-06-11-TKO', 'TKO', 'SELL', 'EQUITY', 8.82,  206.24,  1819.05, '2026-06-11T16:00:00Z', 'Schwab 3866', 'Reconciliation backfill 2026-10-01: Schwab realized-G/L SELL missed by auto-import (defect #2)'
WHERE NOT EXISTS (SELECT 1 FROM stock_transactions WHERE schwab_transaction_id = 'RECON-2026-06-11-TKO');

INSERT INTO stock_transactions
  (schwab_transaction_id, symbol, transaction_type, asset_type, quantity, price, net_amount, trade_date, account, description)
SELECT 'RECON-2026-06-11-UPS', 'UPS', 'SELL', 'EQUITY', 37.41, 104.38,  3904.74, '2026-06-11T16:00:00Z', 'Schwab 3866', 'Reconciliation backfill 2026-10-01: Schwab realized-G/L SELL missed by auto-import (defect #2)'
WHERE NOT EXISTS (SELECT 1 FROM stock_transactions WHERE schwab_transaction_id = 'RECON-2026-06-11-UPS');


-- ── (B2) Relabel the 7 CURRENCY_USD rows to their real security ──────────────────────
-- Mislabeled by defect #1 (the cash leg's "CURRENCY_USD" written as the symbol). Each
-- UPDATE is guarded on symbol = 'CURRENCY_USD' so re-running (or running after a manual
-- fix) is a no-op. id 3661 (ADBE) also had the cash leg's quantity/price, corrected to the
-- real share count/price.
UPDATE stock_transactions SET symbol = 'ADBE', quantity = 1, price = 209.66
 WHERE id = 3661 AND symbol = 'CURRENCY_USD';
UPDATE stock_transactions SET symbol = 'WDC' WHERE id = 3664 AND symbol = 'CURRENCY_USD';
UPDATE stock_transactions SET symbol = 'LMT' WHERE id = 3671 AND symbol = 'CURRENCY_USD';
UPDATE stock_transactions SET symbol = 'JPM' WHERE id = 3685 AND symbol = 'CURRENCY_USD';
UPDATE stock_transactions SET symbol = 'CAT' WHERE id = 3695 AND symbol = 'CURRENCY_USD';
UPDATE stock_transactions SET symbol = 'WDC' WHERE id = 3710 AND symbol = 'CURRENCY_USD';
UPDATE stock_transactions SET symbol = 'LMT' WHERE id = 3723 AND symbol = 'CURRENCY_USD';
