// api/_lib/leapGuard.js
// LEAPS long-term-cap-gains protection for the Skynet auto-BTC scanner.
// A contract opened with >= 365 DTE stays protected from routine profit-threshold
// auto-close for its entire life, even once its remaining DTE has dropped well
// below 365 — the ORIGINAL DTE at open is what matters, not the current one.
const LEAP_ORIG_DTE_THRESHOLD = 365;

// entry_dte is the DTE recorded at open; older rows written before that column
// existed fall back to recomputing it from expires/date_exec.
export function computeOrigDte(entryDte, expires, dateExec) {
  if (entryDte != null) return +entryDte;
  return Math.ceil((new Date(expires) - new Date(dateExec)) / 86400000);
}

// ruleEnabled/dryRun come from the protect_leaps_ltcg signal_rules row (default
// enabled=true, dry_run=false when the row exists; both default true/protecting
// if the row doesn't exist yet, since this guard fails safe, not open).
export function shouldBlockForLeapProtection({ origDte, ruleEnabled = true, dryRun = false }) {
  const isLeap = origDte >= LEAP_ORIG_DTE_THRESHOLD;
  return { isLeap, blocked: isLeap && ruleEnabled && !dryRun };
}
