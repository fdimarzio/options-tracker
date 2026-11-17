// src/lib/ownership.js
// "How many shares do we own, and where?" for the Stocks tab — from the SAME source of truth the
// auto-STO scanner uses: the server-owned `shares` / `sharesByAcct` fields of col_prefs
// 'stocks_data', which api/market-refresh.js recomputes from the brokers every 5 minutes.
//
// Previously the tab used `sharesSchwab` / `sharesEtrade`: browser-owned fields written by old
// broker pulls and manual typing, no longer saved, and wrong for most tickers (e.g. AAPL showed
// 100.09 Schwab + 26 ETrade while the real holding is 226 shares in ETrade 6917) — so a held,
// auto-STO-enabled ticker could be missing from the list entirely.
//
// Kept as a parallel copy of api/_lib/tickerUniverse.js#totalShares (the repo's api/ <-> src/
// convention is not to cross-import); tests/ownership.test.js asserts the two agree.
// Nothing here ever writes anywhere.

// Rule: sum(sharesByAcct) when that object is non-empty, otherwise the flat `shares` field.
export function totalOwnedShares(sd) {
  if (!sd) return 0;
  if (sd.sharesByAcct && Object.keys(sd.sharesByAcct).length) {
    return Object.values(sd.sharesByAcct).reduce((sum, n) => sum + (+n || 0), 0);
  }
  return +sd.shares || 0;
}

export const isOwned = (sd) => totalOwnedShares(sd) > 0;

// Per-broker split of sharesByAcct, keyed on the account name ("Schwab 3866", "ETrade 6917",
// "ETrade 8222"). Anything else lands in `other` so nothing is silently dropped.
export function sharesByBroker(sd) {
  const out = { schwab: 0, etrade: 0, other: 0 };
  const byAcct = sd?.sharesByAcct;
  if (byAcct && typeof byAcct === "object" && Object.keys(byAcct).length) {
    for (const [acct, n] of Object.entries(byAcct)) {
      const qty = +n || 0;
      if (/^schwab/i.test(acct)) out.schwab += qty;
      else if (/^e-?trade/i.test(acct)) out.etrade += qty;
      else out.other += qty;
    }
  } else {
    out.other = +sd?.shares || 0; // holding known, broker unknown
  }
  return out;
}

// Folds the server's current holdings into the UI's in-memory stocks_data, for display only.
// Touches ONLY shares / sharesByAcct / sharesUpdatedAt — never the user-owned settings overlay,
// the legacy manual fields, or quotes. Pure; inputs are not mutated.
export function mergeServerHoldings(prev, serverBlob) {
  const out = { ...(prev || {}) };
  if (!serverBlob || typeof serverBlob !== "object") return out;
  for (const [t, sd] of Object.entries(serverBlob)) {
    if (t === "__cash__" || !sd || typeof sd !== "object") continue;
    const holdings = {};
    if ("shares" in sd) holdings.shares = sd.shares;
    if ("sharesByAcct" in sd) holdings.sharesByAcct = sd.sharesByAcct;
    if ("sharesUpdatedAt" in sd) holdings.sharesUpdatedAt = sd.sharesUpdatedAt;
    if (!Object.keys(holdings).length) continue;
    out[t] = { ...(out[t] || {}), ...holdings };
  }
  return out;
}
