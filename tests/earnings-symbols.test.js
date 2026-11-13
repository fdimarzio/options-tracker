// tests/earnings-symbols.test.js
// Fix 1: the earnings-refresh universe. The earnings guard trusts earnings_dates to be current, but the
// nightly job only refreshed tickers with an OPEN CONTRACT or on the WATCHLIST — so a held, opted-in
// ticker with no contract today (AAPL, CEG, MCD, SPCX on 2026-11-13) went stale and was then blocked
// forever. deriveEarningsSymbols is now a SUPERSET of everything the scanner can trade.
// Run: npx vitest run tests/earnings-symbols.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { deriveEarningsSymbols, EARNINGS_MIN_SHARES } from "../api/_lib/earningsSymbols.js";
import { deriveTickerUniverse, totalShares } from "../api/_lib/tickerUniverse.js";

const optIn = (...t) => Object.fromEntries(t.map(x => [x, { auto_sto: true }]));

describe("deriveEarningsSymbols — each source covers a symbol on its own", () => {
  it("positive — auto-STO opted in, with NO shares, NO contract, NOT on the watchlist", () => {
    const { symbols, sources } = deriveEarningsSymbols({ userSettings: optIn("CEG") });
    expect(symbols).toEqual(["CEG"]);
    expect(sources.CEG).toEqual(["auto_sto"]);
  });

  it("positive — >= 100 shares, with NO contract, NOT opted in, NOT on the watchlist (the AAPL case)", () => {
    const stocksData = { AAPL: { shares: 226, sharesByAcct: { "ETrade 6917": 226 } } };
    const { symbols, sources } = deriveEarningsSymbols({ stocksData });
    expect(symbols).toEqual(["AAPL"]);
    expect(sources.AAPL).toEqual(["shares"]);
  });

  it("positive — an active contract alone (a naked put on a stock we don't hold)", () => {
    expect(deriveEarningsSymbols({ contracts: [{ stock: "XYZ" }] }).symbols).toEqual(["XYZ"]);
  });

  it("positive — the watchlist alone", () => {
    expect(deriveEarningsSymbols({ watchlistTickers: ["TSLA"] }).symbols).toEqual(["TSLA"]);
  });

  it("positive — shares are summed across accounts to clear the 100 bar; flat `shares` is the fallback", () => {
    const stocksData = {
      AMZN: { sharesByAcct: { "Schwab 3866": 60, "ETrade 6917": 40 } },
      WDC:  { shares: 150 },
    };
    expect(deriveEarningsSymbols({ stocksData }).symbols).toEqual(["AMZN", "WDC"]);
  });
});

describe("deriveEarningsSymbols — what is NOT covered", () => {
  it("negative — under 100 shares, not opted in, no contract, not watched: not covered (COST, 9 sh)", () => {
    const stocksData = { COST: { sharesByAcct: { "ETrade 6917": 9 } }, XYZ: { shares: 99.9 } };
    expect(deriveEarningsSymbols({ stocksData }).symbols).toEqual([]);
  });

  it("negative — an explicit auto_sto = false does not add a symbol (but 100+ shares still does)", () => {
    expect(deriveEarningsSymbols({ userSettings: { AMD: { auto_sto: false } } }).symbols).toEqual([]);
    const stocksData = { AMD: { sharesByAcct: { "ETrade 6917": 200, "ETrade 8222": 20 } } };
    expect(deriveEarningsSymbols({ stocksData, userSettings: { AMD: { auto_sto: false } } }).symbols).toEqual(["AMD"]);
  });

  it("strict — truthy look-alikes do not opt a symbol in", () => {
    const userSettings = { A: { auto_sto: "true" }, B: { auto_sto: 1 }, C: { auto_sto: null }, D: {} };
    expect(deriveEarningsSymbols({ userSettings }).symbols).toEqual([]);
  });

  it("negative — the __cash__ pseudo-entry and empty/blank symbols never leak in", () => {
    const stocksData = { __cash__: { shares: 1e6, sharesByAcct: { x: 1e6 } } };
    const { symbols } = deriveEarningsSymbols({ stocksData, contracts: [{ stock: "" }, { stock: null }, {}, null], watchlistTickers: ["", "  ", null] });
    expect(symbols).toEqual([]);
  });

  it("edge — missing / null inputs do not throw", () => {
    expect(deriveEarningsSymbols().symbols).toEqual([]);
    expect(deriveEarningsSymbols({ stocksData: null, userSettings: null, contracts: null, watchlistTickers: null }).symbols).toEqual([]);
  });
});

