// api/_lib/stockUserSettings.js
// Server-side READ of the stock_user_settings table (user-owned per-ticker settings:
// auto_sto, earnings_date, iv_manual). The server never writes this table — users do,
// from the Stocks tab. See sql/stocks_integrity/002_stock_user_settings.sql and
// docs/STOCKS_DATA_OWNERSHIP.md.
//
// Auto-STO places real orders, so a failed load must FAIL CLOSED: this throws, and the
// caller skips auto-STO for the run and alerts, rather than guessing "everything is on".
// (Kept parallel to src/lib/stockUserSettings.js; not cross-imported, matching this
// repo's api/_lib <-> src/lib convention.)

export class StockUserSettingsError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = "StockUserSettingsError";
    this.status = status;
  }
}

// Returns { TICKER: { auto_sto, earnings_date, iv_manual } }. Throws StockUserSettingsError.
export async function loadStockUserSettings({ supabaseUrl, serviceKey, fetchImpl = fetch }) {
  if (!supabaseUrl || !serviceKey) throw new StockUserSettingsError("Supabase URL / service key not configured");

  let res;
  try {
    res = await fetchImpl(
      `${supabaseUrl}/rest/v1/stock_user_settings?select=ticker,auto_sto,earnings_date,iv_manual`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
  } catch (e) {
    throw new StockUserSettingsError(`request failed: ${e.message}`);
  }
  if (!res || res.ok === false) {
    const body = res ? await res.text().catch(() => "") : "";
    throw new StockUserSettingsError(`HTTP ${res?.status ?? "?"} ${String(body).slice(0, 200)}`.trim(), { status: res?.status });
  }

  const rows = await res.json().catch(() => null);
  if (!Array.isArray(rows)) throw new StockUserSettingsError("unexpected response shape (expected an array of rows)");

  const out = {};
  for (const r of rows) {
    if (!r?.ticker) continue;
    out[String(r.ticker).toUpperCase()] = {
      auto_sto: r.auto_sto === true,            // strict: only a literal true opts in
      earnings_date: r.earnings_date ?? null,
      iv_manual: r.iv_manual ?? null,
    };
  }
  return out;
}

// Explicit opt-in: eligible only with a row whose auto_sto is exactly true.
export function isAutoStoEnabled(userSettings, ticker) {
  return userSettings?.[String(ticker).toUpperCase()]?.auto_sto === true;
}
