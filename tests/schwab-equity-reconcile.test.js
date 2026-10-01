// tests/schwab-equity-reconcile.test.js
// Regression tests for the Schwab realized-G/L reconciliation fixes in api/auto-import.js
// (2026-10-01). Three defects surfaced by reconciling the Schwab account against the
// broker's realized-G/L report:
//   1. parseSchwabEquityTx re-derived symbol/quantity/price from the FIRST item carrying
//      any symbol — on a TRADE that's the CURRENCY_USD cash leg, not the security
//      (12 historical rows mislabeled). It must use the recognised equity leg.
//   2. A TRADE with no recognised security item was silently dropped (`return null`),
//      losing the 2026-06-11 PANW/TKO/UPS sells. It must surface an anomaly instead.
//   3. BTC/STC "closer" rows must carry profit=null and close_date=null — realized P&L
//      lives solely on the parent opener (canonical rule: pri-tod-v3.jsx:4269 and the
//      `originals` filter at :4980), never on the closer.
//
// parseSchwabEquityTx is imported directly (real money path — same reasoning as the
// other api/auto-import.js exports). Change #3 lives inside the big DB-bound commitTx,
// so it's asserted against the source text — the same approach the existing
// put-assignment.test.js uses for auto-import wiring.
// Run: npx vitest run tests/schwab-equity-reconcile.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { parseSchwabEquityTx } from "../api/auto-import.js";

const autoImportSrc = fs.readFileSync(path.resolve("api/auto-import.js"), "utf8");

// A Schwab TRADE as the broker returns it: one equity leg + one CURRENCY_USD cash leg.
// The currency leg is listed FIRST here — exactly the ordering that made the old
// `items.find(i => i.instrument?.symbol)` grab CURRENCY_USD.
function makeTradeTx(overrides = {}) {
  return {
    activityId:  3661,
    type:        "TRADE",
    netAmount:   -209.66, // negative = cash out = BUY
    tradeDate:   "2026-09-15T14:30:00.000Z",
    settlementDate: "2026-09-17T00:00:00.000Z",
    description: "Buy 1 ADBE @ 209.66",
    transferItems: [
      { instrument: { assetType: "CURRENCY", symbol: "CURRENCY_USD" }, amount: -209.66 },
      { instrument: { assetType: "EQUITY",   symbol: "ADBE" },         amount: 1, price: 209.66 },
    ],
    ...overrides,
  };
}

describe("parseSchwabEquityTx — #1 symbol attribution (equity leg, not the currency leg)", () => {
  it("picks the equity symbol/quantity/price, not the CURRENCY_USD cash leg", () => {
    const r = parseSchwabEquityTx(makeTradeTx(), "...3866");
    expect(r.symbol).toBe("ADBE");
    expect(r.symbol).not.toBe("CURRENCY_USD");
    expect(r.quantity).toBe(1);
    expect(r.price).toBe(209.66);
    expect(r.transaction_type).toBe("BUY");
    expect(r.schwab_transaction_id).toBe("3661");
  });

  it("picks the equity leg regardless of transferItems order (currency leg last)", () => {
    const tx = makeTradeTx({
      netAmount: 1819.05, // positive = cash in = SELL
      transferItems: [
        { instrument: { assetType: "EQUITY",   symbol: "TKO" },          amount: 8.82, price: 206.24 },
        { instrument: { assetType: "CURRENCY", symbol: "CURRENCY_USD" }, amount: 1819.05 },
      ],
    });
    const r = parseSchwabEquityTx(tx, "...3866");
    expect(r.symbol).toBe("TKO");
    expect(r.quantity).toBe(8.82);
    expect(r.transaction_type).toBe("SELL");
  });

  it("falls back to the symbol-bearing leg for NON-TRADE activity (e.g. a dividend), unchanged", () => {
    const tx = {
      activityId: 9001, type: "DIVIDEND", netAmount: 12.34,
      tradeDate: "2026-09-10T14:30:00.000Z", description: "Qualified dividend",
      transferItems: [{ instrument: { assetType: "EQUITY", symbol: "JPM" }, amount: 0 }],
    };
    const r = parseSchwabEquityTx(tx, "...3866");
    expect(r._anomaly).toBeUndefined();
    expect(r.symbol).toBe("JPM");
    expect(r.transaction_type).toBe("DIVIDEND");
  });
});

describe("parseSchwabEquityTx — #2 unparseable TRADE becomes an anomaly, not a silent drop", () => {
  it("a TRADE with no EQUITY/ETF/MUTUAL_FUND item returns an anomaly object (not null)", () => {
    const tx = makeTradeTx({
      activityId: 55501, netAmount: 3904.74,
      description: "Sale — no recognised security leg",
      transferItems: [
        { instrument: { assetType: "CURRENCY", symbol: "CURRENCY_USD" }, amount: 3904.74 },
      ],
    });
    const r = parseSchwabEquityTx(tx, "...3866");
    expect(r).not.toBeNull();
    expect(r._anomaly).toBe(true);
    expect(r.anomaly_type).toBe("equity_trade_unparsed");
    expect(r.schwab_transaction_id).toBe("55501");
    expect(r.raw).toBe(tx); // raw is carried for manual review
  });

  it("still returns null for an OPTION transaction (handled by parseSchwabTx, not an anomaly)", () => {
    const tx = {
      activityId: 42, type: "TRADE", netAmount: 100,
      tradeDate: "2026-09-15T14:30:00.000Z",
      transferItems: [{ instrument: { assetType: "OPTION", symbol: "ADBE  260918C00500000" }, amount: 1 }],
    };
    expect(parseSchwabEquityTx(tx, "...3866")).toBeNull();
  });
});

describe("#3 BTC/STC closer rows carry profit=null / close_date=null — P&L stays on the parent", () => {
  // The inserted contract row (openers AND closers) explicitly sets profit/close_date null.
  const rowBlock = autoImportSrc.match(/const row = \{[\s\S]*?\n {2}\};/);

  it("the inserted contract row sets profit: null and close_date: null", () => {
    expect(rowBlock, "could not locate the `const row = {...}` insert object").toBeTruthy();
    expect(rowBlock[0]).toMatch(/profit:\s*null/);
    expect(rowBlock[0]).toMatch(/close_date:\s*null/);
  });

  // The split-fill merge patches the closer row (existingCloser.id). It must NOT write
  // profit/profit_pct there. Strip comments first so the explanatory comment (which
  // mentions "profit") can't satisfy the assertion.
  const closerPatch = autoImportSrc.match(/sbPatch\("contracts", existingCloser\.id, \{[\s\S]*?\n {6}\}\);/);
  const closerPatchCode = closerPatch ? closerPatch[0].replace(/\/\/.*$/gm, "") : "";

  it("the split-fill merge does NOT write profit/profit_pct onto the closer row", () => {
    expect(closerPatch, "could not locate the existingCloser.id sbPatch").toBeTruthy();
    expect(closerPatchCode).not.toMatch(/profit/);
  });

  // Positive control: the parent opener patch in the same merge still carries the P&L.
  const parentPatch = autoImportSrc.match(/sbPatch\("contracts", existingCloser\.parent\.id, \{[\s\S]*?\n {8}\}\);/);

  it("the parent opener patch still carries profit/profit_pct (P&L lands on the parent)", () => {
    expect(parentPatch, "could not locate the existingCloser.parent.id sbPatch").toBeTruthy();
    expect(parentPatch[0]).toMatch(/profit/);
  });
});
