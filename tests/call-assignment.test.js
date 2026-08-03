// tests/call-assignment.test.js
// Covered-call assignment — the mirror of the shipped put-assignment handler
// (tests/put-assignment.test.js): an ITM short call is assigned by the broker
// SELLING the shares at the strike, instead of buying them. Functions are
// imported directly from api/auto-import.js, not hand-mirrored — same reasoning
// as tests/put-assignment.test.js and api/chase-step.js's exports.
// Run: npx vitest run tests/call-assignment.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  findAssignedCallForEquitySell, isCallPastExpiryITM, buildAssignedOptionClosePatch,
  makeAssignmentEquityFP,
} from "../api/auto-import.js";

const autoImportSrc = fs.readFileSync(path.resolve("api/auto-import.js"), "utf8");

function makeCall(overrides = {}) {
  return {
    id: 77, stock: "NVDA", strike: 130, expires: "2026-07-24", qty: 2,
    account: "Schwab 3866", premium: 214.50, date_exec: "2026-07-01",
    type: "Call", opt_type: "STO", status: "Open",
    ...overrides,
  };
}

function makeEquitySell(overrides = {}) {
  return {
    symbol: "NVDA", transaction_type: "SELL", quantity: 200, price: 130,
    account: "Schwab 3866", trade_date: "2026-07-26T20:00:00Z",
    net_amount: 26000, settlement_date: null, asset_type: "EQUITY",
    schwab_transaction_id: "schwab_999",
    ...overrides,
  };
}

describe("findAssignedCallForEquitySell — end-to-end detection", () => {
  it("positive — ITM short call + broker EQUITY SELL at strike, qty=call_qty*100, same account -> matched", () => {
    const call = makeCall();
    const matched = findAssignedCallForEquitySell(makeEquitySell(), [call]);
    expect(matched).toBe(call);
  });

  it("positive — trade lands exactly on the expiry date (same-day settlement)", () => {
    const call = makeCall();
    const matched = findAssignedCallForEquitySell(makeEquitySell({ trade_date: "2026-07-24T20:00:00Z" }), [call]);
    expect(matched).toBe(call);
  });

  it("positive — trade lands 3 days after expiry (weekend/holiday settlement lag boundary)", () => {
    const call = makeCall();
    const matched = findAssignedCallForEquitySell(makeEquitySell({ trade_date: "2026-07-27T20:00:00Z" }), [call]);
    expect(matched).toBe(call);
  });

  it("negative — trade lands before expiry (not a settlement of this call)", () => {
    const call = makeCall();
    const matched = findAssignedCallForEquitySell(makeEquitySell({ trade_date: "2026-07-20T20:00:00Z" }), [call]);
    expect(matched).toBeNull();
  });

  it("negative — trade lands more than 3 days after expiry (outside the settlement window)", () => {
    const call = makeCall();
    const matched = findAssignedCallForEquitySell(makeEquitySell({ trade_date: "2026-07-29T20:00:00Z" }), [call]);
    expect(matched).toBeNull();
  });

  it("negative — price does not match the strike", () => {
    const call = makeCall();
    const matched = findAssignedCallForEquitySell(makeEquitySell({ price: 131 }), [call]);
    expect(matched).toBeNull();
  });

  it("negative — quantity does not equal call_qty*100", () => {
    const call = makeCall({ qty: 2 }); // expects 200 shares
    const matched = findAssignedCallForEquitySell(makeEquitySell({ quantity: 100 }), [call]);
    expect(matched).toBeNull();
  });

  it("negative — different account does not match", () => {
    const call = makeCall({ account: "Schwab 3866" });
    const matched = findAssignedCallForEquitySell(makeEquitySell({ account: "ETrade 6917" }), [call]);
    expect(matched).toBeNull();
  });

  it("negative — different symbol does not match", () => {
    const call = makeCall({ stock: "NVDA" });
    const matched = findAssignedCallForEquitySell(makeEquitySell({ symbol: "AMD" }), [call]);
    expect(matched).toBeNull();
  });

  it("negative — call already Closed is not re-matched", () => {
    const call = makeCall({ status: "Closed" });
    expect(findAssignedCallForEquitySell(makeEquitySell(), [call])).toBeNull();
  });

  it("negative — a BTO position is never matched (this is short-call assignment detection only)", () => {
    const call = makeCall({ opt_type: "BTO" });
    expect(findAssignedCallForEquitySell(makeEquitySell(), [call])).toBeNull();
  });

  it("negative — a Put is never matched (calls only)", () => {
    const call = makeCall({ type: "Put" });
    expect(findAssignedCallForEquitySell(makeEquitySell(), [call])).toBeNull();
  });

  it("edge — a BUY transaction is never treated as a call assignment", () => {
    const call = makeCall();
    expect(findAssignedCallForEquitySell(makeEquitySell({ transaction_type: "BUY" }), [call])).toBeNull();
  });

  it("edge — missing quantity or price is not matched", () => {
    const call = makeCall();
    expect(findAssignedCallForEquitySell(makeEquitySell({ quantity: null }), [call])).toBeNull();
    expect(findAssignedCallForEquitySell(makeEquitySell({ price: null }), [call])).toBeNull();
  });

  it("edge — an invalid trade_date does not match", () => {
    const call = makeCall();
    expect(findAssignedCallForEquitySell(makeEquitySell({ trade_date: "not-a-date" }), [call])).toBeNull();
  });

  it("edge — no open calls at all returns null without throwing", () => {
    expect(findAssignedCallForEquitySell(makeEquitySell(), [])).toBeNull();
    expect(findAssignedCallForEquitySell(makeEquitySell(), null)).toBeNull();
  });

  it("edge — multiple matching candidates prefers the most recently expired", () => {
    const older = makeCall({ id: 1, expires: "2026-07-17" });
    const newer = makeCall({ id: 2, expires: "2026-07-24" });
    const matched = findAssignedCallForEquitySell(makeEquitySell({ trade_date: "2026-07-26T20:00:00Z" }), [older, newer]);
    expect(matched.id).toBe(2);
  });
});

