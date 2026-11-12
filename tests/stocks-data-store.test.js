// tests/stocks-data-store.test.js
// P2 of the stocks_data integrity work: the only way browser code may persist to
// col_prefs 'stocks_data' is patchStocksData — re-read the freshest row, apply a
// small mutator to THAT, write with compare-and-swap, and THROW on any failure.
// Uses a fake supabase client that records every call; nothing touches a network.
// Run: npx vitest run tests/stocks-data-store.test.js

import { describe, it, expect } from "vitest";
import {
  patchStocksData, loadStocksDataChecked, describeSupabaseError,
  setTickerFields, setCashField, StocksDataError,
} from "../src/lib/stocksDataStore.js";

// Minimal PostgREST-shaped fake. `script` controls what each operation returns.
function makeFakeSupabase(script) {
  const calls = [];
  const state = { reads: 0, updates: 0, inserts: 0 };
  const client = {
    calls, state,
    from(table) {
      const ctx = { table, op: null, filters: [], payload: null };
      const b = {
        select(cols) { if (!ctx.op) ctx.op = "select"; ctx.cols = cols; return b; },
        eq(col, val) { ctx.filters.push([col, val]); return b; },
        update(payload) { ctx.op = "update"; ctx.payload = payload; return b; },
        insert(payload) { ctx.op = "insert"; ctx.payload = payload; return b; },
        maybeSingle() { return run(); },
        then(res, rej) { return run().then(res, rej); },
      };
      async function run() {
        calls.push({ table, op: ctx.op, filters: ctx.filters.slice(), payload: ctx.payload });
        if (ctx.op === "select") return script.read(state.reads++);
        if (ctx.op === "update") return script.update(state.updates++, ctx);
        if (ctx.op === "insert") return script.insert(state.inserts++, ctx);
        throw new Error("unexpected op " + ctx.op);
      }
      return b;
    },
  };
  return client;
}

const ROW = (cols, updated_at = "2026-11-11T21:00:00.000+00:00") => ({ data: { cols, updated_at }, error: null });
const WON = { data: [{ id: "stocks_data" }], error: null };
const LOST = { data: [], error: null };
const fixedNow = () => "2026-11-11T22:00:00.000Z";

describe("patchStocksData — writes the freshest DB copy, never an in-memory one", () => {
  it("positive — applies the mutator to the DB's current blob and preserves fields this caller never saw", async () => {
    const sb = makeFakeSupabase({
      read: () => ROW({ AAPL: { shares: 226 }, AMD: { autoSto: false, shares: 220 }, __cash__: { etrade: 5 } }),
      update: () => WON,
    });
    const written = await patchStocksData(sb, setTickerFields("AAPL", { iv: 31 }), { now: fixedNow });
    const upd = sb.calls.find(c => c.op === "update");
    expect(upd.payload.cols.AAPL).toEqual({ shares: 226, iv: 31 });
    // fields written by someone else are untouched by our patch
    expect(upd.payload.cols.AMD).toEqual({ autoSto: false, shares: 220 });
    expect(upd.payload.cols.__cash__).toEqual({ etrade: 5 });
    expect(written).toEqual(upd.payload.cols);
  });

  it("positive — the write is compare-and-swap on the updated_at it read", async () => {
    const sb = makeFakeSupabase({ read: () => ROW({ X: {} }, "2026-11-11T20:59:59.123+00:00"), update: () => WON });
    await patchStocksData(sb, b => b, { now: fixedNow });
    const upd = sb.calls.find(c => c.op === "update");
    expect(upd.filters).toContainEqual(["id", "stocks_data"]);
    expect(upd.filters).toContainEqual(["updated_at", "2026-11-11T20:59:59.123+00:00"]);
  });

  it("edge — a concurrent writer wins the race: re-reads, re-applies on THEIR data, keeps both changes", async () => {
    const sb = makeFakeSupabase({
      read: (n) => n === 0
        ? ROW({ NVDA: { shares: 322 } }, "T0")
        : ROW({ NVDA: { shares: 322 }, AMD: { shares: 999 } }, "T1"), // another writer added AMD
      update: (n) => (n === 0 ? LOST : WON),
    });
    const written = await patchStocksData(sb, setTickerFields("NVDA", { iv: 40 }), { now: fixedNow });
    expect(sb.state.reads).toBe(2);
    expect(sb.state.updates).toBe(2);
    expect(written.NVDA).toEqual({ shares: 322, iv: 40 });
    expect(written.AMD).toEqual({ shares: 999 });          // the other writer's change survived
    const second = sb.calls.filter(c => c.op === "update")[1];
    expect(second.filters).toContainEqual(["updated_at", "T1"]);
  });

  it("negative — keeps losing the race: throws CAS_EXHAUSTED after retries+1 attempts and says it was NOT saved", async () => {
    const sb = makeFakeSupabase({ read: () => ROW({ A: {} }), update: () => LOST });
    await expect(patchStocksData(sb, b => b, { retries: 2, now: fixedNow })).rejects.toMatchObject({
      name: "StocksDataError", code: "CAS_EXHAUSTED",
      message: expect.stringContaining("NOT saved"),
    });
    expect(sb.state.updates).toBe(3);
  });

  it("negative — the mutator sees a clone: mutating it in place cannot corrupt a retry", async () => {
    const sb = makeFakeSupabase({
      read: () => ROW({ A: { n: 1 } }),
      update: (n) => (n === 0 ? LOST : WON),
    });
    const seen = [];
    await patchStocksData(sb, blob => { seen.push(JSON.parse(JSON.stringify(blob))); blob.A.n += 1; return blob; }, { now: fixedNow });
    expect(seen[0]).toEqual({ A: { n: 1 } });
    expect(seen[1]).toEqual({ A: { n: 1 } }); // second attempt starts from a fresh read, not the mutated first copy
  });
});

