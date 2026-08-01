// tests/pnl.test.js
// Direction-aware close P&L calc — regression coverage for the BTO/long profit bug.
// Run: npx vitest run tests/pnl.test.js

import { describe, it, expect } from "vitest";
import { computeClosePnl as computeClosePnlClient } from "../src/lib/pnl.js";
import { computeClosePnl as computeClosePnlServer } from "../api/_lib/pnl.js";

describe.each([
  ["src/lib/pnl.js", computeClosePnlClient],
  ["api/_lib/pnl.js", computeClosePnlServer],
])("computeClosePnl (%s)", (_label, computeClosePnl) => {
  it("long (BTO) loss — DE $630 Call example: premium -1890.66, ctc 1119.32 -> -771.34 / -40.8%", () => {
    const { profit, profitPct } = computeClosePnl("BTO", -1890.66, 1119.32);
    expect(profit).toBeCloseTo(-771.34, 2);
    expect(profitPct * 100).toBeCloseTo(-40.8, 1);
  });

  it("short (STO) profit — unchanged behavior: premium 500, ctc 200 -> 300 / 60%", () => {
    const { profit, profitPct } = computeClosePnl("STO", 500, 200);
    expect(profit).toBeCloseTo(300, 2);
    expect(profitPct * 100).toBeCloseTo(60, 1);
  });

  it("long (BTO) win — premium -2602.05, ctc 6997.79 -> +4395.74", () => {
    const { profit } = computeClosePnl("BTO", -2602.05, 6997.79);
    expect(profit).toBeCloseTo(4395.74, 2);
  });

  it("edge: premium 0 -> profit_pct null, no divide-by-zero", () => {
    const { profitPct } = computeClosePnl("BTO", 0, 100);
    expect(profitPct).toBeNull();
  });

  it("short (STO) loss — bought back above premium: premium 300, ctc 450 -> -150", () => {
    const { profit, profitPct } = computeClosePnl("STO", 300, 450);
    expect(profit).toBeCloseTo(-150, 2);
    expect(profitPct * 100).toBeCloseTo(-50, 1);
  });

  it("long (BTO) full loss (expired worthless) — premium -800, ctc 0 -> -800 / -100%", () => {
    const { profit, profitPct } = computeClosePnl("BTO", -800, 0);
    expect(profit).toBeCloseTo(-800, 2);
    expect(profitPct * 100).toBeCloseTo(-100, 1);
  });
});
