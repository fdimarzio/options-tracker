// tests/ownership.test.js
// Fix 4: the Stocks tab's notion of "owned" now comes from the SAME source of truth as the auto-STO
// scanner — the server-authoritative `shares` / `sharesByAcct` — instead of the legacy browser-owned
// `sharesSchwab` / `sharesEtrade` (stale and wrong for most tickers; AAPL showed 100.09 Schwab + 26 ETrade
// while the real holding is 226 shares in ETrade 6917, so a held, opted-in ticker could be missing).
// Run: npx vitest run tests/ownership.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { totalOwnedShares, isOwned, sharesByBroker, mergeServerHoldings } from "../src/lib/ownership.js";
import { totalShares, deriveTickerUniverse } from "../api/_lib/tickerUniverse.js";

describe("src/lib/ownership.js — totalOwnedShares", () => {
  it("positive — sums sharesByAcct across accounts", () => {
    expect(totalOwnedShares({ sharesByAcct: { "Schwab 3866": 700, "ETrade 6917": 300 } })).toBe(1000);
  });
  it("positive — falls back to the flat server `shares` when sharesByAcct is empty or absent", () => {
    expect(totalOwnedShares({ shares: 150 })).toBe(150);
    expect(totalOwnedShares({ shares: 150, sharesByAcct: {} })).toBe(150);
  });
  it("edge — null / undefined / empty / non-numeric never throw and count as zero", () => {
    for (const v of [null, undefined, {}, { shares: "abc" }, { sharesByAcct: { a: "x" } }]) expect(totalOwnedShares(v)).toBe(0);
  });
  it("edge — fractional shares are preserved (the server holds 101.0406 CAT)", () => {
    expect(totalOwnedShares({ sharesByAcct: { "Schwab 3866": 101.0406 } })).toBeCloseTo(101.0406, 4);
  });
});

describe("src/lib/ownership.js — isOwned uses ONLY the server-authoritative fields", () => {
  it("positive — AAPL as it really is: 226 shares in ETrade 6917 => owned (this is the ticker that was missing)", () => {
    expect(isOwned({ shares: 226, sharesByAcct: { "ETrade 6917": 226 } })).toBe(true);
  });

  it("negative — LEGACY browser fields alone do NOT make a ticker owned", () => {
    expect(isOwned({ sharesSchwab: 100, sharesEtrade: 50 })).toBe(false);
    expect(isOwned({ sharesSchwab: 100.09, sharesEtrade: 26, shares: 0, sharesByAcct: {} })).toBe(false);
  });

  it("negative — stale legacy values cannot contradict the server: the server says sold (0 shares) => not owned", () => {
    expect(isOwned({ shares: 0, sharesByAcct: {}, sharesSchwab: 300, sharesEtrade: 300 })).toBe(false);
  });

  it("positive — the server says held even though the legacy fields say nothing", () => {
    expect(isOwned({ sharesByAcct: { "Schwab 3866": 100 }, sharesSchwab: 0, sharesEtrade: 0 })).toBe(true);
  });
});

describe("src/lib/ownership.js — sharesByBroker", () => {
  it("positive — splits by account-name prefix, summing multiple ETrade accounts", () => {
    expect(sharesByBroker({ sharesByAcct: { "ETrade 6917": 200, "ETrade 8222": 20, "Schwab 3866": 5 } }))
      .toEqual({ schwab: 5, etrade: 220, other: 0 });
  });
  it("edge — case/format variants (Etrade, E-Trade) land in ETrade; unknown brokers land in `other`, never dropped", () => {
    expect(sharesByBroker({ sharesByAcct: { "Etrade 1": 1, "E-Trade 2": 2, "Fidelity 3": 7 } })).toEqual({ schwab: 0, etrade: 3, other: 7 });
  });
  it("edge — only a flat `shares` (broker unknown) is reported as `other`", () => {
    expect(sharesByBroker({ shares: 150 })).toEqual({ schwab: 0, etrade: 0, other: 150 });
  });
  it("edge — null / empty => zeros", () => {
    expect(sharesByBroker(null)).toEqual({ schwab: 0, etrade: 0, other: 0 });
    expect(sharesByBroker({})).toEqual({ schwab: 0, etrade: 0, other: 0 });
  });
  it("the broker split always adds up to the ownership total used by isOwned", () => {
    for (const sd of [{ sharesByAcct: { "Schwab 3866": 700, "ETrade 6917": 300 } }, { shares: 150 }, { sharesByAcct: { "Weird 1": 9 } }]) {
      const b = sharesByBroker(sd);
      expect(b.schwab + b.etrade + b.other).toBeCloseTo(totalOwnedShares(sd), 6);
    }
  });
});

