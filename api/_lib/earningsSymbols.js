// api/_lib/earningsSymbols.js
// Which symbols scripts/earnings-refresh.js must keep fresh in the earnings_dates table.
//
// WHY THIS EXISTS: the earnings guard (api/_lib/earningsGuard.js) blocks an STO whose expiry is on or
// after the underlying's next earnings date, and it trusts earnings_dates to be current. The refresh
// job used to cover only tickers with an OPEN CONTRACT or on the WATCHLIST — so a stock you hold and
// have opted in to auto-STO, but have no contract on right now, silently stopped being refreshed the
// day its last contract closed. Its row kept a date that later passed, and the guard then blocked
// every future expiry (2026-11-13: AAPL, CEG, MCD, SPCX).
//
// The rule below makes the refresh universe a SUPERSET of everything the scanner can trade, so a
// ticker the scanner may act on always has a fresh row:
//   - auto-STO opted in            (stock_user_settings.auto_sto === true)
//   - holds >= 100 shares          (same share rule as the scanner: api/_lib/tickerUniverse.js)
//   - has an active (Open) contract
//   - is on the watchlist
// Pure function; the script does the I/O.
import { totalShares } from "./tickerUniverse.js";

export const EARNINGS_MIN_SHARES = 100;

// stocksData:     the col_prefs 'stocks_data' blob ({ SYM: { shares, sharesByAcct, ... }, __cash__ })
// userSettings:   { SYM: { auto_sto } } from stock_user_settings
// contracts:      rows with at least { stock } (expected pre-filtered to status = Open by the caller)
// watchlistTickers: array of symbols
// Returns { symbols: sorted unique upper-case symbols, sources: { SYM: ["auto_sto","contract",...] } }.
export function deriveEarningsSymbols({ stocksData = {}, userSettings = {}, contracts = [], watchlistTickers = [] } = {}) {
  const sources = new Map();
  const add = (raw, source) => {
    const sym = String(raw ?? "").trim().toUpperCase();
    if (!sym || sym === "__CASH__") return;
    if (!sources.has(sym)) sources.set(sym, new Set());
    sources.get(sym).add(source);
  };

  for (const [t, s] of Object.entries(userSettings || {})) {
    if (s?.auto_sto === true) add(t, "auto_sto");               // strict: only a literal true opts in
  }
  for (const [t, sd] of Object.entries(stocksData || {})) {
    if (t === "__cash__") continue;
    if (totalShares(sd) >= EARNINGS_MIN_SHARES) add(t, "shares");
  }
  for (const c of Array.isArray(contracts) ? contracts : []) add(c?.stock, "contract");
  for (const t of Array.isArray(watchlistTickers) ? watchlistTickers : []) add(t, "watchlist");

  const symbols = [...sources.keys()].sort();
  return { symbols, sources: Object.fromEntries(symbols.map(s => [s, [...sources.get(s)].sort()])) };
}
