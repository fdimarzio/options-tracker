// tests/stocks-data-write-safety.test.js
// P2 of the stocks_data integrity work — every stocks_data write is checked, nothing is
// swallowed, the user sees failures, and a failed initial load cannot look like an empty DB.
//   (A) client: source guards over src/pri-tod-v3.jsx (can't be imported under Vitest)
//   (B) server: the REAL api/market-refresh.js handler run against a stubbed network,
//       with the stocks_data write forced to fail.
// Run: npx vitest run tests/stocks-data-write-safety.test.js

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";

const src = fs.readFileSync(path.resolve("src/pri-tod-v3.jsx"), "utf8");

function between(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  expect(s, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
  const e = src.indexOf(endMarker, s + startMarker.length);
  expect(e, `end marker not found: ${endMarker}`).toBeGreaterThan(s);
  return src.slice(s, e);
}
const EMPTY_CATCH = /catch\s*(\([^)]*\))?\s*\{\s*\}/;

describe("client — no direct, unchecked stocks_data upserts remain", () => {
  it("negative — the browser never upserts the stocks_data row directly (all writes go through patchStocksData)", () => {
    expect(src).not.toMatch(/id\s*:\s*["']stocks_data["']/);
  });

  it("negative — the only stocks_data persistence call is the CAS helper", () => {
    expect(src).toContain("await patchStocksData(supabase, mutator);");
    expect((src.match(/patchStocksData\(/g) || []).length).toBe(1);
  });

  it("negative — no empty catch swallows a stocks_data write at any call site", () => {
    const sites = [
      between("const updateCash = async", "// AI Chat state"),
      between("const addToWatchlist = async", "const removeFromWatchlist"),
      between("const updateStockData = async", "// ── E*TRADE live data"),
      between("// Refresh quotes for all watchlist tickers missing price data", "⟳ Refresh</button>"),
      between("ADD / UPDATE STOCK", "SAVE</button>"),
      between("const persistStocksData = async", "const removeFromWatchlist").slice(0, 900),
    ];
    for (const s of sites) expect(s).not.toMatch(EMPTY_CATCH);
  });
});

describe("client — persistStocksData gating and visibility", () => {
  const persistFn = between("const persistStocksData = async", "const [selectedTicker");

  it("negative — refuses to write until the initial load has verifiably succeeded, and says why", () => {
    expect(persistFn).toContain('if (stocksDataStatus !== "ready")');
    expect(persistFn).toContain("NOT SAVED");
    expect(persistFn).toContain("return false;");
    // the refusal path must come before any write
    expect(persistFn.indexOf('stocksDataStatus !== "ready"')).toBeLessThan(persistFn.indexOf("patchStocksData"));
  });

  it("positive — a failed save is surfaced to the user (banner state) and logged, not swallowed", () => {
    expect(persistFn).toContain("setSaveError(`NOT SAVED (${label}):");
    expect(persistFn).toContain("console.error");
  });

  it("positive — the banner is rendered with role=alert and can be dismissed", () => {
    expect(src).toContain('data-testid="save-error-banner"');
    expect(src).toContain('role="alert"');
    expect(src).toContain("setSaveError(null)");
  });

  it("positive — updateStockData rolls the optimistic UI change back when the save fails", () => {
    const fn = between("const updateStockData = async", "// ── E*TRADE live data");
    expect(fn).toContain("if (!ok) setStocksData(");
  });

  it("positive — Add Stock keeps the form open on a failed save so typed values aren't lost", () => {
    const handler = between("ADD / UPDATE STOCK", "SAVE</button>");
    expect(handler).toContain("if(!ok) return;");
    expect(handler.indexOf("if(!ok) return;")).toBeLessThan(handler.indexOf("setShowAddStock(false)"));
  });
});

describe("client — initial load cannot masquerade as an empty database", () => {
  it("negative — stocks_data is no longer loaded through the error-swallowing loadPrefs", () => {
    expect(src).not.toContain('loadPrefs("stocks_data")');
    expect(src).toContain("loadStocksDataChecked(supabase)");
  });

  it("positive — a failed load sets status=error and tells the user; a successful one sets ready", () => {
    const apply = between("if (sdData?.ok) {", "if (wlData?.cols?.tickers)");
    expect(apply).toContain('setStocksDataStatus("ready")');
    expect(apply).toContain('setStocksDataStatus("error")');
    expect(apply).toContain("setSaveError(");
    expect(apply).toContain("nothing was changed");
  });

  it("negative — status starts as 'loading' (writes blocked) rather than defaulting to ready", () => {
    expect(src).toContain('useState("loading"); // "loading" | "ready" | "error"');
  });
});

describe("client — watchlist saves (same silent-catch class) report failures and roll back", () => {
  const save = between("const saveWatchlist = async", "const addToWatchlist = async");

  it("negative — checks the returned error instead of an inert try/catch, and tells the user", () => {
    expect(save).toContain("const { error } = await supabase.from(\"col_prefs\").upsert");
    expect(save).toContain("if (error)");
    expect(save).toContain("setSaveError(");
    expect(save).toContain("return false;");
  });

  it("positive — add and remove both roll the list back when the save fails", () => {
    expect(src).toContain("if (!(await saveWatchlist(updated, `add ${t} to watchlist`))) setWatchlist(watchlist);");
    expect(src).toContain("if (!(await saveWatchlist(updated, `remove ${ticker} from watchlist`))) setWatchlist(watchlist);");
  });
});

describe("client — Skynet master kill-switch does not flip on a failed save", () => {
  const toggle = between("const v = !on;", "setMasterCtrl(p => ({ ...p, master_enabled: v }));");

  it("negative — checks the update's error and returns before changing on-screen state", () => {
    expect(toggle).toContain("const { error: masterErr } = await supabase.from(\"skynet_controls\")");
    expect(toggle).toContain("if (masterErr)");
    expect(toggle).toContain("return;");
  });

  it("positive — the user is told the switch was NOT changed and what state automation is still in", () => {
    expect(toggle).toContain("The switch was NOT changed");
  });
});

// ── (B) server: market-refresh checks its blob writes ───────────────────────────
const NOW_ISO = "2026-09-01T18:00:00Z";
function makeRes(body, opts = {}) {
  return { ok: opts.ok !== false, status: opts.status ?? 200, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), headers: { get: () => null } };
}
let calls;
let failStocksDataWrite;

async function fetchRouter(url, init = {}) {
  const method = (init && init.method) || "GET";
  let body = null;
  try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
  calls.push({ url: String(url), method, body });

  if (failStocksDataWrite && method === "POST" && url.includes("/rest/v1/col_prefs") && body?.id === "stocks_data") {
    return makeRes({ message: "permission denied for table col_prefs" }, { ok: false, status: 403 });
  }
  if (url.includes("/col_prefs?select=cols&id=eq.schwab_tokens")) return makeRes([{ cols: { accessToken: "t", accessTokenExpiresAt: Date.now() + 3600000 } }]);
  if (url.includes("/trader/v1/accounts/accountNumbers")) return makeRes([{ accountNumber: "12343866", hashValue: "HASH1" }]);
  if (url.includes("/trader/v1/accounts/HASH1") && url.includes("fields=positions")) {
    return makeRes({ securitiesAccount: { positions: [{ instrument: { assetType: "EQUITY", symbol: "INTC" }, longQuantity: 200 }] } });
  }
  if (url.includes("/api/etrade") && url.includes("action=positions")) return makeRes({ positions: [] });
  if (url.includes("/rest/v1/contracts") && url.includes("status=eq.Open")) return makeRes([]);
  if (url.includes("/col_prefs?select=cols&id=eq.stocks_data")) return makeRes([]);
  if (url.includes("/signal_rules?enabled=eq.true")) return makeRes([]);
  if (url.includes("/marketdata/v1/quotes") && url.includes("symbols=INTC")) {
    return makeRes({ INTC: { quote: { lastPrice: 35, netPercentChange: 1.5, bidPrice: 34.9, askPrice: 35.1, highPrice: 35.5, lowPrice: 34, openPrice: 34.5, totalVolume: 1000000 } } });
  }
  if (url.includes("pushover")) return makeRes({ status: 1 });
  return method === "GET" ? makeRes([]) : makeRes({});
}

describe("server — api/market-refresh.js checks and reports its stocks_data write", () => {
  let handler;
  const runHandler = async () => {
    const req = { method: "GET", query: { force: "1" }, headers: { "x-cron-secret": "test-secret" } };
    let statusCode = null;
    const res = { setHeader: () => {}, status(c) { statusCode = c; return this; }, json() { return this; }, end() { return this; } };
    await handler(req, res);
    return statusCode;
  };
  const heartbeat = () => calls.filter(c => c.url.includes("ecosystem_heartbeat") && c.body?.agent_name === "market-refresh").at(-1)?.body;

  beforeAll(async () => {
    process.env.VITE_SUPABASE_URL = "https://fake-project.supabase.co";
    process.env.VITE_SUPABASE_ANON_KEY = "fake-anon-key";
    process.env.SUPABASE_SERVICE_KEY = "fake-service-key";
    process.env.PUSHOVER_API_TOKEN = "fake"; process.env.PUSHOVER_USER_KEY = "fake";
    process.env.CRON_SECRET = "test-secret";
    ({ default: handler } = await import("../api/market-refresh.js"));
  });
  beforeEach(() => {
    calls = []; failStocksDataWrite = false;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW_ISO));
    vi.stubGlobal("fetch", vi.fn(fetchRouter));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("positive — a successful run still writes the blob and records heartbeat status ok", async () => {
    expect(await runHandler()).not.toBeNull();
    const write = calls.find(c => c.method === "POST" && c.url.includes("/rest/v1/col_prefs") && c.body?.id === "stocks_data");
    expect(write, "stocks_data blob should be written").toBeTruthy();
    expect(write.body.cols.INTC.shares).toBe(200);
    expect(heartbeat()).toMatchObject({ status: "ok" });
    expect(heartbeat().notes).not.toContain("WRITE FAILED");
  });

  it("negative — a rejected stocks_data write is logged and flips the heartbeat to error (the watchdog alerts on non-ok)", async () => {
    failStocksDataWrite = true;
    await runHandler();
    const hb = heartbeat();
    expect(hb, "heartbeat should still be written").toBeTruthy();
    expect(hb.status).toBe("error");
    expect(hb.notes).toContain("WRITE FAILED: stocks_data (403)");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("stocks_data write FAILED: 403"));
  });

  it("negative — the failure does not abort the run (trading logic is unaffected by a blob write failure)", async () => {
    failStocksDataWrite = true;
    const status = await runHandler();
    expect(status).not.toBe(500);
  });
});
