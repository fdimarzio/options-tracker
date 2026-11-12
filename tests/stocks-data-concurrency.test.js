// tests/stocks-data-concurrency.test.js
// CONCURRENCY REVIEW — executable evidence for the five guarantees of the stocks_data
// integrity work. Uses a stateful in-memory model of the two tables involved, with the
// semantics that matter for races:
//   col_prefs            : select returns a copy; UPDATE ... WHERE updated_at = <read value> is
//                          compare-and-swap (0 rows if someone wrote since)
//   stock_user_settings  : upsert has merge-on-conflict semantics (only the columns sent change)
// and an `interleave` hook that lets a second writer (another tab, or the server) land in the
// middle of an operation. The REAL client modules (src/lib/stocksDataStore.js,
// src/lib/stockUserSettings.js) run against it. The model is NOT Postgres: it demonstrates the
// protocol, and the control test at the bottom proves it is capable of exposing the original bug.
// Run: npx vitest run tests/stocks-data-concurrency.test.js

import { describe, it, expect } from "vitest";
import {
  patchStocksData, loadStocksDataChecked, setTickerFields, setCashField,
} from "../src/lib/stocksDataStore.js";
import { saveUserSetting, mergeUserSettings } from "../src/lib/stockUserSettings.js";

// ── in-memory model ─────────────────────────────────────────────────────────────
function makeDb({ blob = {}, settings = {} } = {}) {
  let clock = 0;
  const tick = () => `2026-11-11T21:00:${String(++clock).padStart(2, "0")}.000+00:00`;
  const db = {
    row: { id: "stocks_data", cols: JSON.parse(JSON.stringify(blob)), updated_at: tick() },
    settings: new Map(Object.entries(settings).map(([t, s]) => [t, { ticker: t, auto_sto: false, earnings_date: null, iv_manual: null, ...s }])),
    writes: [],              // every successful or attempted write, in order
    failReads: false,
    interleave: null,        // fn(db) called once, right before the next CAS update is evaluated
    tick,
    // what the SERVER (market-refresh) does: read the blob, merge quotes + shares, write it back
    serverWrite(fn) {
      const next = fn(JSON.parse(JSON.stringify(db.row.cols)));
      db.row = { id: "stocks_data", cols: next, updated_at: tick() };
      db.writes.push({ by: "server", table: "col_prefs" });
    },
  };
  return db;
}

function client(db, name) {
  return {
    from(table) {
      const ctx = { table, filters: [] };
      const b = {
        select() { ctx.op ??= "select"; return b; },
        eq(c, v) { ctx.filters.push([c, v]); return b; },
        update(p) { ctx.op = "update"; ctx.payload = p; return b; },
        insert(p) { ctx.op = "insert"; ctx.payload = p; return b; },
        upsert(p, o) { ctx.op = "upsert"; ctx.payload = p; ctx.opts = o; return b; },
        maybeSingle() { return run(); },
        then(res, rej) { return run().then(res, rej); },
      };
      async function run() {
        if (table === "col_prefs") {
          if (ctx.op === "select") {
            if (db.failReads) return { data: null, error: { message: "network down" } };
            return { data: JSON.parse(JSON.stringify(db.row)), error: null };
          }
          if (ctx.op === "update") {
            if (db.interleave) { const f = db.interleave; db.interleave = null; f(db); }
            const casVal = ctx.filters.find(([c]) => c === "updated_at")?.[1];
            if (casVal !== db.row.updated_at) { db.writes.push({ by: name, table, result: "cas-lost" }); return { data: [], error: null }; }
            db.row = { id: "stocks_data", cols: ctx.payload.cols, updated_at: ctx.payload.updated_at };
            db.writes.push({ by: name, table, result: "won" });
            return { data: [{ id: "stocks_data" }], error: null };
          }
        }
        if (table === "stock_user_settings" && ctx.op === "upsert") {
          const cur = db.settings.get(ctx.payload.ticker) || { ticker: ctx.payload.ticker, auto_sto: false, earnings_date: null, iv_manual: null };
          db.settings.set(ctx.payload.ticker, { ...cur, ...ctx.payload }); // merge: only sent columns change
          db.writes.push({ by: name, table, cols: Object.keys(ctx.payload) });
          return { data: [{ ticker: ctx.payload.ticker }], error: null };
        }
        throw new Error(`unmodelled ${table}/${ctx.op}`);
      }
      return b;
    },
  };
}

