// api/_lib/reconcileWindow.js
// Computes the start of the transaction-fetch window for auto-import, so a
// broker settlement transaction that posts while the import job isn't running
// (e.g. over a weekend) still gets picked up on the next run instead of falling
// permanently outside a fixed "today" or "yesterday" window.
//
// Uses the agent's last successful run (ecosystem_heartbeat.last_run_at) as the
// window start, capped by maxLookbackDays so a long-stale heartbeat (outage,
// first-ever run) can't balloon the fetch into re-scanning ancient history.
export function computeReconcileWindowStart(lastRunAt, now = new Date(), maxLookbackDays = 10) {
  const floor = new Date(now.getTime() - maxLookbackDays * 86400000);
  if (!lastRunAt) return floor;
  const last = lastRunAt instanceof Date ? lastRunAt : new Date(lastRunAt);
  if (isNaN(last.getTime())) return floor;
  return last.getTime() < floor.getTime() ? floor : last;
}
