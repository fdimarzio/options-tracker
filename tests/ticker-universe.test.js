// tests/ticker-universe.test.js
// Chain coverage is driven by actual holdings + open positions + the watchlist.
// Auto-STO EXECUTION eligibility is now EXPLICIT OPT-IN (stocks_data integrity work):
// a ticker is eligible only with >=100 shares AND a stock_user_settings row whose
// auto_sto is exactly true. Previously "never set" meant eligible and only an explicit
// false opted a ticker out, with the flag stored in the stocks_data blob where stale
// writers kept reverting it. Run: npx vitest run tests/ticker-universe.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { deriveTickerUniverse } from "../api/_lib/tickerUniverse.js";

const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

const optIn = (...tickers) => Object.fromEntries(tickers.map(t => [t, { auto_sto: true }]));

describe("deriveTickerUniverse — chain coverage (unchanged)", () => {
  it("a 200sh holding with no open contract is in the chain universe and covered-call eligible (the INTC case)", () => {
    const stocksData = { INTC: { sharesByAcct: { "Schwab 3866": 200 } } };
    const { chainUniverse, coveredCallEligible } = deriveTickerUniverse({ stocksData });
    expect(chainUniverse).toContain("INTC");
    expect(coveredCallEligible).toContain("INTC");
  });

  it("negative — a <100sh holding (COST, 9sh) is NOT in the chain universe and NOT auto-STO eligible, even if opted in", () => {
    const stocksData = { COST: { sharesByAcct: { "ETrade 6917": 9 } } };
    const { chainUniverse, autoStoEligible } = deriveTickerUniverse({ stocksData, userSettings: optIn("COST") });
    expect(chainUniverse).not.toContain("COST");
    expect(autoStoEligible).not.toContain("COST");
  });

  it("sums shares across accounts to clear the 100sh bar", () => {
    const stocksData = { AMZN: { sharesByAcct: { "Schwab 3866": 60, "ETrade 6917": 40 } } };
    const { coveredCallEligible, autoStoEligible } = deriveTickerUniverse({ stocksData, userSettings: optIn("AMZN") });
    expect(coveredCallEligible).toContain("AMZN");
    expect(autoStoEligible).toContain("AMZN");
  });

  it("falls back to a flat `shares` field when sharesByAcct is absent", () => {
    const stocksData = { WDC: { shares: 150 } };
    const { coveredCallEligible, autoStoEligible } = deriveTickerUniverse({ stocksData, userSettings: optIn("WDC") });
    expect(coveredCallEligible).toContain("WDC");
    expect(autoStoEligible).toContain("WDC");
  });

  it("excludes the __cash__ pseudo-entry", () => {
    const stocksData = { __cash__: { shares: 100000 } };
    const { chainUniverse, coveredCallEligible } = deriveTickerUniverse({ stocksData });
    expect(chainUniverse).not.toContain("__CASH__");
    expect(coveredCallEligible).not.toContain("__CASH__");
  });

  it("watchlist-only name (0 shares) gets chain coverage for suggestions but is never auto-STO eligible", () => {
    const { chainUniverse, autoStoEligible } = deriveTickerUniverse({ stocksData: {}, watchlistTickers: ["TSLA"], userSettings: optIn("TSLA") });
    expect(chainUniverse).toContain("TSLA");
    expect(autoStoEligible).not.toContain("TSLA");
  });

  it("includes tickers with an open, non-expired contract even at 0 shares (e.g. a naked put)", () => {
    const contracts = [{ stock: "CEG", expires: tomorrow }];
    const { chainUniverse, openPositionTickers, autoStoEligible } = deriveTickerUniverse({ stocksData: {}, contracts, userSettings: optIn("CEG") });
    expect(chainUniverse).toContain("CEG");
    expect(openPositionTickers).toContain("CEG");
    expect(autoStoEligible).not.toContain("CEG"); // 0 shares — not covered-call eligible
  });

  it("excludes a contract whose expiry has already passed (non-expired only)", () => {
    const { chainUniverse, openPositionTickers } = deriveTickerUniverse({ stocksData: {}, contracts: [{ stock: "XYZ", expires: yesterday }] });
    expect(chainUniverse).not.toContain("XYZ");
    expect(openPositionTickers).not.toContain("XYZ");
  });

  it("treats an expiry of exactly today as non-expired (inclusive)", () => {
    const { openPositionTickers } = deriveTickerUniverse({ stocksData: {}, contracts: [{ stock: "XYZ", expires: today }] });
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
    const { chainUniverse, autoStoEligible } = deriveTickerUniverse({ stocksData, watchlistTickers: ["tsla"], userSettings: optIn("INTC") });
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

describe("deriveTickerUniverse — auto-STO is explicit opt-in", () => {
  const holdings = {
    NVDA: { sharesByAcct: { "ETrade 6917": 322 } },
    AMD:  { sharesByAcct: { "ETrade 6917": 220 } },
    MCD:  { sharesByAcct: { "ETrade 8222": 100 } },
    TSLA: { sharesByAcct: { "Schwab 3866": 100 } },
  };

  it("positive — auto_sto = true with >=100 shares is eligible", () => {
    const { autoStoEligible } = deriveTickerUniverse({ stocksData: holdings, userSettings: { NVDA: { auto_sto: true } } });
    expect(autoStoEligible).toEqual(["NVDA"]);
  });

  it("negative — auto_sto = false is not eligible (explicit opt-out), yet the ticker keeps chain coverage", () => {
    const { autoStoEligible, chainUniverse } = deriveTickerUniverse({ stocksData: holdings, userSettings: { AMD: { auto_sto: false }, NVDA: { auto_sto: true } } });
    expect(autoStoEligible).toEqual(["NVDA"]);
    expect(chainUniverse).toContain("AMD");
  });

  it("negative — NO settings row is not eligible (this was eligible under the old opt-out rule)", () => {
    const { autoStoEligible } = deriveTickerUniverse({ stocksData: holdings, userSettings: { NVDA: { auto_sto: true } } });
    for (const t of ["AMD", "MCD", "TSLA"]) expect(autoStoEligible).not.toContain(t);
  });

  it("negative — no settings supplied at all (e.g. the table could not be read) => nothing is eligible: fail closed", () => {
    expect(deriveTickerUniverse({ stocksData: holdings }).autoStoEligible).toEqual([]);
    expect(deriveTickerUniverse({ stocksData: holdings, userSettings: {} }).autoStoEligible).toEqual([]);
    expect(deriveTickerUniverse({ stocksData: holdings, userSettings: null }).autoStoEligible).toEqual([]);
  });

  it("strict — only a literal true counts; truthy look-alikes do not opt in", () => {
    const userSettings = { NVDA: { auto_sto: "true" }, AMD: { auto_sto: 1 }, MCD: { auto_sto: "yes" }, TSLA: {} };
    expect(deriveTickerUniverse({ stocksData: holdings, userSettings }).autoStoEligible).toEqual([]);
  });

  it("the legacy autoSto field left in the stocks_data blob is IGNORED in both directions", () => {
    const legacy = {
      NVDA: { autoSto: true,  sharesByAcct: { "ETrade 6917": 322 } },   // legacy true, no settings row -> not eligible
      AMD:  { autoSto: false, sharesByAcct: { "ETrade 6917": 220 } },   // legacy false, settings true  -> eligible
    };
    const { autoStoEligible } = deriveTickerUniverse({ stocksData: legacy, userSettings: { AMD: { auto_sto: true } } });
    expect(autoStoEligible).toEqual(["AMD"]);
  });

  it("settings keys are matched case-insensitively against the blob's tickers via upper-casing", () => {
    const { autoStoEligible } = deriveTickerUniverse({ stocksData: { nvda: { shares: 200 } }, userSettings: { NVDA: { auto_sto: true } } });
    expect(autoStoEligible).toEqual(["NVDA"]);
  });
});

describe("api/chain-refresh.js — wired to the derived universe", () => {
  const src = fs.readFileSync(path.resolve("api/chain-refresh.js"), "utf8");

  it("imports and calls deriveTickerUniverse instead of a manual autoSto filter", () => {
    expect(src).toContain('import { deriveTickerUniverse } from "./_lib/tickerUniverse.js"');
    expect(src).toContain("deriveTickerUniverse({ stocksData: sdBlob, contracts, watchlistTickers })");
    expect(src).not.toContain('v?.autoSto === true');
  });

  it("does not depend on the auto-STO opt-in at all (chain coverage is holdings/positions/watchlist only)", () => {
    const code = src.replace(/\/\/[^\n]*/g, ""); // comments may explain this; code must not read it
    expect(code).not.toContain("autoStoEligible");
    expect(code).not.toContain("stock_user_settings");
  });

  it("logs the resolved universe each run for debugging", () => {
    expect(src).toContain("[chain-refresh] resolved chain universe");
  });

  it("fetches the MWF expiry ladder for the full chainUniverse, not just autoSto tickers", () => {
    expect(src).toMatch(/for \(const ticker of chainUniverse\)/);
  });
});

describe("api/market-refresh.js — auto-STO scanner reads the derived universe + the user opt-in table", () => {
  const src = fs.readFileSync(path.resolve("api/market-refresh.js"), "utf8");

  it("imports deriveTickerUniverse and builds the whitelist from autoStoEligible, passing userSettings", () => {
    expect(src).toContain('import { deriveTickerUniverse } from "./_lib/tickerUniverse.js"');
    expect(src).toContain("deriveTickerUniverse({ stocksData: updatedSD, contracts, watchlistTickers, userSettings })");
    expect(src).toContain("const autoStoWhitelist = autoStoEligible;");
  });

  it("no longer gates the whitelist on the blob's autoSto flag", () => {
    expect(src).not.toContain("sd?.autoSto === true)\n          .map(([sym]) => sym.toUpperCase());");
    expect(src).not.toMatch(/stocksData\[sym\]\?\.autoSto|updatedSD\[[^\]]*\]\?\.autoSto/);
  });
});