describe("one source of truth — UI ownership agrees with the scanner's", () => {
  const cases = [
    {}, null, { shares: 0 }, { shares: 150 }, { shares: 99.99 }, { shares: 100 },
    { sharesByAcct: {} }, { sharesByAcct: { a: 60, b: 40 } }, { sharesByAcct: { "Schwab 3866": 101.0406 } },
    { shares: 500, sharesByAcct: { a: 1 } },         // sharesByAcct wins over the flat field
    { shares: 500, sharesByAcct: {} },               // empty sharesByAcct falls back to shares
    { shares: "12", sharesByAcct: { a: "3", b: null } },
  ];
  for (const sd of cases) {
    it(`src/lib/ownership.totalOwnedShares === api/_lib/tickerUniverse.totalShares for ${JSON.stringify(sd)}`, () => {
      expect(totalOwnedShares(sd)).toBe(totalShares(sd));
    });
  }

  it("every ticker the scanner can trade is shown as owned in the UI (coveredCallEligible ⊆ owned)", () => {
    const stocksData = {
      AAPL: { sharesByAcct: { "ETrade 6917": 226 } }, MCD: { sharesByAcct: { "ETrade 8222": 100 } },
      AMZN: { sharesByAcct: { "Schwab 3866": 700, "ETrade 6917": 300 } }, COST: { sharesByAcct: { "ETrade 6917": 9 } },
      WDC: { shares: 103.0564 }, GONE: { shares: 0, sharesByAcct: {}, sharesSchwab: 500, sharesEtrade: 500 },
    };
    const { coveredCallEligible } = deriveTickerUniverse({ stocksData });
    for (const t of coveredCallEligible) expect(isOwned(stocksData[t])).toBe(true);
    expect(isOwned(stocksData.COST)).toBe(true);     // owned (9 sh) though not scanner-eligible: "owned" is any shares
    expect(coveredCallEligible).not.toContain("COST");
    expect(isOwned(stocksData.GONE)).toBe(false);    // legacy ghosts no longer appear
  });
});