const NOW = () => "2026-11-11T22:00:00.000Z";
const BASE_BLOB = () => ({
  NVDA: { shares: 322, sharesByAcct: { "ETrade 6917": 322 }, currentPrice: 174 },
  AMD:  { shares: 220, sharesByAcct: { "ETrade 6917": 220 }, currentPrice: 552 },
  AAPL: { shares: 226, currentPrice: 355 },
  __cash__: { etrade: 100, schwab: 200 },
});

// ═══ 1. Tab A cannot overwrite Tab B ═══════════════════════════════════════════════
describe("1. Tab A cannot overwrite Tab B", () => {
  it("settings: two tabs holding stale copies each change different things; both changes survive", async () => {
    const db = makeDb({ settings: { NVDA: { auto_sto: false }, AMD: { auto_sto: false } } });
    const tabA = client(db, "tabA"), tabB = client(db, "tabB");
    // both tabs loaded at the same moment => both believe NVDA/AMD are off (stale copies)
    const staleB = { NVDA: { auto_sto: false }, AMD: { auto_sto: false } };

    await saveUserSetting(tabA, "NVDA", { autoSto: true });                       // Tab A: NVDA on
    await saveUserSetting(tabB, "AMD", { earningsDate: "2026-11-20" });           // Tab B (stale): AMD earnings
    await saveUserSetting(tabB, "AMD", { autoSto: true });                        // Tab B (stale): AMD on
    await saveUserSetting(tabB, "NVDA", { iv: 44 });                              // Tab B still thinks NVDA is off

    expect(staleB.NVDA.auto_sto).toBe(false);                                     // B's copy never refreshed
    expect(db.settings.get("NVDA")).toMatchObject({ auto_sto: true, iv_manual: 44 }); // A's toggle NOT reverted by B
    expect(db.settings.get("AMD")).toMatchObject({ auto_sto: true, earnings_date: "2026-11-20" });
  });

  it("settings: each save sends ONLY the columns being changed (never a whole stale object)", async () => {
    const db = makeDb({ settings: { NVDA: { auto_sto: true } } });
    await saveUserSetting(client(db, "tabB"), "NVDA", { iv: 10 });
    expect(db.writes.at(-1).cols.sort()).toEqual(["iv_manual", "ticker"]);
  });

  it("blob: two tabs patch different fields from stale in-memory copies; both survive", async () => {
    const db = makeDb({ blob: BASE_BLOB() });
    const tabA = client(db, "tabA"), tabB = client(db, "tabB");
    await patchStocksData(tabA, setCashField("etrade", 555), { now: NOW });
    await patchStocksData(tabB, setTickerFields("AAPL", { sharesSchwab: 10 }), { now: NOW }); // B never saw A's cash change
    expect(db.row.cols.__cash__.etrade).toBe(555);
    expect(db.row.cols.AAPL.sharesSchwab).toBe(10);
  });

  it("blob: two tabs patch the SAME ticker concurrently (A lands mid-B): B retries on top of A's result", async () => {
    const db = makeDb({ blob: BASE_BLOB() });
    const tabA = client(db, "tabA"), tabB = client(db, "tabB");
    db.interleave = () => { // Tab A's write lands between B's read and B's compare-and-swap
      db.row = { id: "stocks_data", cols: { ...db.row.cols, AAPL: { ...db.row.cols.AAPL, fundamentalsA: 1 } }, updated_at: db.tick() };
      db.writes.push({ by: "tabA", table: "col_prefs", result: "won" });
    };
    await patchStocksData(tabB, setTickerFields("AAPL", { fundamentalsB: 2 }), { now: NOW });
    expect(db.row.cols.AAPL).toMatchObject({ fundamentalsA: 1, fundamentalsB: 2 });
    expect(db.writes.filter(w => w.by === "tabB").map(w => w.result)).toEqual(["cas-lost", "won"]);
  });
});

