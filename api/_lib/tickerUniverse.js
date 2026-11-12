// api/_lib/tickerUniverse.js
// Derives the ticker universe from current holdings, so chain coverage
// (chain-refresh.js) and auto-STO execution (market-refresh.js) both scan the
// same set of tickers instead of drifting apart. Previously chain-refresh keyed
// off a manual per-ticker "autoSto" flag, so a stock bought for covered calls
// (e.g. INTC, 200 sh) had no chain loaded — and therefore no strikes to pick
// from — until someone remembered to flip the flag in the Stocks tab.
//
// Does NOT touch signal_rules thresholds (min_premium, min_otm_pct, etc.) —
// those still gate whether a candidate clears the bar. This only changes which
// tickers are considered at all.

function totalShares(sd) {
  if (!sd) return 0;
  if (sd.sharesByAcct && Object.keys(sd.sharesByAcct).length) {
    return Object.values(sd.sharesByAcct).reduce((sum, n) => sum + (+n || 0), 0);
  }
  return +sd.shares || 0;
}

// stocksData: the col_prefs id='stocks_data' cols blob ({ SYM: { shares, sharesByAcct, ... }, __cash__: {...} })
//             — SYSTEM-owned market data. Holdings come from here; user settings do NOT.
// contracts: rows with at least {stock, expires} — expected pre-filtered to status=Open by the caller's query
// watchlistTickers: array of symbols from col_prefs id='watchlist'
// userSettings: the stock_user_settings table as { SYM: { auto_sto } } (see api/_lib/stockUserSettings.js).
//             Only needed for autoStoEligible. Omitted/undefined => nothing is auto-STO eligible
//             (fail closed), so chain-refresh — which never uses autoStoEligible — can omit it.
export function deriveTickerUniverse({ stocksData = {}, contracts = [], watchlistTickers = [], userSettings } = {}) {
  const today = new Date().toISOString().slice(0, 10);

  // (a) Covered-call eligible — total shares across all accounts >= 100 (a full lot)
  const coveredCallEligible = Object.entries(stocksData)
    .filter(([sym]) => sym !== "__cash__")
    .filter(([, sd]) => totalShares(sd) >= 100)
    .map(([sym]) => sym.toUpperCase())
    .sort();

  // (b) Tickers with an open, non-expired contract — keeps managing existing
  // positions (incl. puts, LEAPS) even if the underlying isn't otherwise held.
  const openPositionTickers = [...new Set(
    (Array.isArray(contracts) ? contracts : [])
      .filter(c => c.stock && c.expires && c.expires >= today)
      .map(c => c.stock.toUpperCase())
  )].sort();

  // (c) Watchlist — chain coverage for suggestions only, never auto-STO execution.
  const watchlist = [...new Set((watchlistTickers || []).map(t => t.toUpperCase()))].sort();

  const chainUniverse = [...new Set([...coveredCallEligible, ...openPositionTickers, ...watchlist])].sort();

  // Auto-STO execution eligibility is EXPLICIT OPT-IN: a full lot of shares AND a
  // stock_user_settings row with auto_sto === true. auto_sto false, a missing row, or no
  // settings supplied at all => not eligible. (This used to be opt-OUT — "never set" meant
  // eligible — and the flag lived inside the stocks_data blob, where stale writers kept
  // reverting it.) The old blob field `autoSto` is intentionally ignored here.
  const autoStoEligible = coveredCallEligible.filter(sym => userSettings?.[sym]?.auto_sto === true);

  return { chainUniverse, coveredCallEligible, openPositionTickers, watchlist, autoStoEligible };
}