describe("mergeServerHoldings — read-only refresh of holdings into UI state", () => {
  const prev = {
    NVDA: { shares: 322, sharesByAcct: { "ETrade 6917": 322 }, autoSto: true, earningsDate: "2026-11-17", iv: 44, currentPrice: 174, sharesSchwab: 5 },
    __cash__: { etrade: 5 },
  };

  it("positive — updates only shares / sharesByAcct / sharesUpdatedAt from the server blob", () => {
    const server = { NVDA: { shares: 400, sharesByAcct: { "ETrade 6917": 400 }, sharesUpdatedAt: "T", currentPrice: 999, autoSto: false } };
    const m = mergeServerHoldings(prev, server);
    expect(m.NVDA).toMatchObject({ shares: 400, sharesByAcct: { "ETrade 6917": 400 }, sharesUpdatedAt: "T" });
  });

  it("negative — never touches user-owned settings, quotes, or the legacy manual fields", () => {
    const server = { NVDA: { shares: 400, sharesByAcct: { "ETrade 6917": 400 }, currentPrice: 999, autoSto: false, earningsDate: "1999-01-01", iv: 1, sharesSchwab: 777 } };
    const m = mergeServerHoldings(prev, server);
    expect(m.NVDA.autoSto).toBe(true);
    expect(m.NVDA.earningsDate).toBe("2026-11-17");
    expect(m.NVDA.iv).toBe(44);
    expect(m.NVDA.currentPrice).toBe(174);
    expect(m.NVDA.sharesSchwab).toBe(5);
  });

  it("positive — a newly bought ticker appears (holdings only); __cash__ is preserved and never taken from the server", () => {
    const m = mergeServerHoldings(prev, { NEW: { shares: 100, sharesByAcct: { "Schwab 3866": 100 } }, __cash__: { etrade: 999999 } });
    expect(m.NEW).toEqual({ shares: 100, sharesByAcct: { "Schwab 3866": 100 } });
    expect(m.__cash__).toEqual({ etrade: 5 });
  });

  it("edge — a ticker the server has no holdings fields for is left alone; null/garbage input returns prev unchanged; inputs are not mutated", () => {
    const before = JSON.stringify(prev);
    expect(mergeServerHoldings(prev, { NVDA: { currentPrice: 1 } }).NVDA).toEqual(prev.NVDA);
    expect(mergeServerHoldings(prev, null)).toEqual(prev);
    expect(mergeServerHoldings(null, { A: { shares: 1 } })).toEqual({ A: { shares: 1 } });
    mergeServerHoldings(prev, { NVDA: { shares: 1 } });
    expect(JSON.stringify(prev)).toBe(before);
  });
});

describe("src/pri-tod-v3.jsx — Stocks tab wiring", () => {
  const ui = fs.readFileSync(path.resolve("src/pri-tod-v3.jsx"), "utf8");
  const listView = (() => {
    const s = ui.indexOf("// Stocks list view");
    const e = ui.indexOf("{/* Add Stock form */}", s);
    expect(s).toBeGreaterThan(-1); expect(e).toBeGreaterThan(s);
    return ui.slice(s, e);
  })();
  const code = listView.replace(/\/\/[^\n]*/g, "");

  it("positive — the Owned filter and the POSITIONS table membership both use isOwned (server-authoritative)", () => {
    expect(code).toContain("const ownedTickers = mergedTickers.filter(t => isOwned(stocksData[t.ticker]));");
    expect(code).toContain('const ownedFromData = Object.keys(stocksData).filter(k => k !== "__cash__" && isOwned(stocksData[k]));');
  });

  it("negative — NO ownership/quantity logic in the Stocks list view reads the legacy sharesSchwab / sharesEtrade", () => {
    expect(code).not.toMatch(/\.sharesSchwab|\.sharesEtrade/);
  });

  it("positive — the Schwab/ETrade quantity columns and their sorts come from the server's per-broker split", () => {
    expect(code).toContain("const split     = sharesByBroker(sd);");
    expect(code).toContain("Math.floor(split.schwab)");
    expect(code).toContain("Math.floor(split.etrade)");
    expect(code).toContain("av=sharesByBroker(sda).schwab; bv=sharesByBroker(sdb).schwab;");
    expect(code).toContain("av=sharesByBroker(sda).etrade; bv=sharesByBroker(sdb).etrade;");
  });

  it("positive — the existing quote poll also folds server holdings into state, READ-ONLY", () => {
    const poll = ui.slice(ui.indexOf("const pollRefresh = async"), ui.indexOf("const getInterval"));
    expect(poll).toContain("await loadStocksDataChecked(supabase)");
    expect(poll).toContain("mergeServerHoldings(prev, holdings.cols)");
    expect(poll).not.toMatch(/upsert|\.insert\(|\.update\(|\.delete\(/);
  });

  it("ratchet — legacy sharesSchwab/sharesEtrade references only shrink: what remains is the manual-entry inputs, the Add Stock form, the broker-pull display state and one order-sizing fallback (all deliberately untouched)", () => {
    // 20 token occurrences across 15 lines today (before this change there were 7 more, in the membership/qty/sort code)
    const refs = (ui.match(/sharesSchwab|sharesEtrade/g) || []).length;
    expect(refs).toBeLessThanOrEqual(20);
  });
});
