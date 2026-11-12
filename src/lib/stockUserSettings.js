// src/lib/stockUserSettings.js
// Browser access to the stock_user_settings table: USER-owned per-ticker settings
// (auto_sto, earnings_date, iv_manual). One upsert touches ONE ticker's row and only the
// columns you pass — never an in-memory copy of everything — so a stale tab can no longer
// revert another tab's (or the server's) data. market-refresh reads this table but never
// writes it. See sql/stocks_integrity/002_stock_user_settings.sql and
// docs/STOCKS_DATA_OWNERSHIP.md. Kept parallel to api/_lib/stockUserSettings.js.
//
// Every failure throws StocksDataError (message is user-facing); nothing is swallowed.

import { StocksDataError, describeSupabaseError } from "./stocksDataStore.js";

// UI/blob field name -> table column
export const USER_SETTING_FIELDS = { autoSto: "auto_sto", earningsDate: "earnings_date", iv: "iv_manual" };
export const isUserSettingField = (field) => Object.prototype.hasOwnProperty.call(USER_SETTING_FIELDS, field);

export const TICKER_RE = /^[A-Z0-9.-]{1,12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A failed load must not look like "no settings": callers block edits unless ok.
export async function loadUserSettingsChecked(supabase) {
  try {
    const { data, error } = await supabase
      .from("stock_user_settings").select("ticker,auto_sto,earnings_date,iv_manual");
    if (error) return { ok: false, settings: {}, error: describeSupabaseError(error) };
    const settings = {};
    for (const r of data || []) {
      if (!r?.ticker) continue;
      settings[String(r.ticker).toUpperCase()] = {
        auto_sto: r.auto_sto === true,
        earnings_date: r.earnings_date ?? null,
        iv_manual: r.iv_manual == null ? null : Number(r.iv_manual),
      };
    }
    return { ok: true, settings, error: null };
  } catch (e) {
    return { ok: false, settings: {}, error: describeSupabaseError(e) };
  }
}

// uiFields uses the UI names ({ autoSto, earningsDate, iv }); unknown keys are rejected so a
// typo can't silently write nothing. Throws StocksDataError on validation or database failure.
export async function saveUserSetting(supabase, ticker, uiFields) {
  const t = String(ticker || "").trim().toUpperCase();
  if (!TICKER_RE.test(t)) throw new StocksDataError(`"${ticker}" is not a valid ticker symbol`);

  const row = { ticker: t };
  for (const [field, value] of Object.entries(uiFields || {})) {
    if (!isUserSettingField(field)) throw new StocksDataError(`"${field}" is not a user setting`);
    if (field === "autoSto") {
      if (typeof value !== "boolean") throw new StocksDataError("auto-STO must be true or false");
      row.auto_sto = value;
    } else if (field === "earningsDate") {
      if (value != null && !DATE_RE.test(String(value))) throw new StocksDataError(`"${value}" is not a valid earnings date (YYYY-MM-DD)`);
      row.earnings_date = value || null;
    } else if (field === "iv") {
      if (value != null && !(Number.isFinite(+value) && +value >= 0 && +value <= 1000)) throw new StocksDataError(`IV must be a number between 0 and 1000`);
      row.iv_manual = value == null ? null : +value;
    }
  }
  if (Object.keys(row).length === 1) throw new StocksDataError("nothing to save");

  // Upsert with merge semantics: only the columns present in `row` are updated on conflict.
  const { data, error } = await supabase
    .from("stock_user_settings")
    .upsert(row, { onConflict: "ticker" })
    .select("ticker");
  if (error) throw new StocksDataError(`could not save ${t} settings: ${describeSupabaseError(error)}`, { cause: error, code: error.code });
  // RLS can turn a write into a silent no-op; a saved row must come back.
  if (!Array.isArray(data) || data.length !== 1) throw new StocksDataError(`could not save ${t} settings: the database accepted the request but changed no row (permissions?)`);
  return data[0];
}

// Overlays user settings onto the (system-owned) stocks_data blob for DISPLAY. The legacy
// autoSto / earningsDate / iv fields still sitting in the blob are replaced, never trusted:
// a ticker with no settings row shows auto-STO off. Pure; inputs are not mutated.
export function mergeUserSettings(blob, settings) {
  const src = blob && typeof blob === "object" ? blob : {};
  const withSettings = (entry, s) => ({
    ...entry,
    autoSto: s?.auto_sto === true,
    earningsDate: s?.earnings_date ?? null,
    iv: s?.iv_manual ?? null,
  });
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = (k === "__cash__" || !v || typeof v !== "object") ? v : withSettings(v, settings?.[k.toUpperCase()]);
  }
  for (const [t, s] of Object.entries(settings || {})) {
    if (!(t in out)) out[t] = withSettings({}, s);
  }
  return out;
}
