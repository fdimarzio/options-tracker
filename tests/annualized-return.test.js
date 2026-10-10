// tests/annualized-return.test.js
// Cash-flow-aware YTD return math. The whole point of this helper is that deposits and
// withdrawals do NOT masquerade as performance, so the coverage here leans hard on those.
// Run: npx vitest run tests/annualized-return.test.js

import { describe, it, expect } from "vitest";
import { computeAnnualizedReturn } from "../src/lib/annualizedReturn.js";

const JUL1_2026 = new Date(Date.UTC(2026, 6, 1)); // 181 days after Jan 1, 2026 (non-leap)

describe("computeAnnualizedReturn — withdrawals are not losses", () => {
  it("a withdrawal that drops the ending balance still shows a real gain", () => {
    // Start $100k, end $95k, but $20k was withdrawn. Naive (end-start)/start = -5% (a 'loss').
    // True investment gain = 95k - 100k + 20k = +15k.
    const r = computeAnnualizedReturn({
      monthTotals: { "2025-12": 100000, "2026-07": 95000 },
      cashFlows: { "2026-04": { withdrawal: 20000 } },
      optionsProfitYTD: 0,
      asOf: JUL1_2026,
    });
    expect(r.ok).toBe(true);
    expect(r.withdrawals).toBe(20000);
    expect(r.gain).toBe(15000);
    expect(r.ytdReturn).toBeGreaterThan(0); // NOT a loss
    expect(r.annualizedReturn).toBeGreaterThan(r.ytdReturn); // partial year scales up
  });

  it("withdrawal time-weighting: capital base is reduced below the starting value", () => {
    const r = computeAnnualizedReturn({
      monthTotals: { "2025-12": 100000, "2026-07": 105000 },
      cashFlows: { "2026-04": { withdrawal: 10000 } },
      asOf: JUL1_2026,
    });
    expect(r.gain).toBe(15000); // 105k - 100k - (-10k)
    expect(r.startValue).toBe(100000);
    expect(r.capitalBase).toBeLessThan(100000); // withdrawal removed capital for part of the year
    expect(r.capitalBase).toBeGreaterThan(90000);
    // ~ 15000 / ~96575 (output rounded to 4 dp)
    expect(r.ytdReturn).toBeCloseTo(15000 / r.capitalBase, 3);
  });
});

describe("computeAnnualizedReturn — deposits are not gains", () => {
  it("a deposit that inflates the ending balance does not create return", () => {
    // Start $100k, end $150k, but $50k was deposited. True gain = 0.
    const r = computeAnnualizedReturn({
      monthTotals: { "2025-12": 100000, "2026-07": 150000 },
      cashFlows: { "2026-03": { deposit: 50000 } },
      asOf: JUL1_2026,
    });
    expect(r.ok).toBe(true);
    expect(r.deposits).toBe(50000);
    expect(r.gain).toBe(0);
    expect(r.ytdReturn).toBe(0);
  });

  it("deposits raise the capital base above the starting value", () => {
    const r = computeAnnualizedReturn({
      monthTotals: { "2025-12": 100000, "2026-07": 165000 },
      cashFlows: { "2026-03": { deposit: 50000 } },
      asOf: JUL1_2026,
    });
    expect(r.gain).toBe(15000); // 165k - 100k - 50k
    expect(r.capitalBase).toBeGreaterThan(100000);
    expect(r.netCashFlow).toBe(50000);
  });

  it("a deposit and a withdrawal in the same year net against each other", () => {
    const r = computeAnnualizedReturn({
      monthTotals: { "2025-12": 100000, "2026-07": 110000 },
      cashFlows: { "2026-02": { deposit: 20000 }, "2026-05": { withdrawal: 15000 } },
      asOf: JUL1_2026,
    });
    expect(r.deposits).toBe(20000);
    expect(r.withdrawals).toBe(15000);
    expect(r.netCashFlow).toBe(5000);
    expect(r.gain).toBe(5000); // 110k - 100k - 5k
  });
});

describe("computeAnnualizedReturn — plain performance and annualization", () => {
  it("no cash flows: gain is end minus start, and it flags that none were recorded", () => {
    const r = computeAnnualizedReturn({
      monthTotals: { "2025-12": 100000, "2026-07": 110000 },
      cashFlows: {},
      asOf: JUL1_2026,
    });
    expect(r.gain).toBe(10000);
    expect(r.ytdReturn).toBeCloseTo(0.1, 6);
    expect(r.daysElapsed).toBe(181);
    // ~6 months of +10% annualizes to roughly +21% (output rounded to 4 dp)
    expect(r.annualizedReturn).toBeCloseTo(Math.pow(1.1, 365 / 181) - 1, 3);
    expect(r.gaps.join(" ")).toMatch(/no deposits or withdrawals/i);
  });

  it("annualizing a loss that exceeds the capital base is withheld, not faked", () => {
    const r = computeAnnualizedReturn({
      monthTotals: { "2025-12": 100000, "2026-07": -5000 }, // contrived wipe-out
      cashFlows: {},
      asOf: JUL1_2026,
    });
    expect(r.ytdReturn).toBeLessThan(-1);
    expect(r.annualizedReturn).toBeNull();
    expect(r.gaps.join(" ")).toMatch(/misleading/i);
  });
});

describe("computeAnnualizedReturn — options strategy contribution", () => {
  it("options P&L is expressed relative to the portfolio capital base", () => {
    const r = computeAnnualizedReturn({
      monthTotals: { "2025-12": 100000, "2026-07": 112000 },
      cashFlows: {},
      optionsProfitYTD: 8000,
      asOf: JUL1_2026,
    });
    expect(r.optionsProfitYTD).toBe(8000);
    expect(r.optionsReturnYTD).toBeCloseTo(8000 / r.capitalBase, 6);
    expect(r.optionsAnnualized).toBeGreaterThan(r.optionsReturnYTD);
  });
});

describe("computeAnnualizedReturn — surfaces gaps instead of lying", () => {
  it("no year-opening balance: measures from the first tracked month and says so", () => {
    const r = computeAnnualizedReturn({
      monthTotals: { "2026-02": 100000, "2026-07": 110000 }, // no Dec 2025
      cashFlows: {},
      asOf: JUL1_2026,
    });
    expect(r.ok).toBe(true);
    expect(r.startFromYearOpen).toBe(false);
    expect(r.startMonth).toBe("2026-02");
    expect(r.gaps.join(" ")).toMatch(/year-opening balance/i);
  });

  it("no balances at all: returns not-ok with an explanation, no bogus number", () => {
    const r = computeAnnualizedReturn({ monthTotals: {}, cashFlows: {}, asOf: JUL1_2026 });
    expect(r.ok).toBe(false);
    expect(r.ytdReturn).toBeNull();
    expect(r.annualizedReturn).toBeNull();
    expect(r.gaps.join(" ")).toMatch(/no portfolio balance recorded/i);
  });

  it("only one balance point: not enough to measure a return", () => {
    const r = computeAnnualizedReturn({
      monthTotals: { "2025-12": 100000 },
      cashFlows: {},
      asOf: JUL1_2026,
    });
    expect(r.ok).toBe(false);
    expect(r.gaps.join(" ")).toMatch(/later balance/i);
  });
});