describe("deriveEarningsSymbols — union, dedupe, normalization", () => {
  it("edge — a symbol in several sources appears once and lists every reason", () => {
    const { symbols, sources } = deriveEarningsSymbols({
      stocksData: { NVDA: { shares: 322 } }, userSettings: optIn("NVDA"),
      contracts: [{ stock: "NVDA" }, { stock: "NVDA" }], watchlistTickers: ["NVDA"],
    });
    expect(symbols).toEqual(["NVDA"]);
    expect(sources.NVDA).toEqual(["auto_sto", "contract", "shares", "watchlist"]);
  });

  it("edge — case/whitespace are normalized to a single upper-case symbol and the result is sorted", () => {
    const { symbols } = deriveEarningsSymbols({ contracts: [{ stock: " nvda " }], watchlistTickers: ["tsla", "AAPL"], stocksData: { nvda: { shares: 200 } } });
    expect(symbols).toEqual(["AAPL", "NVDA", "TSLA"]);
  });

  it("the exact 2026-11-13 production situation: every opted-in ticker is covered even with no contract and no watchlist", () => {
    // opted-in tickers and holdings as of 2026-11-13; contracts only on AMZN/CAT/JPM/TSLA/WDC; watchlist only TSLA
    const stocksData = {
      AAPL: { sharesByAcct: { "ETrade 6917": 226 } }, CEG: { sharesByAcct: { "ETrade 6917": 100 } },
      MCD: { sharesByAcct: { "ETrade 8222": 100 } }, SPCX: { sharesByAcct: { "ETrade 6917": 100 } },
      NVDA: { sharesByAcct: { "ETrade 6917": 322 } }, AMZN: { sharesByAcct: { "Schwab 3866": 700, "ETrade 6917": 300 } },
      JPM: { sharesByAcct: { "Schwab 3866": 217.0498 } }, TSLA: { sharesByAcct: { "Schwab 3866": 100 } },
      CAT: { sharesByAcct: { "Schwab 3866": 101.0406 } }, WDC: { sharesByAcct: { "Schwab 3866": 103.0564 } },
      AMD: { sharesByAcct: { "ETrade 6917": 200, "ETrade 8222": 20 } }, OKLO: { shares: 1 },
    };
    const userSettings = optIn("AAPL", "AMZN", "CAT", "CEG", "JPM", "MCD", "NVDA", "OKLO", "SPCX", "TSLA", "WDC");
    userSettings.AMD = { auto_sto: false };
    const contracts = ["AMZN", "AMZN", "CAT", "JPM", "TSLA", "WDC"].map(stock => ({ stock }));
    const { symbols } = deriveEarningsSymbols({ stocksData, userSettings, contracts, watchlistTickers: ["TSLA"] });
    for (const t of ["AAPL", "CEG", "MCD", "SPCX"]) expect(symbols).toContain(t); // the four that were going stale
    expect(symbols).toContain("OKLO");                                            // opted in, 1 share: still refreshed
    expect(symbols).toContain("AMD");                                             // 220 shares
    // the OLD rule (contracts + watchlist only) would have covered just:
    const oldRule = [...new Set([...contracts.map(c => c.stock), "TSLA"])].sort();
    expect(oldRule).toEqual(["AMZN", "CAT", "JPM", "TSLA", "WDC"]);
    expect(symbols.length).toBeGreaterThan(oldRule.length);
  });
});

describe("invariant — the refresh universe is a SUPERSET of everything the scanner can trade", () => {
  const cases = [
    { name: "opted-in with shares", stocksData: { A: { shares: 150 }, B: { sharesByAcct: { "Schwab 3866": 100 } } }, userSettings: optIn("A", "B") },
    { name: "opted-in, no contract, no watchlist", stocksData: { AAPL: { sharesByAcct: { "ETrade 6917": 226 } } }, userSettings: optIn("AAPL") },
    { name: "mixed opt-in/out", stocksData: { A: { shares: 500 }, B: { shares: 500 }, C: { shares: 50 } }, userSettings: { A: { auto_sto: true }, B: { auto_sto: false }, C: { auto_sto: true } } },
    { name: "nothing eligible", stocksData: { A: { shares: 10 } }, userSettings: {} },
  ];
  for (const c of cases) {
    it(`every deriveTickerUniverse().autoStoEligible symbol has a refreshed earnings row — ${c.name}`, () => {
      const { autoStoEligible } = deriveTickerUniverse({ stocksData: c.stocksData, userSettings: c.userSettings });
      const { symbols } = deriveEarningsSymbols({ stocksData: c.stocksData, userSettings: c.userSettings });
      for (const t of autoStoEligible) expect(symbols).toContain(t);
    });
  }
  it("uses the scanner's own share rule (totalShares from tickerUniverse), not a copy", () => {
    const src = fs.readFileSync(path.resolve("api/_lib/earningsSymbols.js"), "utf8");
    expect(src).toContain('import { totalShares } from "./tickerUniverse.js"');
    expect(EARNINGS_MIN_SHARES).toBe(100);
    expect(totalShares({ sharesByAcct: { a: 60, b: 40 } })).toBe(100);
  });
});

describe("scripts/earnings-refresh.js — wired to the shared rule and fails loudly", () => {
  const src = fs.readFileSync(path.resolve("scripts/earnings-refresh.js"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "");

  it("positive — imports deriveEarningsSymbols and loads all four sources", () => {
    expect(code).toContain('import { deriveEarningsSymbols } from "../api/_lib/earningsSymbols.js"');
    for (const p of ["contracts?select=stock&status=eq.Open", "id=eq.watchlist", "id=eq.stocks_data", "stock_user_settings?select=ticker,auto_sto"]) {
      expect(code).toContain(p);
    }
  });

  it("negative — no longer builds the universe from contracts + watchlist alone", () => {
    expect(code).not.toMatch(/new Set\(\[\s*\.\.\.\(Array\.isArray\(contracts\)/);
  });

  it("positive — a failed source throws (never silently shrinks the universe) and a fatal error is reported to the watchdog", () => {
    expect(code).toContain("load failed: HTTP");
    expect(code).toContain("unexpected response shape");
    expect(code).toMatch(/await heartbeat\("error", `fatal: \$\{e\.message\}`\)/);
  });
});