describe("isCallPastExpiryITM — past-expiry ITM fallback", () => {
  it("positive — expired and ITM (stock above strike) is treated as assigned", () => {
    const call = makeCall({ expires: "2026-07-24" });
    expect(isCallPastExpiryITM(call, 135, "2026-07-27")).toBe(true); // $135 > $130 strike -> ITM
  });

  it("negative — OTM call expires worthless, not treated as assigned", () => {
    const call = makeCall({ expires: "2026-07-24" });
    expect(isCallPastExpiryITM(call, 125, "2026-07-27")).toBe(false); // $125 < $130 strike -> OTM
  });

  it("negative — not yet expired", () => {
    const call = makeCall({ expires: "2026-08-01" });
    expect(isCallPastExpiryITM(call, 135, "2026-07-27")).toBe(false);
  });

  it("negative — expires today does not count as 'past' yet", () => {
    const call = makeCall({ expires: "2026-07-27" });
    expect(isCallPastExpiryITM(call, 135, "2026-07-27")).toBe(false);
  });

  it("negative — unknown current price (null) never infers assignment", () => {
    const call = makeCall({ expires: "2026-07-24" });
    expect(isCallPastExpiryITM(call, null, "2026-07-27")).toBe(false);
  });

  it("negative — already Closed calls are ignored", () => {
    const call = makeCall({ expires: "2026-07-24", status: "Closed" });
    expect(isCallPastExpiryITM(call, 135, "2026-07-27")).toBe(false);
  });

  it("negative — Puts are never inferred via this call-only fallback", () => {
    const call = makeCall({ expires: "2026-07-24", type: "Put" });
    expect(isCallPastExpiryITM(call, 135, "2026-07-27")).toBe(false);
  });

  it("negative — BTO (long) positions are out of scope for this fallback", () => {
    const call = makeCall({ expires: "2026-07-24", opt_type: "BTO" });
    expect(isCallPastExpiryITM(call, 135, "2026-07-27")).toBe(false);
  });
});

