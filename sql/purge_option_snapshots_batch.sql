-- sql/purge_option_snapshots_batch.sql
-- FOR FRANK — apply manually via the Supabase SQL editor. Not run automatically
-- by any script or CI job in this repo.
--
-- Replaces the existing purge_option_snapshots_batch(retention_days, active_symbols,
-- batch_size) function. Signature is unchanged (no call-site divergence with
-- scripts/option-snapshot-purge.js), but two behaviors change:
--
--   1. Default batch size drops 500,000 -> 20,000. The 500k-row DELETE was
--      exceeding the statement/RPC timeout on every run, so the purge loop
--      never made progress and option_snapshots grew to ~42.5M rows / 14 GB
--      (DB is ~15.4 GB total, over the Supabase Pro 8 GB tier).
--   2. SEMANTICS CHANGE — active-symbol protection moves from "protect all
--      history for open/watchlist tickers" to purely time-based retention for
--      ALL symbols, EXCEPT any snapshot a trade actually references. Active
--      symbols were ~85% of rows, so protecting all their history regardless
--      of age couldn't hit any meaningful size target. The safety net for
--      "don't delete data a trade depends on" now lives inside the function
--      itself, via the NOT EXISTS check against contracts.entry_snapshot_id /
--      contracts.exit_snapshot_id — so p_active_symbols can be passed as an
--      empty array (or NULL) once scripts/option-snapshot-purge.js is updated
--      to stop computing it client-side.
--
-- After running this, the ~27M-row stale backlog drain and the VACUUM FULL to
-- reclaim billed disk are separate manual steps Frank runs directly — out of
-- scope for this file and for scripts/option-snapshot-purge.js.

CREATE OR REPLACE FUNCTION public.purge_option_snapshots_batch(
  p_retention_days integer,
  p_active_symbols text[],
  p_batch_size integer DEFAULT 20000
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_deleted bigint;
BEGIN
  WITH victims AS (
    SELECT s.id FROM option_snapshots s
    WHERE s.snapshot_at < now() - make_interval(days => p_retention_days)
      AND (p_active_symbols IS NULL OR NOT (s.symbol = ANY(p_active_symbols)))
      AND NOT EXISTS (
        SELECT 1 FROM contracts c
        WHERE c.entry_snapshot_id = s.id OR c.exit_snapshot_id = s.id
      )
    LIMIT p_batch_size
  )
  DELETE FROM option_snapshots o USING victims v WHERE o.id = v.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;$$;
