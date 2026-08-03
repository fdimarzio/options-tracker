// tests/chase-cancel-routing.test.js
// Chase engine — route cancels to the correct broker. The cancel-on-expiry and
// cancel-on-hit-bound paths always called the Schwab-only action=cancel endpoint,
// even for ETrade orders, so an ETrade chase that hit its bound with
// chase_on_bound="cancel" likely failed to actually cancel at the broker while our
// own trade_orders row still got marked cancelled/expired. resolveCancelAction is
// imported directly from api/chase-step.js (not hand-mirrored), same reasoning as
// the rest of tests/chase.test.js. Run: npx vitest run tests/chase-cancel-routing.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { resolveCancelAction } from "../api/chase-step.js";

const chaseStepSrc = fs.readFileSync(path.resolve("api/chase-step.js"), "utf8");

describe("resolveCancelAction", () => {
  it("positive — an ETrade account routes to order-cancel", () => {
    expect(resolveCancelAction("ETrade 6917")).toBe("order-cancel");
  });
  it("positive — a Schwab account routes to cancel (unchanged)", () => {
    expect(resolveCancelAction("Schwab 3866")).toBe("cancel");
  });
  it("edge — the lowercase 'Etrade' variant also routes to order-cancel (matches fetchBrokerStatus's own detection)", () => {
    expect(resolveCancelAction("Etrade 8222")).toBe("order-cancel");
  });
  it("edge — a missing/unknown account defaults to the Schwab action rather than throwing", () => {
    expect(resolveCancelAction(undefined)).toBe("cancel");
    expect(resolveCancelAction(null)).toBe("cancel");
  });
});

// Mirrors cancelOrderAndCheckForRaceFill's decision logic — action routing uses the
// REAL imported resolveCancelAction (can't drift from production), the "what
// happens after" step is dependency-injected (postCancelBrokerState), consistent
// with this repo's simulateChaseStep convention (see tests/chase.test.js).
function simulateCancelAndRaceCheck(order, { postCancelBrokerState }) {
  const action = resolveCancelAction(order.account);
  const filled = postCancelBrokerState?.state === "full";
  return {
    action,
    outcome: filled ? "filled" : "cancelled",
    fillQty: filled ? postCancelBrokerState.fillQty ?? null : null,
    fillPrice: filled ? postCancelBrokerState.fillPrice ?? null : null,
  };
}

describe("end-to-end: cancel routing + race-fill correction", () => {
  it("positive — ETrade chase hits bound -> ETrade cancel (order-cancel) fired and confirmed cancelled", () => {
    const order = { account: "ETrade 6917" };
    const r = simulateCancelAndRaceCheck(order, { postCancelBrokerState: { state: "cancelled" } });
    expect(r.action).toBe("order-cancel");
    expect(r.outcome).toBe("cancelled");
  });

  it("positive — Schwab chase hits bound -> Schwab cancel (unchanged behavior)", () => {
    const order = { account: "Schwab 3866" };
    const r = simulateCancelAndRaceCheck(order, { postCancelBrokerState: { state: "cancelled" } });
    expect(r.action).toBe("cancel");
    expect(r.outcome).toBe("cancelled");
  });

  it("edge — cancel rejected because already filled (ETrade) -> handled as a fill, not an error", () => {
    const order = { account: "ETrade 6917" };
    const r = simulateCancelAndRaceCheck(order, { postCancelBrokerState: { state: "full", fillQty: 2, fillPrice: 1.35 } });
    expect(r.action).toBe("order-cancel");
    expect(r.outcome).toBe("filled");
    expect(r.fillQty).toBe(2);
    expect(r.fillPrice).toBe(1.35);
  });

  it("edge — cancel rejected because already filled (Schwab) -> also handled as a fill", () => {
    const order = { account: "Schwab 3866" };
    const r = simulateCancelAndRaceCheck(order, { postCancelBrokerState: { state: "full", fillQty: 1, fillPrice: 2.10 } });
    expect(r.action).toBe("cancel");
    expect(r.outcome).toBe("filled");
  });
});

describe("api/chase-step.js — cancel call sites route through resolveCancelAction", () => {
  it("neither the expiry-cancel nor hit-bound-cancel path hardcodes action=cancel anymore", () => {
    expect(chaseStepSrc).not.toMatch(/action=cancel&secret=\$\{process\.env\.CRON_SECRET\}`, \{ method: "POST"/);
  });

  it("cancelOrderAndCheckForRaceFill builds its URL from resolveCancelAction, not a hardcoded action", () => {
    const fnBlock = chaseStepSrc.split("async function cancelOrderAndCheckForRaceFill")[1]?.split("async function appendHistory")[0] || "";
    expect(fnBlock).toContain("const action = resolveCancelAction(order.account);");
    expect(fnBlock).toContain("action=${action}&secret=");
  });

  it("both the expiry and hit_bound branches call cancelOrderAndCheckForRaceFill", () => {
    const occurrences = chaseStepSrc.match(/await cancelOrderAndCheckForRaceFill\(order, token\)/g) || [];
    expect(occurrences.length).toBe(2);
  });

  it("both branches override the outcome to 'filled' (not expired/hit_bound) when the race check detects a fill", () => {
    const occurrences = chaseStepSrc.match(/if \(raceCheck\.filled\) \{/g) || [];
    expect(occurrences.length).toBe(2);
    // Each of the 2 new race-fill overrides writes chase_status/status: "filled" and
    // returns action: "filled" — plus 1 pre-existing occurrence in the unrelated
    // top-of-function race guard (broker already reports "full" before any cancel
    // is even attempted), so 3 total.
    const filledWrites = chaseStepSrc.match(/chase_status: "filled", status: "filled"/g) || [];
    expect(filledWrites.length).toBe(3);
  });

  it("cancelOrderAndCheckForRaceFill re-checks broker status after cancelling, rather than assuming success", () => {
    const fnBlock = chaseStepSrc.split("async function cancelOrderAndCheckForRaceFill")[1]?.split("async function appendHistory")[0] || "";
    expect(fnBlock).toContain("fetchBrokerStatus(order, token)");
  });
});