describe("buildAssignedOptionClosePatch — covered call", () => {
  it("positive — assigned short call keeps its full premium: cost_to_close=0, profit=premium, profit_pct=1.0 (fraction)", () => {
    const call = makeCall({ premium: 214.50 });
    const patch = buildAssignedOptionClosePatch(call, "2026-07-26");
    expect(patch.status).toBe("Closed");
    expect(patch.cost_to_close).toBe(0);
    expect(patch.profit).toBeCloseTo(214.50, 2);
    expect(patch.profit_pct).toBeCloseTo(1.0, 4);
    expect(patch.exercised).toBe("Yes");
    expect(patch.close_method).toBe("assigned");
    expect(patch.close_date).toBe("2026-07-26");
  });

  it("the notes field reflects the option type generically (call vs put)", () => {
    const call = makeCall();
    expect(buildAssignedOptionClosePatch(call, "2026-07-26").notes).toContain("call assigned");
  });
});

describe("makeAssignmentEquityFP — SELL side is distinguished from BUY", () => {
  it("negative — a BUY and a SELL of the same symbol/date/qty/price/account produce different fingerprints", () => {
    const sell = makeEquitySell();
    const buy  = { ...sell, transaction_type: "BUY" };
    expect(makeAssignmentEquityFP(sell)).not.toBe(makeAssignmentEquityFP(buy));
  });

  it("edge — re-import with a different ETrade transaction id is still caught by the fingerprint (idempotency)", () => {
    const existingFPs = new Set();
    const firstPass = makeEquitySell({ account: "ETrade 6917", schwab_transaction_id: "etrade_111" });
    existingFPs.add(makeAssignmentEquityFP(firstPass));
    const reissued = makeEquitySell({ account: "ETrade 6917", schwab_transaction_id: "etrade_999" });
    expect(existingFPs.has(makeAssignmentEquityFP(reissued))).toBe(true); // caught -> skipped, no duplicate row
  });
});

describe("negative — OTM call expiry is untouched by either new detection path", () => {
  it("negative — OTM call past expiry is not treated as assigned (worthless-expiry path handles it instead)", () => {
    const otmCall = makeCall({ expires: "2026-07-24" });
    expect(isCallPastExpiryITM(otmCall, 125, "2026-07-27")).toBe(false); // $125 < $130 strike, OTM
  });
  it("negative — no equity SELL at all means no assignment is inferred from that path", () => {
    expect(findAssignedCallForEquitySell(makeEquitySell({ transaction_type: "BUY" }), [makeCall()])).toBeNull();
  });
});

describe("api/auto-import.js — covered-call wiring", () => {
  it("the orchestration block handles both BUY (puts) and SELL (calls) candidate lists", () => {
    expect(autoImportSrc).toContain('candidateEquityBuys  = allEquityTxsForAssignment.filter(eq => eq.transaction_type === "BUY")');
    expect(autoImportSrc).toContain('candidateEquitySells = allEquityTxsForAssignment.filter(eq => eq.transaction_type === "SELL")');
  });

  it("call assignment closes the contract via processCallAssignmentFromEquity", () => {
    expect(autoImportSrc).toContain("await processCallAssignmentFromEquity(eq, call);");
  });

  it("a matched equity SELL is removed via removeFromEquityLists so it isn't double-imported by the generic pipeline (either broker)", () => {
    const callBlock = autoImportSrc.split("// Covered calls: assignment")[1]?.split("// Fallback:")[0] || "";
    expect(callBlock).toContain("removeFromEquityLists(eq);");
  });

  it("puts and calls share the same claimedContractIds/existingAssignmentFPs dedup state (one query, not two)", () => {
    const occurrences = autoImportSrc.match(/stock_transactions\?contract_id=not\.is\.null/g) || [];
    expect(occurrences.length).toBe(1);
  });

  it("the past-expiry-ITM fallback writes SELL (not BUY) for a call, with a positive net_amount", () => {
    expect(autoImportSrc).toContain("transaction_type: isPut ? \"BUY\" : \"SELL\"");
    expect(autoImportSrc).toContain("net_amount:       isPut ? -(+option.strike * sharesQty) : (+option.strike * sharesQty)");
  });
});
