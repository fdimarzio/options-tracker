// tests/earnings-refresh-script.test.js
// END-TO-END behavior of the REAL scripts/earnings-refresh.js: it is run as a child process with the
// network replaced by tests/helpers/earnings-fetch-stub.cjs (preloaded via --require). Asserts exactly
// which symbols are asked of Finnhub and written to earnings_dates, and that a failed source aborts the
// run instead of quietly refreshing a smaller universe.
// Run: npx vitest run tests/earnings-refresh-script.test.js

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(".");
const STUB = path.join(ROOT, "tests", "helpers", "earnings-fetch-stub.cjs");
const SCRIPT = path.join(ROOT, "scripts", "earnings-refresh.js");
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const FUTURE = day(80), PAST = day(-10), FUTURE2 = day(150);

let tmp;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "earn-refresh-")); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function run(fixture) {
  const id = Math.random().toString(36).slice(2);
  const fxPath = path.join(tmp, `${id}.json`), logPath = path.join(tmp, `${id}.log`);
  fs.writeFileSync(fxPath, JSON.stringify(fixture));
  fs.writeFileSync(logPath, "");
  const r = spawnSync(process.execPath, ["--require", STUB, SCRIPT], {
    cwd: ROOT, encoding: "utf8", timeout: 30000,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      SUPABASE_URL: "https://stub.supabase.local", SUPABASE_SERVICE_KEY: "svc", FINNHUB_API_KEY: "k",
      PUSHOVER_API_TOKEN: "", PUSHOVER_USER_KEY: "",
      EARN_STUB_FIXTURE: fxPath, EARN_STUB_LOG: logPath,
    },
  });
  const reqs = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  const finnhubSymbols = reqs.filter(q => q.url.includes("finnhub.io")).map(q => new URL(q.url).searchParams.get("symbol")).sort();
  const upserts = reqs.filter(q => q.method === "POST" && q.url.includes("/earnings_dates")).map(q => q.body);
  const heartbeats = reqs.filter(q => q.method === "POST" && q.url.includes("ecosystem_heartbeat")).map(q => q.body);
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, reqs, finnhubSymbols, upserts, heartbeats };
}

// The 2026-11-13 production shape: AAPL/CEG/MCD/SPCX are opted in / held but have NO open contract and
// are NOT on the watchlist — exactly the tickers that went stale.
const BASE = () => ({
  contracts: [{ stock: "NVDA" }, { stock: "TSLA" }],
  watchlist: ["TSLA"],
  stocks_data: {
    AAPL: { shares: 226, sharesByAcct: { "ETrade 6917": 226 } },
    MCD:  { shares: 100, sharesByAcct: { "ETrade 8222": 100 } },
    CEG:  { shares: 0,   sharesByAcct: {} },
    COST: { shares: 9,   sharesByAcct: { "ETrade 6917": 9 } },
    NVDA: { shares: 322, sharesByAcct: { "ETrade 6917": 322 } },
    __cash__: { etrade: 5 },
  },
  settings: [{ ticker: "CEG", auto_sto: true }, { ticker: "AMD", auto_sto: false }],
  finnhub: { AAPL: [PAST, FUTURE], MCD: [FUTURE], CEG: [FUTURE], NVDA: [FUTURE], TSLA: [FUTURE2] },
});

describe("earnings-refresh.js (real script, stubbed network) — expanded coverage", () => {
  it("positive — refreshes every source: shares>=100 (AAPL, MCD), opted-in with 0 shares (CEG), contract (NVDA, TSLA), watchlist (TSLA)", () => {
    const r = run(BASE());
    expect(r.code, r.stderr).toBe(0);
    expect(r.finnhubSymbols).toEqual(["AAPL", "CEG", "MCD", "NVDA", "TSLA"]);
    expect(r.upserts.map(u => u.symbol).sort()).toEqual(["AAPL", "CEG", "MCD", "NVDA", "TSLA"]);
  });

  it("positive — the regression case: AAPL (held, no contract, not watched) is refreshed and its date moves FORWARD, not left stale", () => {
    const r = run(BASE());
    const aapl = r.upserts.find(u => u.symbol === "AAPL");
    expect(aapl).toBeTruthy();
    expect(aapl.next_earnings).toBe(FUTURE);      // the upcoming date
    expect(aapl.prev_earnings).toBe(PAST);        // the one that just passed is recorded as previous
  });

  it("negative — a sub-100-share, not-opted-in, no-contract, unwatched ticker (COST) is NOT queried or written", () => {
    const r = run(BASE());
    expect(r.finnhubSymbols).not.toContain("COST");
    expect(r.upserts.find(u => u.symbol === "COST")).toBeUndefined();
  });

  it("negative — __cash__ is never treated as a symbol", () => {
    const r = run(BASE());
    expect(r.finnhubSymbols.join(",")).not.toMatch(/cash/i);
  });

  it("positive — reports a healthy heartbeat for the full universe and logs coverage by source", () => {
    const r = run(BASE());
    const hb = r.heartbeats.at(-1);
    expect(hb).toMatchObject({ agent_name: "earnings-refresh", status: "ok" });
    expect(hb.notes).toContain("5 updated");
    expect(r.stdout).toContain('coverage by source: {"auto_sto":1,"shares":3,"contract":2,"watchlist":1}');
  });

  it("edge — still works with the old inputs only (contracts + watchlist), i.e. nothing regressed for the previous universe", () => {
    const fx = { contracts: [{ stock: "NVDA" }], watchlist: ["TSLA"], stocks_data: null, settings: [], finnhub: { NVDA: [FUTURE], TSLA: [FUTURE] } };
    const r = run(fx);
    expect(r.code, r.stderr).toBe(0);
    expect(r.finnhubSymbols).toEqual(["NVDA", "TSLA"]);
  });

  it("edge — an opted-in ticker is queried even when stocks_data has no entry for it at all", () => {
    const r = run({ ...BASE(), stocks_data: {}, settings: [{ ticker: "SPCX", auto_sto: true }], finnhub: { SPCX: [FUTURE], NVDA: [FUTURE], TSLA: [FUTURE] } });
    expect(r.code, r.stderr).toBe(0);
    expect(r.finnhubSymbols).toEqual(["NVDA", "SPCX", "TSLA"]);
  });
});

describe("earnings-refresh.js (real script, stubbed network) — fails loudly, never silently shrinks", () => {
  for (const [name, patch, expected] of [
    ["stock_user_settings unreadable (e.g. table missing)", { settingsStatus: 404 }, "stock_user_settings load failed: HTTP 404"],
    ["stocks_data unreadable", { stocksDataStatus: 500 }, "stocks_data holdings load failed: HTTP 500"],
    ["open contracts unreadable", { contractsStatus: 503 }, "open contracts load failed: HTTP 503"],
  ]) {
    it(`negative — ${name}: exits non-zero, queries NO symbols, writes NO earnings rows, and flags the watchdog`, () => {
      const r = run({ ...BASE(), ...patch });
      expect(r.code).toBe(1);
      expect(r.finnhubSymbols).toEqual([]);
      expect(r.upserts).toEqual([]);
      expect(r.stderr).toContain(expected);
      expect(r.heartbeats.at(-1)).toMatchObject({ agent_name: "earnings-refresh", status: "error" });
      expect(r.heartbeats.at(-1).notes).toContain(expected);
    });
  }
});
