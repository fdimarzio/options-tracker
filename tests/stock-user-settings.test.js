// tests/stock-user-settings.test.js
// P4 of the stocks_data integrity work: user-owned settings (auto-STO opt-in, earnings
// date, manual IV) moved out of the stocks_data blob into the stock_user_settings table.
//   (A) server loader + the REAL api/market-refresh.js handler (opt-in, fail-closed, never writes)
//   (B) client module (src/lib/stockUserSettings.js)
//   (C) UI wiring (source guards over src/pri-tod-v3.jsx)
//   (D) structural guards over the SQL (NOT executed — see tests/stocks-integrity-sql.test.js)
// Run: npx vitest run tests/stock-user-settings.test.js

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { loadStockUserSettings, isAutoStoEnabled, StockUserSettingsError } from "../api/_lib/stockUserSettings.js";
import {
  loadUserSettingsChecked, saveUserSetting, mergeUserSettings, isUserSettingField, USER_SETTING_FIELDS,
} from "../src/lib/stockUserSettings.js";
import { StocksDataError } from "../src/lib/stocksDataStore.js";

const mkRes = (body, { ok = true, status = 200 } = {}) => ({
  ok, status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), headers: { get: () => null },
});

// ═══ (A1) server loader ══════════════════════════════════════════════════════════
describe("api/_lib/stockUserSettings.js — loadStockUserSettings", () => {
  const cfg = { supabaseUrl: "https://x.supabase.co", serviceKey: "svc" };

  it("positive — maps rows to { TICKER: { auto_sto, earnings_date, iv_manual } } and upper-cases keys", async () => {
    const fetchImpl = vi.fn(async () => mkRes([
      { ticker: "nvda", auto_sto: true, earnings_date: "2026-11-20", iv_manual: 41.5 },
      { ticker: "AMD", auto_sto: false, earnings_date: null, iv_manual: null },
    ]));
    const out = await loadStockUserSettings({ ...cfg, fetchImpl });
    expect(out).toEqual({
      NVDA: { auto_sto: true, earnings_date: "2026-11-20", iv_manual: 41.5 },
      AMD: { auto_sto: false, earnings_date: null, iv_manual: null },
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://x.supabase.co/rest/v1/stock_user_settings?select=ticker,auto_sto,earnings_date,iv_manual");
    expect(init.headers.Authorization).toBe("Bearer svc");
  });

  it("strict — only a literal true opts in; truthy look-alikes become false", async () => {
    const fetchImpl = async () => mkRes([{ ticker: "A", auto_sto: "true" }, { ticker: "B", auto_sto: 1 }, { ticker: "C", auto_sto: null }, { ticker: "D", auto_sto: true }]);
    const out = await loadStockUserSettings({ ...cfg, fetchImpl });
    expect([out.A.auto_sto, out.B.auto_sto, out.C.auto_sto, out.D.auto_sto]).toEqual([false, false, false, true]);
  });

  it("edge — an empty table is a valid empty result (nothing opted in), not an error", async () => {
    expect(await loadStockUserSettings({ ...cfg, fetchImpl: async () => mkRes([]) })).toEqual({});
  });

  it("negative — HTTP error (e.g. table missing / permission denied) throws with status — never an empty object", async () => {
    const fetchImpl = async () => mkRes({ message: 'relation "public.stock_user_settings" does not exist' }, { ok: false, status: 404 });
    await expect(loadStockUserSettings({ ...cfg, fetchImpl })).rejects.toMatchObject({ name: "StockUserSettingsError", status: 404 });
  });

  it("negative — network failure throws", async () => {
    await expect(loadStockUserSettings({ ...cfg, fetchImpl: async () => { throw new Error("ECONNRESET"); } })).rejects.toThrow(/request failed: ECONNRESET/);
  });

  it("negative — a non-array body (PostgREST error object with 200) throws", async () => {
    await expect(loadStockUserSettings({ ...cfg, fetchImpl: async () => mkRes({ message: "oops" }) })).rejects.toThrow(/unexpected response shape/);
  });

  it("negative — missing configuration throws instead of silently returning {}", async () => {
    await expect(loadStockUserSettings({ supabaseUrl: "", serviceKey: "k" })).rejects.toBeInstanceOf(StockUserSettingsError);
  });

  it("isAutoStoEnabled — true only for a row with auto_sto === true", () => {
    const s = { NVDA: { auto_sto: true }, AMD: { auto_sto: false } };
    expect(isAutoStoEnabled(s, "nvda")).toBe(true);
    expect(isAutoStoEnabled(s, "AMD")).toBe(false);
    expect(isAutoStoEnabled(s, "MCD")).toBe(false);
    expect(isAutoStoEnabled(null, "NVDA")).toBe(false);
  });
});

// ═══ (A2) the real market-refresh handler ════════════════════════════════════════
const NOW_ISO = "2026-09-01T18:00:00Z";
const STO_RULE = { id: 1, rule_type: "sto", enabled: true, dry_run: true, priority: 10, min_change_pct: 0.5, min_premium: 50, min_dte: 1, max_dte: 14, min_otm_pct: 1, max_otm_pct: 10, min_time_et: "09:00" };
const CHAIN_EXPIRY = "2026-09-08";
const CHAIN_DATA = { [`INTC|${CHAIN_EXPIRY}`]: { calls: [{ strikePrice: 36, bid: 1.0, ask: 1.1, mark: 1.05, delta: 0.3, volatility: 28, totalVolume: 500, openInterest: 1000 }], puts: [] } };

let calls;
let settingsMode;      // "optin" | "optout" | "norow" | "http500"
let notifState;        // persisted notifications_sent blob, so once-a-day dedupe can be exercised

async function router(url, init = {}) {
  const method = (init && init.method) || "GET";
  let body = null;
  try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
  calls.push({ url: String(url), method, body });

  if (url.includes("/rest/v1/stock_user_settings")) {
    if (method !== "GET") return mkRes({}, { ok: true });
    if (settingsMode === "http500") return mkRes({ message: "boom" }, { ok: false, status: 500 });
    if (settingsMode === "optin")  return mkRes([{ ticker: "INTC", auto_sto: true, earnings_date: null, iv_manual: null }]);
    if (settingsMode === "optout") return mkRes([{ ticker: "INTC", auto_sto: false, earnings_date: null, iv_manual: null }]);
    return mkRes([{ ticker: "SOMETHINGELSE", auto_sto: true }]); // "norow": INTC has no row
  }
  if (method === "POST" && url.includes("/rest/v1/col_prefs") && body?.id === "notifications_sent") { notifState = body.cols; return mkRes({}); }
  if (url.includes("/col_prefs?select=cols&id=eq.notifications_sent")) return mkRes(notifState ? [{ cols: notifState }] : []);
  if (url.includes("/col_prefs?select=cols&id=eq.schwab_tokens")) return mkRes([{ cols: { accessToken: "t", accessTokenExpiresAt: Date.now() + 3600000 } }]);
  if (url.includes("/trader/v1/accounts/accountNumbers")) return mkRes([{ accountNumber: "12343866", hashValue: "HASH1" }]);
  if (url.includes("/trader/v1/accounts/HASH1") && url.includes("fields=positions")) {
    return mkRes({ securitiesAccount: { positions: [{ instrument: { assetType: "EQUITY", symbol: "INTC" }, longQuantity: 200 }] } });
  }
  if (url.includes("/api/etrade") && url.includes("action=positions")) return mkRes({ positions: [] });
  if (url.includes("/rest/v1/contracts") && url.includes("status=eq.Open")) return mkRes([]);
  if (url.includes("/col_prefs?select=cols&id=eq.stocks_data")) return mkRes([]);
  if (url.includes("/signal_rules?enabled=eq.true")) return mkRes([STO_RULE]);
  if (url.includes("/col_prefs?select=cols&id=eq.last_chain_refresh")) return mkRes([{ cols: { chains: CHAIN_DATA } }]);
  if (url.includes("/marketdata/v1/quotes") && url.includes("symbols=INTC")) {
    return mkRes({ INTC: { quote: { lastPrice: 35, netPercentChange: 1.5, bidPrice: 34.9, askPrice: 35.1, highPrice: 35.5, lowPrice: 34, openPrice: 34.5, totalVolume: 1000000 } } });
  }
  if (url.includes("/rest/v1/signal_log")) return mkRes([{ id: 999 }]);
  if (url.includes("pushover")) return mkRes({ status: 1 });
  if (url.includes("/api/schwab-orders")) return mkRes({ ok: false, error: "TEST HARNESS: no live orders expected" });
  return method === "GET" ? mkRes([]) : mkRes({});
}

describe("api/market-refresh.js — auto-STO honors the stock_user_settings opt-in (real handler)", () => {
  let handler;
  const run = async () => {
    const req = { method: "GET", query: { force: "1" }, headers: { "x-cron-secret": "test-secret" } };
    const res = { setHeader() {}, status() { return this; }, json() { return this; }, end() { return this; } };
    await handler(req, res);
  };
  const stoSignals = () => calls.filter(c => c.url.includes("/rest/v1/signal_log") && c.method === "POST" && c.body?.signal_type === "sto_auto");
  const pausedAlerts = () => calls.filter(c => c.url.includes("pushover") && c.body?.title?.includes("Auto-STO paused"));
  const settingsWrites = () => calls.filter(c => c.url.includes("stock_user_settings") && c.method !== "GET");

  beforeAll(async () => {
    process.env.VITE_SUPABASE_URL = "https://fake-project.supabase.co";
    process.env.VITE_SUPABASE_ANON_KEY = "fake-anon-key";
    process.env.SUPABASE_SERVICE_KEY = "fake-service-key";
    process.env.PUSHOVER_API_TOKEN = "fake"; process.env.PUSHOVER_USER_KEY = "fake";
    process.env.CRON_SECRET = "test-secret";
    ({ default: handler } = await import("../api/market-refresh.js"));
  });
  beforeEach(() => {
    calls = []; settingsMode = "optin"; notifState = null;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW_ISO));
    vi.stubGlobal("fetch", vi.fn(router));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("positive — opted in (auto_sto=true, 200 shares) => a sto_auto signal is produced", async () => {
    await run();
    expect(stoSignals().length).toBe(1);
    expect(stoSignals()[0].body.symbol).toBe("INTC");
  });

  it("negative — explicitly opted OUT (auto_sto=false) => no sto_auto signal, even with 200 shares and a valid chain", async () => {
    settingsMode = "optout";
    await run();
    expect(stoSignals()).toEqual([]);
  });

  it("negative — NO row for the ticker => no sto_auto signal (opt-in, not opt-out)", async () => {
    settingsMode = "norow";
    await run();
    expect(stoSignals()).toEqual([]);
  });

  it("negative — settings unreadable (HTTP 500) => FAILS CLOSED: no signal, no order call, and an alert is sent", async () => {
    settingsMode = "http500";
    await run();
    expect(stoSignals()).toEqual([]);
    expect(calls.filter(c => c.url.includes("/api/schwab-orders") && c.method === "POST")).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("stock_user_settings load FAILED"));
    expect(pausedAlerts().length).toBe(1);
    expect(pausedAlerts()[0].body.message).toContain("HTTP 500");
  });

  it("edge — the fail-closed alert is once per day, not once per 5-minute run", async () => {
    settingsMode = "http500";
    await run();
    await run();
    await run();
    expect(pausedAlerts().length).toBe(1);
  });

  it("recovery — once the table is readable again, trading resumes on the next run", async () => {
    settingsMode = "http500";
    await run();
    expect(stoSignals()).toEqual([]);
    settingsMode = "optin";
    calls = [];
    await run();
    expect(stoSignals().length).toBe(1);
  });

  it("market-refresh NEVER writes stock_user_settings, in any scenario", async () => {
    for (const mode of ["optin", "optout", "norow", "http500"]) {
      settingsMode = mode; notifState = null; calls = [];
      await run();
      expect(settingsWrites(), `mode ${mode}`).toEqual([]);
    }
  });

  it("market-refresh never writes the legacy user fields back into the stocks_data blob", async () => {
    await run();
    const blobWrite = calls.find(c => c.method === "POST" && c.url.includes("/rest/v1/col_prefs") && c.body?.id === "stocks_data");
    expect(blobWrite).toBeTruthy();
    for (const entry of Object.values(blobWrite.body.cols)) {
      for (const k of ["autoSto", "earningsDate", "iv"]) expect(entry).not.toHaveProperty(k);
    }
  });

  it("source — the scanner never references the legacy blob autoSto flag", () => {
    const src = fs.readFileSync(path.resolve("api/market-refresh.js"), "utf8");
    expect(src).not.toMatch(/\.autoSto\b/);
    expect(src).toContain("loadStockUserSettings({ supabaseUrl: SUPABASE_URL, serviceKey: SUPABASE_SVC_KEY })");
  });
});

// ═══ (B) client module ═══════════════════════════════════════════════════════════
function fakeSupabase({ selectResult, upsertResult }) {
  const calls = [];
  return {
    calls,
    from(table) {
      const ctx = { table };
      const b = {
        select(cols) { ctx.op ??= "select"; ctx.cols = cols; calls.push(ctx); return ctx.op === "upsert" ? Promise.resolve(upsertResult) : Promise.resolve(selectResult); },
        upsert(row, opts) { ctx.op = "upsert"; ctx.row = row; ctx.opts = opts; return b; },
      };
      return b;
    },
  };
}

describe("src/lib/stockUserSettings.js — saveUserSetting", () => {
  it("positive — maps UI fields to columns and upserts ONE row on ticker, sending only the changed columns", async () => {
    const sb = fakeSupabase({ upsertResult: { data: [{ ticker: "NVDA" }], error: null } });
    await saveUserSetting(sb, "nvda", { autoSto: true });
    const c = sb.calls[0];
    expect(c.table).toBe("stock_user_settings");
    expect(c.row).toEqual({ ticker: "NVDA", auto_sto: true });          // no other columns => others untouched on conflict
    expect(c.opts).toEqual({ onConflict: "ticker" });
  });

  it("positive — earnings date and IV map to their columns; null clears them", async () => {
    const sb = fakeSupabase({ upsertResult: { data: [{ ticker: "AMD" }], error: null } });
    await saveUserSetting(sb, "AMD", { earningsDate: "2026-11-20", iv: 41.5 });
    expect(sb.calls[0].row).toEqual({ ticker: "AMD", earnings_date: "2026-11-20", iv_manual: 41.5 });
    await saveUserSetting(sb, "AMD", { earningsDate: null, iv: null });
    expect(sb.calls[1].row).toEqual({ ticker: "AMD", earnings_date: null, iv_manual: null });
  });

  it("negative — a database error throws a user-facing StocksDataError (never swallowed)", async () => {
    const sb = fakeSupabase({ upsertResult: { data: null, error: { message: "new row violates row-level security policy", code: "42501" } } });
    await expect(saveUserSetting(sb, "NVDA", { autoSto: true })).rejects.toMatchObject({
      name: "StocksDataError", code: "42501", message: expect.stringContaining("could not save NVDA settings"),
    });
  });

  it("negative — the database 'accepting' the request but changing no row (silent RLS no-op) is an error", async () => {
    const sb = fakeSupabase({ upsertResult: { data: [], error: null } });
    await expect(saveUserSetting(sb, "NVDA", { autoSto: true })).rejects.toThrow(/changed no row/);
  });

  it("negative — validation: bad ticker, non-boolean autoSto, bad date, out-of-range IV, unknown field, empty patch", async () => {
    const sb = fakeSupabase({ upsertResult: { data: [{ ticker: "X" }], error: null } });
    await expect(saveUserSetting(sb, "not a ticker!", { autoSto: true })).rejects.toThrow(/not a valid ticker/);
    await expect(saveUserSetting(sb, "", { autoSto: true })).rejects.toThrow(/not a valid ticker/);
    await expect(saveUserSetting(sb, "NVDA", { autoSto: "true" })).rejects.toThrow(/true or false/);
    await expect(saveUserSetting(sb, "NVDA", { autoSto: 1 })).rejects.toThrow(/true or false/);
    await expect(saveUserSetting(sb, "NVDA", { earningsDate: "11/20/2026" })).rejects.toThrow(/valid earnings date/);
    await expect(saveUserSetting(sb, "NVDA", { iv: 5000 })).rejects.toThrow(/IV must be/);
    await expect(saveUserSetting(sb, "NVDA", { iv: "abc" })).rejects.toThrow(/IV must be/);
    await expect(saveUserSetting(sb, "NVDA", { shares: 5 })).rejects.toThrow(/not a user setting/);
    await expect(saveUserSetting(sb, "NVDA", {})).rejects.toThrow(/nothing to save/);
    expect(sb.calls.length).toBe(0);                                      // nothing invalid ever reached the database
  });

  it("edge — field map is exactly the three user-owned fields; market data fields are NOT user settings", () => {
    expect(USER_SETTING_FIELDS).toEqual({ autoSto: "auto_sto", earningsDate: "earnings_date", iv: "iv_manual" });
    for (const f of ["shares", "sharesByAcct", "currentPrice", "sharesSchwab", "sharesEtrade", "bid", "ask"]) expect(isUserSettingField(f)).toBe(false);
    expect(isUserSettingField("hasOwnProperty")).toBe(false);
  });
});

describe("src/lib/stockUserSettings.js — loadUserSettingsChecked", () => {
  it("positive — returns settings keyed by upper-case ticker with strict booleans", async () => {
    const sb = fakeSupabase({ selectResult: { data: [{ ticker: "nvda", auto_sto: true, earnings_date: "2026-11-20", iv_manual: "41.5" }], error: null } });
    const r = await loadUserSettingsChecked(sb);
    expect(r).toEqual({ ok: true, settings: { NVDA: { auto_sto: true, earnings_date: "2026-11-20", iv_manual: 41.5 } }, error: null });
  });

  it("negative — a query error is ok:false (NOT ok with empty settings), so the UI can block edits", async () => {
    const sb = fakeSupabase({ selectResult: { data: null, error: { message: 'relation "stock_user_settings" does not exist', code: "42P01" } } });
    const r = await loadUserSettingsChecked(sb);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("does not exist");
  });

  it("negative — a thrown exception is ok:false", async () => {
    expect((await loadUserSettingsChecked({ from() { throw new Error("offline"); } })).ok).toBe(false);
  });
});

describe("src/lib/stockUserSettings.js — mergeUserSettings (display overlay)", () => {
  const blob = {
    NVDA: { shares: 322, autoSto: false, iv: 99, earningsDate: "2020-01-01" },     // stale legacy values in the blob
    AMD: { shares: 220, autoSto: true },
    __cash__: { etrade: 5 },
  };
  const settings = { NVDA: { auto_sto: true, earnings_date: "2026-11-20", iv_manual: 41.5 } };

  it("positive — settings win over legacy blob values for the three user fields; market fields untouched", () => {
    const m = mergeUserSettings(blob, settings);
    expect(m.NVDA).toEqual({ shares: 322, autoSto: true, earningsDate: "2026-11-20", iv: 41.5 });
  });

  it("negative — a ticker with NO settings row shows auto-STO off and legacy values cleared (legacy blob true is not trusted)", () => {
    const m = mergeUserSettings(blob, settings);
    expect(m.AMD).toEqual({ shares: 220, autoSto: false, earningsDate: null, iv: null });
  });

  it("edge — tickers present only in settings are added; __cash__ passes through untouched", () => {
    const m = mergeUserSettings(blob, { ...settings, NEW: { auto_sto: true, earnings_date: null, iv_manual: null } });
    expect(m.NEW).toEqual({ autoSto: true, earningsDate: null, iv: null });
    expect(m.__cash__).toEqual({ etrade: 5 });
  });

  it("edge — null/undefined inputs do not throw; inputs are not mutated", () => {
    expect(mergeUserSettings(null, null)).toEqual({});
    const before = JSON.stringify(blob);
    mergeUserSettings(blob, settings);
    expect(JSON.stringify(blob)).toBe(before);
  });
});

// ═══ (C) UI wiring ═══════════════════════════════════════════════════════════════
const ui = fs.readFileSync(path.resolve("src/pri-tod-v3.jsx"), "utf8");
function between(a, b) {
  const s = ui.indexOf(a); expect(s, `missing: ${a}`).toBeGreaterThan(-1);
  const e = ui.indexOf(b, s + a.length); expect(e, `missing: ${b}`).toBeGreaterThan(s);
  return ui.slice(s, e);
}

describe("src/pri-tod-v3.jsx — user settings go to their own table, one row at a time", () => {
  it("positive — updateStockData routes autoSto/earningsDate/iv to persistUserSetting, everything else to the blob patch", () => {
    const fn = between("const updateStockData = async", "// ── E*TRADE live data");
    expect(fn).toContain("isUserSettingField(field)");
    expect(fn).toContain("? await persistUserSetting(`${ticker} ${field}`, ticker, { [field]: value })");
    expect(fn).toContain(": await persistStocksData(`${ticker} ${field}`, setTickerFields(ticker, { [field]: value }))");
  });

  it("negative — no user-owned field is ever written into the stocks_data blob from the UI", () => {
    expect(ui).not.toMatch(/setTickerFields\([^)]*autoSto/);
    expect(ui).not.toMatch(/setTickerFields\([^)]*earningsDate/);
    expect(ui).not.toMatch(/setTickerFields\([^)]*\biv\b/);
    // Add Stock's earnings date goes to settings, and is not part of the blob `fields`
    const add = between("ADD / UPDATE STOCK", "SAVE</button>");
    expect(add).toContain("persistUserSetting(`add ${t} earnings date`, t, {earningsDate})");
    expect(add).not.toMatch(/const fields=\{[^}]*earningsDate/);
  });

  it("positive — settings are loaded with the checked loader and overlaid onto the blob for display", () => {
    expect(ui).toContain("loadUserSettingsChecked(supabase)");
    expect(ui).toContain("mergeUserSettings(sdData?.cols || {}, usData?.ok ? usData.settings : {})");
  });

  it("negative — a failed settings load blocks edits (status gate) and tells the user; it never defaults to 'ready'", () => {
    expect(ui).toContain('const [userSettingsStatus, setUserSettingsStatus] = useState("loading");');
    const persist = between("const persistUserSetting = async", "// Persist a small change to stocks_data");
    expect(persist).toContain('if (userSettingsStatus !== "ready")');
    expect(persist.indexOf('userSettingsStatus !== "ready"')).toBeLessThan(persist.indexOf("saveUserSetting("));
    expect(persist).toContain("setSaveError(`NOT SAVED");
    const apply = between("if (usData?.ok) {", "if (wlData?.cols?.tickers)");
    expect(apply).toContain('setUserSettingsStatus("error")');
    expect(apply).toContain("nothing was changed");
  });

  it("positive — a failed user-setting save rolls the optimistic toggle back", () => {
    const fn = between("const updateStockData = async", "// ── E*TRADE live data");
    expect(fn).toContain("if (!ok) setStocksData(");
  });
});

// ═══ (D) SQL structure (not executed) ════════════════════════════════════════════
const sqlRead = f => fs.readFileSync(path.resolve("sql/stocks_integrity", f), "utf8");
const noComments = s => s.replace(/--[^\n]*/g, "");

describe("sql/stocks_integrity — stock_user_settings migration, backfill, rollback (structural only)", () => {
  const mig = sqlRead("002_stock_user_settings.sql"), migCode = noComments(mig);
  const fill = sqlRead("003_backfill_stock_user_settings.sql"), fillCode = noComments(fill);
  const back = noComments(sqlRead("002_rollback_stock_user_settings.sql"));
  const aud = noComments(sqlRead("004_audit_stock_user_settings.sql"));

  it("all four are marked NOT APPLIED / clearly delivered as SQL only", () => {
    expect(mig).toMatch(/STATUS: NOT APPLIED/);
    expect(fill).toMatch(/STATUS: NOT APPLIED/);
  });

  it("table has the requested columns, ticker PK, opt-in default false, and sane constraints", () => {
    expect(migCode).toMatch(/create table if not exists public\.stock_user_settings/);
    for (const c of ["ticker", "auto_sto", "earnings_date", "iv_manual", "created_at", "updated_at"]) expect(migCode).toContain(c);
    expect(migCode).toMatch(/ticker\s+text\s+primary key/);
    expect(migCode).toMatch(/auto_sto\s+boolean\s+not null default false/);
    expect(migCode).toContain("ticker = upper(ticker)");
  });

  it("RLS on; anon gets nothing; authenticated read for allow-listed users, write for admin/trader only", () => {
    expect(migCode).toContain("alter table public.stock_user_settings enable row level security");
    expect(migCode).toMatch(/revoke all on public\.stock_user_settings from public, anon/);
    expect(migCode).toMatch(/for select to authenticated using \(public\.is_app_user\(\)\)/);
    expect(migCode).toMatch(/app_role\(\) in \('admin','trader'\)/);
    expect(migCode).not.toMatch(/to anon/);
  });

  it("backfill is idempotent and per-row fault tolerant", () => {
    expect(fillCode).toContain("on conflict (ticker) do nothing");
    expect(fillCode).toMatch(/exception when others then/);
  });

  it("backfill SEEDS today's production-eligible symbols by default (preserves current behavior)", () => {
    expect(fillCode).toContain("seed_legacy_eligibility constant boolean := true");
    // auto_sto = explicit true OR (not explicitly false AND >= 100 shares) — the old rule, verbatim
    expect(fillCode).toMatch(/v_auto := \(\(r\.v->>'autoSto'\) = 'true'\)\s+or \(seed_legacy_eligibility\s+and \(r\.v->>'autoSto'\) is distinct from 'false'\s+and v_shares >= 100\);/);
    // same total-shares rule as tickerUniverse.totalShares(): sharesByAcct when non-empty, else shares
    expect(fillCode).toContain("jsonb_typeof(r.v->'sharesByAcct') = 'object' and r.v->'sharesByAcct' <> '{}'::jsonb");
    expect(fillCode).toContain("v_shares := coalesce((r.v->>'shares')::numeric, 0)");
  });

  it("an explicit autoSto=false is never flipped to true by seeding, and sub-100-share tickers get no inferred true", () => {
    // the only way v_auto becomes true without an explicit 'true' goes through `is distinct from 'false'` AND `v_shares >= 100`
    const auto = fillCode.match(/v_auto := [^;]*;/)[0];
    expect(auto).toContain("is distinct from 'false'");
    expect(auto).toContain("v_shares >= 100");
    expect(auto).not.toMatch(/or true|:= true;/);
  });

  it("the strict opt-in alternative is a one-word switch, and the preview + 3 verification queries are provided", () => {
    expect(fill).toMatch(/set seed_legacy_eligibility := false/);
    expect(fill).toContain("PREVIEW (read-only)");
    expect(fill).toContain("will_be_auto_sto");
    expect(fill).toMatch(/\(a\) Anything eligible under the OLD rule that is NOT opted in now/);
    expect(fill).toMatch(/\(b\) Anything opted in now that the OLD rule would NOT have traded/);
    expect(fill).toMatch(/\(c\) The final opted-in list/);
  });

  it("documents the production snapshot it was written against (10 symbols), including AMD staying false", () => {
    expect(fill).toContain("AAPL, AMZN, CAT, CEG, JPM, MCD, NVDA, SPCX, TSLA, WDC");
    expect(fill).toMatch(/AMD has autoSto=false in the blob and stays false/);
  });

  it("backfill never modifies or deletes anything in col_prefs (legacy fields stay for rollback)", () => {
    expect(fillCode).not.toMatch(/\bupdate\s+public\.col_prefs\b/i);
    expect(fillCode).not.toMatch(/\bdelete\s+from\b/i);
    expect(fillCode).not.toMatch(/\btruncate\b/i);
  });

  it("rollback copies settings back into the blob inside a transaction, then drops only its own objects", () => {
    expect(back).toMatch(/^\s*begin;/m);
    expect(back).toMatch(/commit;\s*$/);
    expect(back).toContain("jsonb_build_object('autoSto', s.auto_sto)");
    expect(back.match(/drop table[^;]*;/g)).toEqual(["drop table    if exists public.stock_user_settings;"]);
  });

  it("004 audit trigger is optional, never logs anything but the three user columns, and is SECURITY DEFINER", () => {
    expect(aud).toContain("fields  constant text[] := array['auto_sto','earnings_date','iv_manual']");
    expect(aud).toMatch(/security definer\s+set search_path = public, pg_temp/);
    expect(aud).toContain("'stock_user_settings'");
  });
});

// ═══ (E) seeding-rule parity ═════════════════════════════════════════════════════
// IMPORTANT: this tests a JavaScript MIRROR of the rule written in 003_backfill_stock_user_settings.sql,
// against the REAL deriveTickerUniverse. It proves the RULE preserves today's behavior; it does NOT
// execute the SQL (which was never run). Fixture = read-only snapshot of production stocks_data, 2026-11-11.
describe("seeding rule parity — JS mirror of 003's rule vs the real scanner (SQL itself not executed)", () => {
  const PROD_SNAPSHOT = {
    AAPL: { autoSto: true,  sharesByAcct: { "ETrade 6917": 226 } },
    AMZN: { autoSto: true,  sharesByAcct: { "ETrade 6917": 300, "Schwab 3866": 700 } },
    CAT:  { autoSto: true,  sharesByAcct: { "Schwab 3866": 101.0406 } },
    CEG:  { autoSto: true,  sharesByAcct: { "ETrade 6917": 100 } },
    JPM:  { autoSto: true,  sharesByAcct: { "Schwab 3866": 217.0498 } },
    MCD:  {                 sharesByAcct: { "ETrade 8222": 100 } },          // never set
    NVDA: { autoSto: true,  sharesByAcct: { "ETrade 6917": 322 } },
    SPCX: {                 sharesByAcct: { "ETrade 6917": 100 } },          // never set
    TSLA: {                 sharesByAcct: { "Schwab 3866": 100 } },          // never set
    WDC:  { autoSto: true,  sharesByAcct: { "Schwab 3866": 103.0564 } },
    AMD:  { autoSto: false, sharesByAcct: { "ETrade 6917": 200, "ETrade 8222": 20 } },
    OKLO: { autoSto: true,  shares: 1 },
    COST: {                 sharesByAcct: { "ETrade 6917": 9 } },            // < 100, never set
    XYZ:  { autoSto: null,  shares: 150 },                                   // JSON null counts as "not set"
  };

  // mirror of 003: sum(sharesByAcct) if non-empty else shares
  const totalShares = sd => (sd.sharesByAcct && Object.keys(sd.sharesByAcct).length)
    ? Object.values(sd.sharesByAcct).reduce((a, n) => a + (+n || 0), 0) : (+sd.shares || 0);
  // mirror of 003's v_auto expression
  const seed = (blob, seedLegacy = true) => Object.fromEntries(Object.entries(blob).map(([t, sd]) => [
    t, { auto_sto: sd.autoSto === true || (seedLegacy && sd.autoSto !== false && totalShares(sd) >= 100) },
  ]));
  // the OLD production rule, expressed with the real share filter: >=100 shares AND autoSto !== false
  const oldEligible = async blob => {
    const { deriveTickerUniverse } = await import("../api/_lib/tickerUniverse.js");
    const { coveredCallEligible } = deriveTickerUniverse({ stocksData: blob });
    return coveredCallEligible.filter(t => blob[t]?.autoSto !== false);
  };

  it("positive — after seeding, the new opt-in scanner is eligible for EXACTLY the symbols the old rule traded (the 10 production symbols + one synthetic JSON-null case)", async () => {
    const { deriveTickerUniverse } = await import("../api/_lib/tickerUniverse.js");
    const before = await oldEligible(PROD_SNAPSHOT);
    const after = deriveTickerUniverse({ stocksData: PROD_SNAPSHOT, userSettings: seed(PROD_SNAPSHOT) }).autoStoEligible;
    expect(before).toEqual(["AAPL", "AMZN", "CAT", "CEG", "JPM", "MCD", "NVDA", "SPCX", "TSLA", "WDC", "XYZ"]);
    expect(after).toEqual(before);
  });

  it("negative — AMD (explicit false) and COST (< 100 shares) are NOT eligible after seeding; OKLO (explicit true, 1 share) is carried but not tradable", async () => {
    const { deriveTickerUniverse } = await import("../api/_lib/tickerUniverse.js");
    const settings = seed(PROD_SNAPSHOT);
    const { autoStoEligible } = deriveTickerUniverse({ stocksData: PROD_SNAPSHOT, userSettings: settings });
    expect(settings.AMD.auto_sto).toBe(false);
    expect(settings.COST.auto_sto).toBe(false);
    expect(settings.OKLO.auto_sto).toBe(true);
    for (const t of ["AMD", "COST", "OKLO"]) expect(autoStoEligible).not.toContain(t);
  });

  it("edge — with the strict switch (seed_legacy_eligibility := false) only explicit trues carry over, so never-set tickers drop out", async () => {
    const { deriveTickerUniverse } = await import("../api/_lib/tickerUniverse.js");
    const { autoStoEligible } = deriveTickerUniverse({ stocksData: PROD_SNAPSHOT, userSettings: seed(PROD_SNAPSHOT, false) });
    expect(autoStoEligible).toEqual(["AAPL", "AMZN", "CAT", "CEG", "JPM", "NVDA", "WDC"]);
    for (const t of ["MCD", "SPCX", "TSLA", "XYZ"]) expect(autoStoEligible).not.toContain(t);
  });

  it("auto_sto = null is NOT eligible (the column is NOT NULL, and the scanner would reject null anyway)", async () => {
    const { deriveTickerUniverse } = await import("../api/_lib/tickerUniverse.js");
    const { autoStoEligible } = deriveTickerUniverse({ stocksData: { NVDA: { shares: 322 } }, userSettings: { NVDA: { auto_sto: null } } });
    expect(autoStoEligible).toEqual([]);
  });
});

describe("docs/STOCKS_DATA_OWNERSHIP.md", () => {
  const doc = fs.readFileSync(path.resolve("docs/STOCKS_DATA_OWNERSHIP.md"), "utf8");
  it("documents the ownership matrix, the deploy order, and the known gaps", () => {
    expect(doc).toContain("market-refresh never writes `stock_user_settings`");
    expect(doc).toContain("## Deploy order");
    expect(doc).toContain("## Known gaps");
    expect(doc).toContain("explicit opt-in");
  });
});