describe("patchStocksData — no silent failures", () => {
  it("negative — a read error throws (supabase-js returns errors, it does not throw them)", async () => {
    const sb = makeFakeSupabase({ read: () => ({ data: null, error: { message: "permission denied for table col_prefs", code: "42501" } }), update: () => WON });
    await expect(patchStocksData(sb, b => b)).rejects.toMatchObject({
      name: "StocksDataError", code: "42501",
      message: expect.stringContaining("could not read stocks_data: permission denied"),
    });
    expect(sb.state.updates).toBe(0); // never attempted a write after a failed read
  });

  it("negative — an update error throws with the database's message", async () => {
    const sb = makeFakeSupabase({ read: () => ROW({ A: {} }), update: () => ({ data: null, error: { message: "JWT expired", code: "PGRST301" } }) });
    await expect(patchStocksData(sb, b => b)).rejects.toThrow(/could not save stocks_data: JWT expired \(PGRST301\)/);
  });

  it("negative — an invalid mutator or mutator result throws instead of writing garbage", async () => {
    const sb = makeFakeSupabase({ read: () => ROW({ A: {} }), update: () => WON });
    await expect(patchStocksData(sb, null)).rejects.toThrow(/requires a mutator/);
    await expect(patchStocksData(sb, () => null)).rejects.toThrow(/must return/);
    expect(sb.state.updates).toBe(0);
  });
});

describe("patchStocksData — no existing row", () => {
  it("edge — inserts when the row does not exist yet", async () => {
    const sb = makeFakeSupabase({ read: () => ({ data: null, error: null }), insert: () => ({ error: null }), update: () => WON });
    const written = await patchStocksData(sb, setTickerFields("NEW", { iv: 1 }), { now: fixedNow });
    expect(written).toEqual({ NEW: { iv: 1 } });
    expect(sb.state.inserts).toBe(1);
  });

  it("edge — row appears between read and insert (23505): retries as a CAS update instead of failing or clobbering", async () => {
    const sb = makeFakeSupabase({
      read: (n) => (n === 0 ? { data: null, error: null } : ROW({ OTHER: { shares: 5 } }, "T1")),
      insert: () => ({ error: { code: "23505", message: "duplicate key" } }),
      update: () => WON,
    });
    const written = await patchStocksData(sb, setTickerFields("NEW", { iv: 1 }), { now: fixedNow });
    expect(written).toEqual({ OTHER: { shares: 5 }, NEW: { iv: 1 } });
  });

  it("negative — any other insert error throws", async () => {
    const sb = makeFakeSupabase({ read: () => ({ data: null, error: null }), insert: () => ({ error: { code: "42501", message: "rls" } }), update: () => WON });
    await expect(patchStocksData(sb, b => b)).rejects.toThrow(/could not create stocks_data: rls/);
  });
});

describe("loadStocksDataChecked — a failed load must not look like an empty database", () => {
  it("positive — returns the blob and updated_at on success", async () => {
    const sb = makeFakeSupabase({ read: () => ROW({ A: { shares: 1 } }, "T") });
    expect(await loadStocksDataChecked(sb)).toEqual({ ok: true, cols: { A: { shares: 1 } }, updatedAt: "T", error: null });
  });

  it("negative — a query error is ok:false with a message (NOT cols:{} / not an empty DB)", async () => {
    const sb = makeFakeSupabase({ read: () => ({ data: null, error: { message: "network down", code: "" } }) });
    const r = await loadStocksDataChecked(sb);
    expect(r.ok).toBe(false);
    expect(r.cols).toBeNull();
    expect(r.error).toContain("network down");
  });

  it("negative — a thrown exception is ok:false too", async () => {
    const sb = { from() { throw new Error("boom"); } };
    expect((await loadStocksDataChecked(sb))).toMatchObject({ ok: false, error: expect.stringContaining("boom") });
  });

  it("edge — a legitimately missing row is ok:true with cols:null (fresh project), distinguishable from a failure", async () => {
    const sb = makeFakeSupabase({ read: () => ({ data: null, error: null }) });
    expect(await loadStocksDataChecked(sb)).toMatchObject({ ok: true, cols: null });
  });
});

describe("helpers", () => {
  it("describeSupabaseError joins message/details/hint and appends the code", () => {
    expect(describeSupabaseError({ message: "m", details: "d", hint: "h", code: "42" })).toBe("m — d — h (42)");
    expect(describeSupabaseError({ message: "only" })).toBe("only");
    expect(describeSupabaseError(null)).toBe("unknown error");
    expect(describeSupabaseError(new Error("x"))).toBe("x");
  });

  it("setTickerFields / setCashField touch only what they name", () => {
    const blob = { A: { shares: 1, autoSto: true }, __cash__: { schwab: 9 } };
    expect(setTickerFields("A", { iv: 2 })(blob)).toEqual({ A: { shares: 1, autoSto: true, iv: 2 }, __cash__: { schwab: 9 } });
    expect(setTickerFields("B", { iv: 3 })(blob).B).toEqual({ iv: 3 });
    expect(setCashField("etrade", 7)(blob).__cash__).toEqual({ schwab: 9, etrade: 7 });
    expect(blob.A).toEqual({ shares: 1, autoSto: true }); // inputs not mutated
  });

  it("StocksDataError carries name and code", () => {
    const e = new StocksDataError("m", { code: "X" });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("StocksDataError");
    expect(e.code).toBe("X");
  });
});
