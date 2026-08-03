// tests/put-assignment.test.js
// Wheel strategy — auto-detect short-put assignment from a broker EQUITY BUY (the
// broker often posts a plain EQUITY BUY at the strike and drops the option with no
// explicit "Option Assigned" transaction, which caused ~10 historical assignments
// (OKLO, AMD) to need hand-fixing). Functions are imported directly from
// api/auto-import.js, not hand-mirrored — this touches real money (share purchases,
// P&L), same reasoning as api/chase-step.js's exports.
// Run: npx vitest run tests/put-assignment.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  findAssignedPutForEquityBuy, isPutPastExpiryITM, buildAssignedOptionClosePatch,
  makeAssignmentEquityFP, addDaysToDateStr,
} from "../api/auto-import.js";

const autoImportSrc = fs.readFileSync(path.resolve("api/auto-import.js"), "utf8");

function makePut(overrides = {}) {
  return {
    id: 42, stock: "OKLO", strike: 15, expires: "2026-07-24", qty: 5,
    account: "ETrade 6917", premium: 375.50, date_exec: "2026-07-01",
    type: "Put", opt_type: "STO", status: "Open",
    ...overrides,
  };
}

function makeEquityBuy(overrides = {}) {
  return {
    symbol: "OKLO", transaction_type: "BUY", quantity: 500, price: 15,
    account: "ETrade 6917", trade_date: "2026-07-26T20:00:00Z",
    net_amount: -7500, settlement_date: null, asset_type: "EQUITY",
    schwab_transaction_id: "etrade_555",
    ...overrides,
  };
}

describe("findAssignedPutForEquityBuy — end-to-end detection", () => {
  it("positive — ITM short put + broker EQUITY BUY at strike, qty=put_qty*100, same account -> matched", () => {
    const put = makePut();
    const matched = findAssignedPutForEquityBuy(makeEquityBuy(), [put]);
    expect(matched).toBe(put);
  });

  it("positive — trade lands exactly on the expiry date (same-day settlement)", () => {
    const put = makePut();
    const matched = findAssignedPutForEquityBuy(makeEquityBuy({ trade_date: "2026-07-24T20:00:00Z" }), [put]);
    expect(matched).toBe(put);
  });

  it("positive — trade lands 3 days after expiry (weekend/holiday settlement lag boundary)", () => {
    const put = makePut();
    const matched = findAssignedPutForEquityBuy(makeEquityBuy({ trade_date: "2026-07-27T20:00:00Z" }), [put]);
    expect(matched).toBe(put);
  });

  it("negative — trade lands before expiry (not a settlement of this put)", () => {
    const put = makePut();
    const matched = findAssignedPutForEquityBuy(makeEquityBuy({ trade_date: "2026-07-20T20:00:00Z" }), [put]);
    expect(matched).toBeNull();
  });

  it("negative — trade lands more than 3 days after expiry (outside the settlement window)", () => {
    const put = makePut();
    const matched = findAssignedPutForEquityBuy(makeEquityBuy({ trade_date: "2026-07-29T20:00:00Z" }), [put]);
    expect(matched).toBeNull();
  });

  it("negative — price does not match the strike", () => {
    const put = makePut();
    const matched = findAssignedPutForEquityBuy(makeEquityBuy({ price: 16 }), [put]);
    expect(matched).toBeNull();
  });

  it("negative — quantity does not equal put_qty*100", () => {
    const put = makePut({ qty: 5 }); // expects 500 shares
    const matched = findAssignedPutForEquityBuy(makeEquityBuy({ quantity: 300 }), [put]);
    expect(matched).toBeNull();
  });

  it("negative — different account does not match", () => {
    const put = makePut({ account: "ETrade 6917" });
    const matched = findAssignedPutForEquityBuy(makeEquityBuy({ account: "ETrade 8222" }), [put]);
    expect(matched).toBeNull();
  });

  it("negative — different symbol does not match", () => {
    const put = makePut({ stock: "OKLO" });
    const matched = findAssignedPutForEquityBuy(makeEquityBuy({ symbol: "AMD" }), [put]);
    expect(matched).toBeNull();
  });

  it("negative — put already Closed is not re-matched", () => {
    const put = makePut({ status: "Closed" });
    expect(findAssignedPutForEquityBuy(makeEquityBuy(), [put])).toBeNull();
  });

  it("negative — a BTO position is never matched (this is short-put assignment detection only)", () => {
    const put = makePut({ opt_type: "BTO" });
    expect(findAssignedPutForEquityBuy(makeEquityBuy(), [put])).toBeNull();
  });

  it("negative — a Call is never matched (puts only)", () => {
    const put = makePut({ type: "Call" });
    expect(findAssignedPutForEquityBuy(makeEquityBuy(), [put])).toBeNull();
  });

  it("edge — a SELL transaction is never treated as an assignment", () => {
    const put = makePut();
    expect(findAssignedPutForEquityBuy(makeEquityBuy({ transaction_type: "SELL" }), [put])).toBeNull();
  });

  it("edge — missing quantity or price is not matched", () => {
    const put = makePut();
    expect(findAssignedPutForEquityBuy(makeEquityBuy({ quantity: null }), [put])).toBeNull();
    expect(findAssignedPutForEquityBuy(makeEquityBuy({ price: null }), [put])).toBeNull();
  });

  it("edge — an invalid trade_date does not match", () => {
    const put = makePut();
    expect(findAssignedPutForEquityBuy(makeEquityBuy({ trade_date: "not-a-date" }), [put])).toBeNull();
  });

  it("edge — no open puts at all returns null without throwing", () => {
    expect(findAssignedPutForEquityBuy(makeEquityBuy(), [])).toBeNull();
    expect(findAssignedPutForEquityBuy(makeEquityBuy(), null)).toBeNull();
  });

  it("edge — multiple matching candidates prefers the most recently expired", () => {
    const older = makePut({ id: 1, expires: "2026-07-17" });
    const newer = makePut({ id: 2, expires: "2026-07-24" });
    // trade_date within 3 days of both — pick the nearer (newer) expiry
    const matched = findAssignedPutForEquityBuy(makeEquityBuy({ trade_date: "2026-07-26T20:00:00Z" }), [older, newer]);
    expect(matched.id).toBe(2);
  });
});

