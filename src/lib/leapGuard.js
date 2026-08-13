// src/lib/leapGuard.js
// Client-side mirror of api/_lib/leapGuard.js's origDTE computation, for display
// only — surfaces the same protect_leaps_ltcg threshold in the UI (Skynet rules
// tab, contracts view) that api/market-refresh.js's btc_auto scanner already
// enforces server-side. Not used to make any trading decision.
const LEAP_ORIG_DTE_THRESHOLD = 365;

// entry_dte is the DTE recorded at open; older rows written before that column
// existed fall back to recomputing it from expires/date_exec.
export function computeOrigDte(entryDte, expires, dateExec) {
  if (entryDte != null) return +entryDte;
  if (!expires || !dateExec) return null;
  return Math.ceil((new Date(expires) - new Date(dateExec)) / 86400000);
}

export function isLeapOrigDte(origDte) {
  return origDte != null && origDte >= LEAP_ORIG_DTE_THRESHOLD;
}