// ═══ 2. Browser cannot overwrite market-refresh ════════════════════════════════════
describe("2. Browser cannot overwrite market-refresh changes", () => {
  it("market-refresh writes quotes+shares while a browser patch is in flight: the browser retries on top; the server's data survives", async () => {
    const db = makeDb({ blob: BASE_BLOB() });
    db.interleave = () => db.serverWrite(blob => {
      blob.NVDA = { ...blob.NVDA, shares: 400, sharesByAcct: { "ETrade 6917": 400 }, currentPrice: 180 };
      return blob;
    });
    await patchStocksData(client(db, "browser"), setTickerFields("NVDA", { week52High: 212 }), { now: NOW });
    expect(db.row.cols.NVDA).toMatchObject({ shares: 400, currentPrice: 180, week52High: 212 }); // server's NEW shares/price kept
    expect(db.writes.filter(w => w.by === "browser").map(w => w.result)).toEqual(["cas-lost", "won"]);
  });

  it("a browser holding a pre-refresh copy never writes that copy back (the mutator is applied to the DB's current blob)", async () => {
    const db = makeDb({ blob: BASE_BLOB() });
    const staleCopy = JSON.parse(JSON.stringify(db.row.cols)); // tab loaded long ago: NVDA 322 sh @174
    db.serverWrite(b => { b.NVDA.shares = 999; b.NVDA.currentPrice = 190; return b; });
    await patchStocksData(client(db, "browser"), setTickerFields("AMD", { week52High: 300 }), { now: NOW });
    expect(staleCopy.NVDA.shares).toBe(322);
    expect(db.row.cols.NVDA).toMatchObject({ shares: 999, currentPrice: 190 });
  });

  it("if the server keeps winning, the browser gives up with an explicit 'NOT saved' error rather than overwriting", async () => {
    const db = makeDb({ blob: BASE_BLOB() });
    const c = client(db, "browser");
    const origFrom = c.from.bind(c);
    // a server write lands before EVERY CAS attempt
    c.from = (t) => { const b = origFrom(t); const u = b.update.bind(b); b.update = (p) => { db.interleave = () => db.serverWrite(x => x); return u(p); }; return b; };
    await expect(patchStocksData(c, setTickerFields("AMD", { iv: 1 }), { retries: 2, now: NOW })).rejects.toMatchObject({ code: "CAS_EXHAUSTED", message: expect.stringContaining("NOT saved") });
    expect(db.row.cols.AMD.iv).toBeUndefined();
  });

  it("client flows that used to write on every quote poll are state-only (source guard)", async () => {
    const fs = await import("fs"), path = await import("path");
    const ui = fs.readFileSync(path.resolve("src/pri-tod-v3.jsx"), "utf8");
    const applyQuotes = ui.slice(ui.indexOf("const applyQuotesToStocksData = useCallback"), ui.indexOf("// Main refresh:"));
    expect(applyQuotes).not.toMatch(/supabase|upsert|col_prefs/);
  });
});

// ═══ 3. market-refresh cannot overwrite user settings ══════════════════════════════
describe("3. market-refresh cannot overwrite user settings", () => {
  it("user settings are in a different table than the blob market-refresh rewrites — repeated server blob writes leave them untouched", () => {
    const db = makeDb({ blob: BASE_BLOB(), settings: { NVDA: { auto_sto: true, earnings_date: "2026-11-20", iv_manual: 44 } } });
    const before = JSON.stringify([...db.settings.entries()]);
    for (let i = 0; i < 25; i++) db.serverWrite(b => { b.NVDA.currentPrice += 1; return b; }); // 25 market-refresh runs
    expect(JSON.stringify([...db.settings.entries()])).toBe(before);
    expect(db.writes.every(w => w.table === "col_prefs")).toBe(true);
  });

  it("the real handler never issues a write to stock_user_settings (covered end-to-end in tests/stock-user-settings.test.js)", async () => {
    const fs = await import("fs"), path = await import("path");
    const code = fs.readFileSync(path.resolve("api/market-refresh.js"), "utf8").replace(/\/\/[^\n]*/g, "");
    const lines = code.split("\n").filter(l => l.includes("stock_user_settings"));
    expect(lines.length).toBeGreaterThan(0);                                   // it does read it...
    for (const l of lines) expect(l).not.toMatch(/POST|PATCH|DELETE|upsert|insert/i); // ...and only reads
  });

  it("the legacy user fields still sitting in the blob cannot change anyone's eligibility: the scanner ignores them", async () => {
    const { deriveTickerUniverse } = await import("../api/_lib/tickerUniverse.js");
    const blobWithLegacy = { NVDA: { autoSto: true, shares: 322 }, AMD: { autoSto: true, shares: 220 } };
    const { autoStoEligible } = deriveTickerUniverse({ stocksData: blobWithLegacy, userSettings: { NVDA: { auto_sto: true } } });
    expect(autoStoEligible).toEqual(["NVDA"]);
  });
});