describe("isPutPastExpiryITM — past-expiry ITM fallback", () => {
  it("positive — expired and ITM (stock below strike) is treated as assigned", () => {
    const put = makePut({ expires: "2026-07-24" });
    expect(isPutPastExpiryITM(put, 12, "2026-07-27")).toBe(true); // $12 < $15 strike -> ITM
  });

  it("negative — OTM put expires worthless, not treated as assigned", () => {
    const put = makePut({ expires: "2026-07-24" });
    expect(isPutPastExpiryITM(put, 18, "2026-07-27")).toBe(false); // $18 > $15 strike -> OTM
  });

  it("negative — not yet expired", () => {
    const put = makePut({ expires: "2026-08-01" });
    expect(isPutPastExpiryITM(put, 12, "2026-07-27")).toBe(false);
  });

  it("negative — expires today does not count as 'past' yet", () => {
    const put = makePut({ expires: "2026-07-27" });
    expect(isPutPastExpiryITM(put, 12, "2026-07-27")).toBe(false);
  });

  it("negative — unknown current price (null) never infers assignment", () => {
    const put = makePut({ expires: "2026-07-24" });
    expect(isPutPastExpiryITM(put, null, "2026-07-27")).toBe(false);
  });

  it("negative — already Closed puts are ignored", () => {
    const put = makePut({ expires: "2026-07-24", status: "Closed" });
    expect(isPutPastExpiryITM(put, 12, "2026-07-27")).toBe(false);
  });

  it("negative — Calls are never inferred via this put-only fallback", () => {
    const put = makePut({ expires: "2026-07-24", type: "Call" });
    expect(isPutPastExpiryITM(put, 12, "2026-07-27")).toBe(false);
  });

  it("negative — BTO (long) positions are out of scope for this fallback", () => {
    const put = makePut({ expires: "2026-07-24", opt_type: "BTO" });
    expect(isPutPastExpiryITM(put, 12, "2026-07-27")).toBe(false);
  });
});

describe("buildAssignedOptionClosePatch", () => {
  it("positive — assigned short put keeps its full premium: cost_to_close=0, profit=premium, profit_pct=1.0 (fraction)", () => {
    const put = makePut({ premium: 375.50 });
    const patch = buildAssignedOptionClosePatch(put, "2026-07-26");
    expect(patch.status).toBe("Closed");
    expect(patch.cost_to_close).toBe(0);
    expect(patch.profit).toBeCloseTo(375.50, 2);
    expect(patch.profit_pct).toBeCloseTo(1.0, 4); // fraction, not 100 — UI multiplies by 100
    expect(patch.exercised).toBe("Yes");
    expect(patch.close_method).toBe("assigned");
    expect(patch.close_date).toBe("2026-07-26");
  });

  it("negative — a loss on assignment is still possible if premium itself was negative (documents the general formula, not a real STO scenario)", () => {
    // computeClosePnl is direction-aware; a short put's premium should always be
    // positive, but the formula itself doesn't special-case sign — worth pinning down.
    const put = makePut({ premium: -50, opt_type: "BTO" });
    const patch = buildAssignedOptionClosePatch(put, "2026-07-26");
    expect(patch.profit).toBeCloseTo(-50, 2);
    expect(patch.profit_pct).toBeCloseTo(-1.0, 4);
  });

  it("computes days_held from date_exec to close_date", () => {
    const put = makePut({ date_exec: "2026-07-01" });
    const patch = buildAssignedOptionClosePatch(put, "2026-07-26");
    expect(patch.days_held).toBe(25);
  });

  it("edge — days_held is null when date_exec is missing", () => {
    const put = makePut({ date_exec: null });
    const patch = buildAssignedOptionClosePatch(put, "2026-07-26");
    expect(patch.days_held).toBeNull();
  });
});

