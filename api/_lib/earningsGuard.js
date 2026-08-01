// api/_lib/earningsGuard.js
// Earnings-date awareness for the Skynet STO scanners — blocks/down-ranks any
// candidate whose expiry falls on or after the underlying's next earnings date
// (minus an optional buffer), so a short call isn't left open straddling an
// earnings surprise the way the AMZN position was.
//
// nextEarnings is looked up from the earnings_dates table (see
// sql/earnings_dates.sql), refreshed nightly by scripts/earnings-refresh.js.
// A symbol missing from that table is NOT blocked — we don't guess.
export function isExpiryBlockedByEarnings(expiry, nextEarnings, bufferDays = 0) {
  if (!nextEarnings) return { blocked: false, reason: "no_earnings_data" };
  const cutoff = new Date(nextEarnings);
  cutoff.setUTCDate(cutoff.getUTCDate() - (+bufferDays || 0));
  const blocked = new Date(expiry) >= cutoff;
  return { blocked, reason: blocked ? "earnings_before_expiry" : null };
}
