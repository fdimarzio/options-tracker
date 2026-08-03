-- sql/schema/purge_option_snapshots.sql
-- Captured verbatim from the live DB (options-tracker, ufagnokxmetushstgrip) via
-- pg_get_functiondef() on 2026-08-02. Source of truth going forward — see
-- sql/schema/README.md. Do not edit the DB directly.
--
-- Note: this has evolved since it was first proposed in sql/purge_option_snapshots_batch.sql
-- (2026-08-01) — the live version additionally protects sim_results.entry_snapshot_id/
-- exit_snapshot_id (not just contracts), orders victims oldest-first, and adds
-- purge_option_snapshots_backlog as a one-time/maintenance backlog drainer that
-- loops in batches with a wall-clock time budget instead of a single call. This
-- file reflects the live definitions, not the original proposal.
--
-- Idempotent: safe to re-run.

-- Per-call batch delete — used by the daily scheduled purge
-- (scripts/option-snapshot-purge.js / .github/workflows/option-snapshot-purge.yml).
-- Never deletes a snapshot referenced by contracts or sim_results.
CREATE OR REPLACE FUNCTION public.purge_option_snapshots_batch(
  p_retention_days integer,
  p_active_symbols text[] DEFAULT NULL::text[],
  p_batch_size integer DEFAULT 20000
)
 RETURNS bigint
 LANGUAGE plpgsql
AS $function$
DECLARE v_deleted bigint;
BEGIN
  WITH refs AS (
    SELECT entry_snapshot_id AS id FROM contracts   WHERE entry_snapshot_id IS NOT NULL
    UNION SELECT exit_snapshot_id  FROM contracts   WHERE exit_snapshot_id  IS NOT NULL
    UNION SELECT entry_snapshot_id FROM sim_results WHERE entry_snapshot_id IS NOT NULL
    UNION SELECT exit_snapshot_id  FROM sim_results WHERE exit_snapshot_id  IS NOT NULL
  ),
  victims AS (
    SELECT s.id FROM option_snapshots s
    WHERE s.snapshot_at < now() - make_interval(days => p_retention_days)
      AND (p_active_symbols IS NULL OR NOT (s.symbol = ANY(p_active_symbols)))
      AND NOT EXISTS (SELECT 1 FROM refs r WHERE r.id = s.id)
    ORDER BY s.snapshot_at
    LIMIT p_batch_size
  )
  DELETE FROM option_snapshots o USING victims v WHERE o.id = v.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

-- One-time/maintenance backlog drainer — loops calling the same delete pattern in
-- its own transaction per batch (COMMIT inside the loop, so progress persists even
-- if a later batch times out or the session is cancelled), bounded by p_max_seconds
-- rather than an iteration count. Run manually from the SQL editor, not by any cron
-- job in this repo (see scripts/option-snapshot-purge.js for the scheduled path).
CREATE OR REPLACE PROCEDURE public.purge_option_snapshots_backlog(
  IN p_retention_days integer DEFAULT 21,
  IN p_batch_size integer DEFAULT 20000,
  IN p_max_seconds integer DEFAULT 240
)
 LANGUAGE plpgsql
AS $procedure$
DECLARE v_start timestamptz := clock_timestamp(); v_deleted bigint; v_total bigint := 0;
BEGIN
  LOOP
    WITH refs AS (
      SELECT entry_snapshot_id AS id FROM contracts   WHERE entry_snapshot_id IS NOT NULL
      UNION SELECT exit_snapshot_id  FROM contracts   WHERE exit_snapshot_id  IS NOT NULL
      UNION SELECT entry_snapshot_id FROM sim_results WHERE entry_snapshot_id IS NOT NULL
      UNION SELECT exit_snapshot_id  FROM sim_results WHERE exit_snapshot_id  IS NOT NULL
    ),
    victims AS (
      SELECT s.id FROM option_snapshots s
      WHERE s.snapshot_at < now() - make_interval(days => p_retention_days)
        AND NOT EXISTS (SELECT 1 FROM refs r WHERE r.id = s.id)
      ORDER BY s.snapshot_at
      LIMIT p_batch_size
    )
    DELETE FROM option_snapshots o USING victims v WHERE o.id = v.id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    v_total := v_total + v_deleted;
    COMMIT;
    EXIT WHEN v_deleted = 0 OR extract(epoch FROM clock_timestamp() - v_start) > p_max_seconds;
  END LOOP;
  RAISE NOTICE 'purged % rows this run (total)', v_total;
END;
$procedure$;