describe("makeAssignmentEquityFP — idempotency fingerprint", () => {
  it("positive — same real-world fill produces the same fingerprint regardless of time-of-day on trade_date", () => {
    const a = makeEquityBuy({ trade_date: "2026-07-26T13:00:00Z" });
    const b = makeEquityBuy({ trade_date: "2026-07-26T23:45:00Z" });
    expect(makeAssignmentEquityFP(a)).toBe(makeAssignmentEquityFP(b));
  });

  it("negative — a different quantity produces a different fingerprint", () => {
    const a = makeEquityBuy({ quantity: 500 });
    const b = makeEquityBuy({ quantity: 300 });
    expect(makeAssignmentEquityFP(a)).not.toBe(makeAssignmentEquityFP(b));
  });

  it("edge — re-import with a different ETrade transaction id is still caught by the fingerprint (idempotency)", () => {
    const existingFPs = new Set();
    const firstPass = makeEquityBuy({ schwab_transaction_id: "etrade_111" });
    existingFPs.add(makeAssignmentEquityFP(firstPass));

    // ETrade reissues a different transaction id for the same real-world fill on re-fetch
    const reissued = makeEquityBuy({ schwab_transaction_id: "etrade_999" });
    expect(existingFPs.has(makeAssignmentEquityFP(reissued))).toBe(true); // caught -> skipped, no duplicate row
  });
});

describe("addDaysToDateStr", () => {
  it("adds days across a month boundary", () => {
    expect(addDaysToDateStr("2026-07-30", 3)).toBe("2026-08-02");
  });
  it("zero days is a no-op", () => {
    expect(addDaysToDateStr("2026-07-24", 0)).toBe("2026-07-24");
  });
});

describe("negative — OTM put expiry is untouched by either new detection path", () => {
  it("negative — OTM put past expiry is not treated as assigned (worthless-expiry path handles it instead)", () => {
    const otmPut = makePut({ expires: "2026-07-24" });
    expect(isPutPastExpiryITM(otmPut, 18, "2026-07-27")).toBe(false); // $18 > $15 strike, OTM
  });
  it("negative — no equity BUY at all means no assignment is inferred from that path", () => {
    expect(findAssignedPutForEquityBuy(makeEquityBuy({ transaction_type: "SELL" }), [makePut()])).toBeNull();
  });
});

describe("api/auto-import.js — wiring and P11 invariant", () => {
  it("handleAssignment now writes exercised='Yes' (string), not the old boolean true", () => {
    const handleAssignmentBlock = autoImportSrc.split("async function handleAssignment(")[1]?.split("async function findAssignedPutForEquityBuy")[0] || "";
    expect(handleAssignmentBlock).toContain('exercised:     "Yes"');
    expect(handleAssignmentBlock).not.toContain("exercised:     true,");
  });

  it("handleAssignment now uses the shared computeClosePnl helper instead of an inline isSTO branch", () => {
    const handleAssignmentBlock = autoImportSrc.split("async function handleAssignment(")[1]?.split("async function findAssignedPutForEquityBuy")[0] || "";
    expect(handleAssignmentBlock).toContain("computeClosePnl(parent.opt_type, parent.premium, 0)");
  });

  it("P11 resolved (2026-08-03) — the generic equity-import list now spreads both schwabEquityTxs and etradeEquityTxs, guarded by account instead of exclusion", () => {
    expect(autoImportSrc).toContain("const allEquityTxs   = [...schwabEquityTxs, ...etradeEquityTxs];");
  });

  it("the assignment-linked stock_transactions write reuses the real parsed equity transaction (contract_id added, not a synthetic row)", () => {
    expect(autoImportSrc).toContain("...equityTx,\n    contract_id: option.id,");
  });

  it("dedup checks the composite fingerprint before attempting to match a put", () => {
    const detectionBlock = autoImportSrc.split("for (const eq of candidateEquityBuys)")[1]?.slice(0, 300) || "";
    expect(detectionBlock).toContain("existingAssignmentFPs.has(makeAssignmentEquityFP(eq))");
  });

  it("a matched equity BUY is removed via removeFromEquityLists so it isn't double-imported by the generic pipeline (either broker)", () => {
    expect(autoImportSrc).toContain("removeFromEquityLists(eq);");
  });

  it("open puts and calls for assignment detection are read fresh from the DB in one query, not the possibly-stale in-memory openContracts", () => {
    expect(autoImportSrc).toContain("contracts?opt_type=eq.STO&status=eq.Open&select=");
  });
});
