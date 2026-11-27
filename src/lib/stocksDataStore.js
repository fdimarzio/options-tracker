// src/lib/stocksDataStore.js
//
// The ONLY way browser code may persist to col_prefs id='stocks_data'.
//
// Why this exists: stocks_data is a single JSON blob shared by the server
// (api/market-refresh.js, every 5 min) and every open browser tab. Browser code used
// to upsert its whole in-memory copy — so any stale tab silently reverted whatever the
// server or another tab had just written (user toggles, share counts, prices), and
// every failure was swallowed by `catch {}` because supabase-js RETURNS errors rather
// than throwing them. Rules enforced here:
//
//   1. Never write an in-memory copy. Re-read the freshest row, apply a small mutator
//      to THAT, and write it back.
//   2. Compare-and-swap on updated_at: if anyone else wrote in between, re-read and
//      re-apply instead of overwriting them.
//   3. Every failure throws a StocksDataError with a human-readable message. Callers
//      surface it to the user; nothing is swallowed.
//
// Market data (quotes, shares) is written by market-refresh only — see
// docs/STOCKS_DATA_OWNERSHIP.md. User-owned settings (auto_sto, earnings_date,
// iv_manual) live in the stock_user_settings table, never in this blob.

export class StocksDataError extends Error {
  constructor(message, { cause, code } = {}) {
    super(message);
    this.name = "StocksDataError";
    this.cause = cause;
    this.code = code;
  }
}

export function describeSupabaseError(err) {
  if (!err) return "unknown error";
  const parts = [err.message, err.details, err.hint].filter(Boolean);
  const text = parts.length ? parts.join(" — ") : String(err);
  return err.code ? `${text} (${err.code})` : text;
}

function cloneBlob(blob) {
  return blob && typeof blob === "object" ? JSON.parse(JSON.stringify(blob)) : {};
}

// Row-level security does NOT return an error when it blocks a read: it returns ZERO ROWS. The
// stocks_data row always exists in this app (market-refresh creates and rewrites it), so "no row"
// means "this sign-in cannot read it" (or something deleted it) — never "you own nothing".
// That exact case showed an empty portfolio: signed-in users had no col_prefs policy.
export const ROW_NOT_VISIBLE_MESSAGE =
  "the stocks_data row could not be read — this sign-in may not have database permission to see it (or the row is missing). Your positions are not gone";

// A failed load must NOT look like an empty database: callers block writes unless ok.
export async function loadStocksDataChecked(supabase) {
  try {
    const { data, error } = await supabase
      .from("col_prefs").select("cols,updated_at").eq("id", "stocks_data").maybeSingle();
    if (error) return { ok: false, cols: null, updatedAt: null, error: describeSupabaseError(error) };
    if (!data) return { ok: false, cols: null, updatedAt: null, error: ROW_NOT_VISIBLE_MESSAGE };
    return { ok: true, cols: data.cols ?? null, updatedAt: data.updated_at ?? null, error: null };
  } catch (e) {
    return { ok: false, cols: null, updatedAt: null, error: describeSupabaseError(e) };
  }
}

// Read-modify-write against the freshest DB copy with compare-and-swap.
// mutator(freshBlobClone) must return the new blob. Returns the blob that was written.
export async function patchStocksData(supabase, mutator, { retries = 4, now = () => new Date().toISOString() } = {}) {
  if (typeof mutator !== "function") throw new StocksDataError("patchStocksData requires a mutator function");

  for (let attempt = 0; attempt <= retries; attempt++) {
    const { data: row, error: readErr } = await supabase
      .from("col_prefs").select("cols,updated_at").eq("id", "stocks_data").maybeSingle();
    if (readErr) throw new StocksDataError(`could not read stocks_data: ${describeSupabaseError(readErr)}`, { cause: readErr, code: readErr.code });
    // The browser never CREATES this row (market-refresh owns it): with no visible row we would only
    // be building a blob from nothing, on top of data we are not allowed to see.
    if (!row) throw new StocksDataError(`${ROW_NOT_VISIBLE_MESSAGE}. Your change was NOT saved`, { code: "ROW_NOT_VISIBLE" });

    const next = mutator(cloneBlob(row.cols));
    if (!next || typeof next !== "object") throw new StocksDataError("mutator must return the new stocks_data object");

    const { data: updated, error } = await supabase
      .from("col_prefs")
      .update({ cols: next, updated_at: now() })
      .eq("id", "stocks_data")
      .eq("updated_at", row.updated_at) // CAS: only if nobody wrote since we read
      .select("id");
    if (error) throw new StocksDataError(`could not save stocks_data: ${describeSupabaseError(error)}`, { cause: error, code: error.code });
    if (Array.isArray(updated) && updated.length === 1) return next;
    // 0 rows => someone else wrote first; loop re-reads and re-applies the mutator.
  }
  throw new StocksDataError("stocks_data was changed by another writer repeatedly; your change was NOT saved — please retry", { code: "CAS_EXHAUSTED" });
}

// Helpers for building mutators — keep each call site's change as small as possible.
export function setTickerFields(ticker, fields) {
  return (blob) => ({ ...blob, [ticker]: { ...(blob[ticker] || {}), ...fields } });
}

export function setCashField(field, value) {
  return (blob) => ({ ...blob, __cash__: { ...(blob.__cash__ || {}), [field]: value } });
}
