// tests/ticker-universe.test.js
// Chain coverage used to be driven by open contracts + a manual per-ticker
// "autoSto" flag, so a stock bought for covered calls (e.g. INTC, 200 sh) had
// no chain loaded — and auto-STO could only suggest, never execute — until
// someone remembered to flip the flag in the Stocks tab. deriveTickerUniverse
// ties chain coverage and auto-STO eligibility to actual holdings instead.
// Run: npx vitest run tests/ticker-universe.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { deriveTickerUniverse } from "../api/_lib/tickerUniverse.js";

const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

describe("deriveTickerUniverse", () => {
  it("positive — a 200sh holding with no open contract and no autoSto flag is in the chain universe and auto-STO eligible (the INTC case)", () => {
    const stocksData = { INTC: { sharesByAcct: { "Schwab 3866": 200 } } };
    const { chainUniverse, coveredCallEligible, autoStoEligible } = deriveTickerUniverse({ stocksData });
    expect(chainUniverse).toContain("INTC");
    expect(coveredCallEligible).toContain("INTC");
    expect(autoStoEligible).toContain("INTC");
  });

  it("negative — a <100sh holding (COST, 9sh) is in the chain universe (so its price/suggestions still work) but NOT auto-STO eligible", () => {
    const stocksData = { COST: { sharesByAcct: { "ETrade 6917": 9 } } };
    const { chainUniverse, autoStoEligible } = deriveTickerUniverse({ stocksData });
    expect(chainUniverse).not.toContain("COST");
    expect(autoStoEligible).not.toContain("COST");
  });

  it("sums shares across accounts to clear the 100sh bar", () => {
    const stocksData = { AMZN: { sharesByAcct: { "Schwab 3866": 60, "ETrade 6917": 40 } } };
    const { autoStoEligible } = deriveTickerUniverse({ stocksData });
    expect(autoStoEligible).toContain("AMZN");
  });

  it("falls back to a flat `shares` field when sharesByAcct is absent", () => {
    const stocksData = { WDC: { shares: 150 } };
    const { autoStoEligible } = deriveTickerUniverse({ stocksData });
    expect(autoStoEligible).toContain("WDC");
  });

  it("excludes the __cash__ pseudo-entry", () => {
    const stocksData = { __cash__: { shares: 100000 } };
    const { chainUniverse, coveredCallEligible } = deriveTickerUniverse({ stocksData });
    expect(chainUniverse).not.toContain("__CASH__");
    expect(coveredCallEligible).not.toContain("__CASH__");
  });

  it("honors an explicit autoSto=false opt-out even with >=100 shares (e.g. AMD)", () => {
    const stocksData = { AMD: { autoSto: false, sharesByAcct: { "Schwab 3866": 220 } } };
    const { chainUniverse, coveredCallEligible, autoStoEligible } = deriveTickerUniverse({ stocksData });
    // Still gets chain coverage (it's a real holding) — just not auto-executed.
    expect(chainUniverse).toContain("AMD");
    expect(coveredCallEligible).toContain("AMD");
    expect(autoStoEligible).not.toContain("AMD");
  });

  it("watchlist-only name (0 shares) gets chain coverage for suggestions but is never auto-STO eligible", () => {
    const stocksData = {};
    const { chainUniverse, autoStoEligible } = deriveTickerUniverse({ stocksData, watchlistTickers: ["TSLA"] });
    expect(chainUniverse).toContain("TSLA");
    expect(autoStoEligible).not.toContain("TSLA");
  });

  it("includes tickers with an open, non-expired contract even at 0 shares (e.g. a naked put)", () => {
    const stocksData = {};
    const contracts = [{ stock: "CEG", expires: tomorrow }];
    const { chainUniverse, openPositionTickers, autoStoEligible } = deriveTickerUniverse({ stocksData, contracts });
    expect(chainUniverse).toContain("CEG");
    expect(openPositionTickers).toContain("CEG");
    expect(autoStoEligible).not.toContain("CEG"); // 0 shares — not covered-call eligible
  });

  it("excludes a contract whose expiry has already passed (non-expired only)", () => {
    const stocksData = {};
    const contracts = [{ stock: "XYZ", expires: yesterday }];
    const { chainUniverse, openPositionTickers } = deriveTickerUniverse({ stocksData, contracts });
    expect(chainUniverse).not.toContain("XYZ");
    expect(openPositionTickers).not.toContain("XYZ");
  });

  it("treats an expiry of exactly today as non-expired (inclusive)", () => {
    const stocksData = {};
    const contracts = [{ stock: "XYZ", expires: today }];
    const { openPositionTickers } = deriveTickerUniverse({ stocksData, contracts });
    expect(openPositionTickers).toContain("XYZ");
  });

  it("dedupes a ticker that appears in more than one bucket", () => {
    const stocksData = { NVDA: { sharesByAcct: { "Schwab 3866": 322 } } };
    const contracts = [{ stock: "NVDA", expires: tomorrow }];
    const { chainUniverse } = deriveTickerUniverse({ stocksData, contracts, watchlistTickers: ["NVDA"] });
    expect(chainUniverse.filter(t => t === "NVDA").length).toBe(1);
  });

  it("upper-cases symbols regardless of input casing", () => {
    const stocksData = { intc: { sharesByAcct: { "Schwab 3866": 200 } } };
    const { chainUniverse, autoStoEligible } = deriveTickerUniverse({ stocksData, watchlistTickers: ["tsla"] });
    expect(chainUniverse).toContain("INTC");
    expect(chainUniverse).toContain("TSLA");
    expect(autoStoEligible).toContain("INTC");
  });

  it("defaults to empty inputs without throwing", () => {
    const result = deriveTickerUniverse();
    expect(result.chainUniverse).toEqual([]);
    expect(result.autoStoEligible).toEqual([]);
  });
});

describe("api/chain-refresh.js — wired to the derived universe", () => {
  const src = fs.readFileSync(path.resolve("api/chain-refresh.js"), "utf8");

  it("imports and calls deriveTickerUniverse instead of a manual autoSto filter", () => {
    expect(src).toContain('import { deriveTickerUniverse } from "./_lib/tickerUniverse.js"');
    expect(src).toContain("deriveTickerUniverse({ stocksData: sdBlob, contracts, watchlistTickers })");
    expect(src).not.toContain('v?.autoSto === true');
  });

  it("logs the resolved universe each run for debugging", () => {
    expect(src).toContain("[chain-refresh] resolved chain universe");
  });

  it("fetches the MWF expiry ladder for the full chainUniverse, not just autoSto tickers", () => {
    expect(src).toMatch(/for \(const ticker of chainUniverse\)/);
  });
});

describe("api/market-refresh.js — auto-STO scanner reads the same derived universe", () => {
  const src = fs.readFileSync(path.resolve("api/market-refresh.js"), "utf8");

  it("imports deriveTickerUniverse and builds the whitelist from autoStoEligible", () => {
    expect(src).toContain('import { deriveTickerUniverse } from "./_lib/tickerUniverse.js"');
    expect(src).toContain("deriveTickerUniverse({ stocksData: updatedSD, contracts, watchlistTickers })");
    expect(src).toContain("const autoStoWhitelist = autoStoEligible;");
  });

  it("no longer gates the whitelist on a manual autoSto===true flag", () => {
    expect(src).not.toContain("sd?.autoSto === true)\n          .map(([sym]) => sym.toUpperCase());");
  });
});