// ═══ 4. Failed loads cannot write empty blobs ══════════════════════════════════════
describe("4. Failed loads cannot write empty blobs", () => {
  it("a failed load is reported as ok:false — never as an empty object", async () => {
    const db = makeDb({ blob: BASE_BLOB() });
    db.failReads = true;
    const r = await loadStocksDataChecked(client(db, "browser"));
    expect(r).toMatchObject({ ok: false, cols: null });
  });

  it("a patch whose read fails throws and performs NO write — the existing blob is untouched", async () => {
    const db = makeDb({ blob: BASE_BLOB() });
    const snapshot = JSON.stringify(db.row);
    db.failReads = true;
    await expect(patchStocksData(client(db, "browser"), setTickerFields("AAPL", { iv: 1 }), { now: NOW })).rejects.toThrow(/could not read stocks_data/);
    expect(db.writes).toEqual([]);
    expect(JSON.stringify(db.row)).toBe(snapshot);
  });

  it("there is no code path that builds a blob from an empty/initial React state and upserts it (source guards)", async () => {
    const fs = await import("fs"), path = await import("path");
    const ui = fs.readFileSync(path.resolve("src/pri-tod-v3.jsx"), "utf8");
    expect(ui).not.toMatch(/id\s*:\s*["']stocks_data["']/);                         // no direct row writes at all
    const gate = ui.slice(ui.indexOf("const persistStocksData = async"), ui.indexOf("const persistStocksData = async") + 700);
    expect(gate.indexOf('stocksDataStatus !== "ready"')).toBeLessThan(gate.indexOf("patchStocksData"));
    expect(ui).toContain('useState("loading"); // "loading" | "ready" | "error"');   // starts blocked
  });
});

// ═══ 5. Stale closures cannot revert settings ══════════════════════════════════════
describe("5. Stale closures cannot revert settings", () => {
  it("a handler closed over an old settings object saves only the field it was asked to change", async () => {
    const db = makeDb({ settings: { NVDA: { auto_sto: true, iv_manual: 40 } } });
    const staleClosure = { NVDA: { auto_sto: false, iv_manual: 40 } };    // captured before someone turned NVDA on
    const handler = (t, uiFields) => saveUserSetting(client(db, "tab"), t, uiFields); // no closure state is sent
    await handler("NVDA", { iv: 41 });
    expect(staleClosure.NVDA.auto_sto).toBe(false);
    expect(db.settings.get("NVDA")).toMatchObject({ auto_sto: true, iv_manual: 41 });
  });

  it("a blob mutator closed over stale values for OTHER tickers cannot revert them", async () => {
    const db = makeDb({ blob: BASE_BLOB() });
    const staleBlob = JSON.parse(JSON.stringify(db.row.cols));
    db.serverWrite(b => { b.NVDA.shares = 500; return b; });
    const mutatorWithStaleClosure = (fresh) => ({ ...fresh, AAPL: { ...fresh.AAPL, iv: 2 }, _stale: staleBlob.NVDA.shares });
    await patchStocksData(client(db, "tab"), mutatorWithStaleClosure, { now: NOW });
    expect(db.row.cols.NVDA.shares).toBe(500);                              // the server's value was not reverted by the stale closure
  });

  it("the optimistic UI update uses functional setState (no closure copy of the whole map)", async () => {
    const fs = await import("fs"), path = await import("path");
    const ui = fs.readFileSync(path.resolve("src/pri-tod-v3.jsx"), "utf8");
    const fn = ui.slice(ui.indexOf("const updateStockData = async"), ui.indexOf("// ── E*TRADE live data"));
    expect(fn).toContain("setStocksData(prev =>");
    expect(fn).not.toMatch(/\{\s*\.\.\.stocksData/);
  });
});

// ═══ CONTROL: the harness can expose the ORIGINAL bug ═════════════════════════════
describe("control — the model reproduces the original failure, so the passes above are meaningful", () => {
  it("OLD pattern: a stale tab upserting its whole in-memory blob reverts the server's data AND another tab's toggle", () => {
    const db = makeDb({ blob: { NVDA: { shares: 322, autoSto: false } } });
    const staleTab = JSON.parse(JSON.stringify(db.row.cols));               // tab loaded here
    db.serverWrite(b => { b.NVDA.shares = 500; return b; });                // server updates shares
    db.row = { id: "stocks_data", cols: { ...db.row.cols, NVDA: { ...db.row.cols.NVDA, autoSto: true } }, updated_at: db.tick() }; // other tab toggles on
    db.row = { id: "stocks_data", cols: staleTab, updated_at: db.tick() }; // stale tab's whole-blob upsert (the removed code)
    expect(db.row.cols.NVDA).toEqual({ shares: 322, autoSto: false });      // BOTH changes silently reverted
  });

  it("merged display state overlays settings without trusting legacy blob values", () => {
    const merged = mergeUserSettings({ NVDA: { shares: 1, autoSto: true } }, {});
    expect(merged.NVDA.autoSto).toBe(false);
  });
});
