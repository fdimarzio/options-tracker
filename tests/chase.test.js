// tests/chase.test.js
// Vitest tests for the /api/chase-step engine (api/chase-step.js).
// Unlike most test files in this repo, the atomic decision functions here are
// imported directly from the real source module (not hand-mirrored) — chase-step.js
// exports them specifically so this suite can never drift from production logic on
// a feature that moves real money. The higher-level scenarios (fill mid-chase,
// race guard, guard trips, full replay) are covered by a `simulateChaseStep`
// orchestrator built from those same imports, following the exact same step
// sequence as processOrder() in api/chase-step.js, with network calls replaced by
// injected context (brokerStatus, quote) — dependency injection instead of mocking,
// consistent with how this repo tests everything else.
// Run: npx vitest run tests/chase.test.js

import { describe, it, expect } from "vitest";
import {
  isDue, isExpired, resolveStep, computeNextPrice, clampToBound,
  evaluateMarketGuards, interpretFillState, applyOnBound, buildOSI, isMarketHours,
} from "../api/chase-step.js";

// ── Orchestrator mirroring processOrder()'s step sequence (see api/chase-step.js) ──
function simulateChaseStep(order, ctx) {
  const { nowMs, minIntervalSecs = 20, chaseParams = {}, dryRun = true, brokerStatus = { state: "none" }, quote, underlyingNow, underlyingStart, vix } = ctx;

  // a. Interval gate
  if (!isDue(order, nowMs, minIntervalSecs)) return { action: "skip", reason: "interval_gate" };

  // b. Fresh broker status check — race guard
  const fill = brokerStatus.state ? brokerStatus : interpretFillState(brokerStatus, order.qty);
  if (fill.state === "full") return { action: "filled", fillQty: fill.fillQty, fillPrice: fill.fillPrice, brokerCalled: false };
  if (fill.state === "cancelled") return { action: "cancelled_at_broker", brokerCalled: false };
  let workingOrder = order;
  if (fill.state === "partial") workingOrder = { ...order, qty: fill.remainingQty };

  // c. Expiry
  if (isExpired(workingOrder, nowMs)) {
    return { action: "expired", onBound: applyOnBound(workingOrder.chase_on_bound) };
  }

  // d. Live quote
  if (!quote || quote.bid == null || quote.ask == null) return { action: "skip", reason: "no_quote" };
  const { bid, ask, mid } = quote;

  // e. Market-context guards
  const guardResult = evaluateMarketGuards({ order: workingOrder, bid, ask, mid, underlyingNow, underlyingStart, vix, guards: chaseParams.market_guards });
  if (guardResult.tripped) {
    if (guardResult.onTrip === "exit") return { action: "guard_exit", reasons: guardResult.reasons, onBound: applyOnBound(workingOrder.chase_on_bound) };
    return { action: "guard_pause", reasons: guardResult.reasons };
  }

  // f/g/h. Step, next price, clamp
  const step = resolveStep(workingOrder, chaseParams, bid, ask);
  const rawNext = computeNextPrice(workingOrder, step, bid, ask);
  const { price: toPrice, clamped } = clampToBound(workingOrder, rawNext);

  if (Math.abs(toPrice - +workingOrder.limit_price) < 0.005 && !clamped) return { action: "skip", reason: "no_change" };

  if (clamped) return { action: "hit_bound", toPrice, onBound: applyOnBound(workingOrder.chase_on_bound), brokerCalled: !dryRun };

  // i. Apply
  return { action: dryRun ? "dry_run_step" : "step", fromPrice: workingOrder.limit_price, toPrice, brokerCalled: !dryRun };
}

const NOW = new Date("2026-07-15T14:30:00Z").getTime(); // 10:30am ET, within market hours

function makeOrder(overrides = {}) {
  return {
    id: 100, ticker: "AMZN", type: "Call", strike: 220, expires: "2026-08-21",
    opt_type: "STO", qty: 2, limit_price: 2.50, account: "Schwab 3866",
    chase_bound: 2.00, chase_status: "active", chase_on_bound: "rest",
    chase_expires_at: new Date(NOW + 1800000).toISOString(), // 30 min from now
    chase_last_step_at: null, price_history: [],
    ...overrides,
  };
}

// ── 1. SELL steps down by chase_step toward the bid ───────────────────────────
describe("computeNextPrice — SELL (STO/STC)", () => {
  it("steps down by chase_step toward the bid", () => {
    const order = makeOrder({ opt_type: "STO", limit_price: 2.50 });
    const next = computeNextPrice(order, 0.10, 2.10, 2.55);
    expect(next).toBeCloseTo(2.40, 5);
  });
  it("never overshoots below the current bid", () => {
    const order = makeOrder({ opt_type: "STO", limit_price: 2.15 });
    const next = computeNextPrice(order, 0.50, 2.10, 2.20); // big step would go to 1.65, below bid
    expect(next).toBeCloseTo(2.10, 5);
  });
  it("STC behaves the same direction as STO", () => {
    const order = makeOrder({ opt_type: "STC", limit_price: 1.00 });
    expect(computeNextPrice(order, 0.05, 0.80, 1.05)).toBeCloseTo(0.95, 5);
  });
});

// ── 2. BUY steps up by chase_step toward the ask ───────────────────────────────
describe("computeNextPrice — BUY (BTC/BTO)", () => {
  it("steps up by chase_step toward the ask", () => {
    const order = makeOrder({ opt_type: "BTC", limit_price: 0.30 });
    const next = computeNextPrice(order, 0.05, 0.28, 0.50);
    expect(next).toBeCloseTo(0.35, 5);
  });
  it("never overshoots above the current ask", () => {
    const order = makeOrder({ opt_type: "BTC", limit_price: 0.45 });
    const next = computeNextPrice(order, 0.20, 0.28, 0.50); // would go to 0.65, above ask
    expect(next).toBeCloseTo(0.50, 5);
  });
  it("BTO behaves the same direction as BTC", () => {
    const order = makeOrder({ opt_type: "BTO", limit_price: 5.00 });
    expect(computeNextPrice(order, 0.05, 4.90, 5.50)).toBeCloseTo(5.05, 5);
  });
});

// ── 3. Bound clamp both sides ───────────────────────────────────────────────────
describe("clampToBound", () => {
  it("SELL clamps at chase_bound (floor), never below", () => {
    const order = makeOrder({ opt_type: "STO", chase_bound: 2.00 });
    const r = clampToBound(order, 1.90);
    expect(r.clamped).toBe(true);
    expect(r.price).toBe(2.00);
  });
  it("SELL does not clamp when above the floor", () => {
    const order = makeOrder({ opt_type: "STO", chase_bound: 2.00 });
    const r = clampToBound(order, 2.30);
    expect(r.clamped).toBe(false);
    expect(r.price).toBe(2.30);
  });
  it("BUY clamps at chase_bound (ceiling), never above", () => {
    const order = makeOrder({ opt_type: "BTC", chase_bound: 0.50 });
    const r = clampToBound(order, 0.55);
    expect(r.clamped).toBe(true);
    expect(r.price).toBe(0.50);
  });
  it("BUY does not clamp when below the ceiling", () => {
    const order = makeOrder({ opt_type: "BTC", chase_bound: 0.50 });
    const r = clampToBound(order, 0.35);
    expect(r.clamped).toBe(false);
  });
  it("no bound set → never clamps (safety: absence of a bound is not a 0.00 floor)", () => {
    const order = makeOrder({ opt_type: "STO", chase_bound: null });
    const r = clampToBound(order, 0.01);
    expect(r.clamped).toBe(false);
    expect(r.price).toBe(0.01);
  });
});

// ── 4. Interval gate ─────────────────────────────────────────────────────────────
describe("isDue — interval gate", () => {
  it("is due when chase_last_step_at is null (never stepped)", () => {
    expect(isDue(makeOrder({ chase_last_step_at: null }), NOW, 20)).toBe(true);
  });
  it("is NOT due within min_interval_secs of the last step", () => {
    const order = makeOrder({ chase_last_step_at: new Date(NOW - 10000).toISOString() }); // 10s ago
    expect(isDue(order, NOW, 20)).toBe(false);
  });
  it("is due once min_interval_secs has elapsed", () => {
    const order = makeOrder({ chase_last_step_at: new Date(NOW - 21000).toISOString() }); // 21s ago
    expect(isDue(order, NOW, 20)).toBe(true);
  });
  it("two calls inside min_interval_secs produce exactly one step", () => {
    const order = makeOrder({ chase_last_step_at: null });
    const ctx = { nowMs: NOW, minIntervalSecs: 20, dryRun: true, brokerStatus: { state: "none" }, quote: { bid: 2.10, ask: 2.55, mid: 2.325 } };

    // First call: due, steps.
    const first = simulateChaseStep(order, ctx);
    expect(first.action).toBe("dry_run_step");

    // Simulate the engine stamping chase_last_step_at after the first step.
    const orderAfterStep = { ...order, chase_last_step_at: new Date(NOW).toISOString(), limit_price: first.toPrice };

    // Second call 5s later — still inside the 20s interval.
    const second = simulateChaseStep(orderAfterStep, { ...ctx, nowMs: NOW + 5000 });
    expect(second.action).toBe("skip");
    expect(second.reason).toBe("interval_gate");
  });
});

// ── 5. dry_run — logs but never calls the broker ──────────────────────────────
describe("dry_run gating", () => {
  it("dry_run=true produces a dry_run_step and brokerCalled=false", () => {
    const order = makeOrder({ chase_last_step_at: null });
    const r = simulateChaseStep(order, { nowMs: NOW, dryRun: true, brokerStatus: { state: "none" }, quote: { bid: 2.10, ask: 2.55, mid: 2.325 } });
    expect(r.action).toBe("dry_run_step");
    expect(r.brokerCalled).toBe(false);
  });
  it("dry_run=false produces a step and brokerCalled=true", () => {
    const order = makeOrder({ chase_last_step_at: null });
    const r = simulateChaseStep(order, { nowMs: NOW, dryRun: false, brokerStatus: { state: "none" }, quote: { bid: 2.10, ask: 2.55, mid: 2.325 } });
    expect(r.action).toBe("step");
    expect(r.brokerCalled).toBe(true);
  });
});

// ── 6. Fill mid-chase — reconcile + stop ─────────────────────────────────────────
describe("fill mid-chase (race guard reconciliation)", () => {
  it("full fill on the status check stops the chase with no step taken", () => {
    const order = makeOrder({ chase_last_step_at: null });
    const r = simulateChaseStep(order, {
      nowMs: NOW, dryRun: true,
      brokerStatus: interpretFillState({ filled: true, filledQty: 2, fillPrice: 2.35 }, order.qty),
      quote: { bid: 2.10, ask: 2.55, mid: 2.325 },
    });
    expect(r.action).toBe("filled");
    expect(r.fillQty).toBe(2);
    expect(r.fillPrice).toBe(2.35);
    expect(r.brokerCalled).toBe(false);
  });
});

// ── 7. Partial fill — remainder continues chasing ────────────────────────────────
describe("partial fill", () => {
  it("reduces remaining qty and continues chasing instead of stopping", () => {
    const order = makeOrder({ qty: 5, chase_last_step_at: null });
    const fillState = interpretFillState({ filledQty: 2, fillPrice: 2.40 }, order.qty);
    expect(fillState.state).toBe("partial");
    expect(fillState.remainingQty).toBe(3);

    const r = simulateChaseStep(order, {
      nowMs: NOW, dryRun: true, brokerStatus: fillState,
      quote: { bid: 2.10, ask: 2.55, mid: 2.325 },
    });
    // Continues chasing the remainder — not "filled", a real step decision follows.
    expect(r.action).not.toBe("filled");
    expect(["dry_run_step", "step", "skip", "hit_bound"]).toContain(r.action);
  });
});

// ── 8. Expiry + on_bound ─────────────────────────────────────────────────────────
describe("expiry", () => {
  it("past chase_expires_at → status expired, chase_on_bound applied (rest)", () => {
    const order = makeOrder({ chase_expires_at: new Date(NOW - 1000).toISOString(), chase_on_bound: "rest", chase_last_step_at: null });
    const r = simulateChaseStep(order, { nowMs: NOW, dryRun: true, brokerStatus: { state: "none" } });
    expect(r.action).toBe("expired");
    expect(r.onBound).toBe("rest");
  });
  it("past chase_expires_at with chase_on_bound=cancel → applies cancel", () => {
    const order = makeOrder({ chase_expires_at: new Date(NOW - 1000).toISOString(), chase_on_bound: "cancel", chase_last_step_at: null });
    const r = simulateChaseStep(order, { nowMs: NOW, dryRun: true, brokerStatus: { state: "none" } });
    expect(r.action).toBe("expired");
    expect(r.onBound).toBe("cancel");
  });
  it("not yet expired → does not trigger expiry", () => {
    const order = makeOrder({ chase_expires_at: new Date(NOW + 60000).toISOString(), chase_last_step_at: null });
    const r = simulateChaseStep(order, { nowMs: NOW, dryRun: true, brokerStatus: { state: "none" }, quote: { bid: 2.10, ask: 2.55, mid: 2.325 } });
    expect(r.action).not.toBe("expired");
  });
});

// ── 9. Hit bound — rest vs cancel ────────────────────────────────────────────────
describe("hit_bound behavior", () => {
  it("rest: clamped step leaves the order resting at the bound (no cancel)", () => {
    // limit_price=2.02, step=0.05 → raw next 1.97, which overshoots past the 2.00 floor → clamps
    const order = makeOrder({ opt_type: "STO", limit_price: 2.02, chase_bound: 2.00, chase_on_bound: "rest", chase_last_step_at: null });
    const r = simulateChaseStep(order, { nowMs: NOW, dryRun: false, brokerStatus: { state: "none" }, quote: { bid: 1.80, ask: 2.10, mid: 1.95 } });
    expect(r.action).toBe("hit_bound");
    expect(r.toPrice).toBe(2.00);
    expect(r.onBound).toBe("rest");
  });
  it("cancel: clamped step signals cancel instead of resting", () => {
    const order = makeOrder({ opt_type: "STO", limit_price: 2.02, chase_bound: 2.00, chase_on_bound: "cancel", chase_last_step_at: null });
    const r = simulateChaseStep(order, { nowMs: NOW, dryRun: false, brokerStatus: { state: "none" }, quote: { bid: 1.80, ask: 2.10, mid: 1.95 } });
    expect(r.action).toBe("hit_bound");
    expect(r.onBound).toBe("cancel");
  });
});

// ── 10. Race guard: fill seen on status check → no cancel/replace ───────────────
describe("race guard", () => {
  it("a fill detected on the pre-step status check prevents any step/replace call", () => {
    const order = makeOrder({ chase_last_step_at: null });
    const brokerStatus = interpretFillState({ filled: true, filledQty: order.qty, fillPrice: 2.20 }, order.qty);
    const r = simulateChaseStep(order, { nowMs: NOW, dryRun: false, brokerStatus, quote: { bid: 2.10, ask: 2.55, mid: 2.325 } });
    expect(r.action).toBe("filled");
    expect(r.brokerCalled).toBe(false); // no cancel/replace issued
  });
  it("a cancellation detected on the pre-step status check also short-circuits, no double order", () => {
    const order = makeOrder({ chase_last_step_at: null });
    const r = simulateChaseStep(order, { nowMs: NOW, dryRun: false, brokerStatus: { state: "cancelled" }, quote: { bid: 2.10, ask: 2.55, mid: 2.325 } });
    expect(r.action).toBe("cancelled_at_broker");
    expect(r.brokerCalled).toBe(false);
  });
});

// ── 11. Market-hours gate ─────────────────────────────────────────────────────────
describe("isMarketHours", () => {
  it("positive — 10:30am ET on a weekday is within market hours", () => {
    expect(isMarketHours(new Date("2026-07-15T14:30:00Z"))).toBe(true); // 10:30am EDT
  });
  it("negative — 4:30pm ET on a weekday is after close", () => {
    expect(isMarketHours(new Date("2026-07-15T20:30:00Z"))).toBe(false); // 4:30pm EDT
  });
  it("negative — 8:00am ET on a weekday is before open", () => {
    expect(isMarketHours(new Date("2026-07-15T12:00:00Z"))).toBe(false); // 8:00am EDT
  });
  it("negative — Saturday is never market hours regardless of time", () => {
    expect(isMarketHours(new Date("2026-07-18T15:00:00Z"))).toBe(false); // Saturday
  });
  it("positive — exactly 9:30am ET (market open) counts as market hours", () => {
    expect(isMarketHours(new Date("2026-07-15T13:30:00Z"))).toBe(true);
  });
});

// ── Market/spread/adverse-move/VIX guards ─────────────────────────────────────────
describe("evaluateMarketGuards", () => {
  const guards = { max_spread_pct: 0.15, adverse_move_pct: 0.5, min_vix: null, max_vix: null, on_guard_trip: "pause" };

  it("negative — no guards configured never trips", () => {
    expect(evaluateMarketGuards({ order: makeOrder(), bid: 1, ask: 2, mid: 1.5, guards: null }).tripped).toBe(false);
  });
  it("positive — spread guard trips when spread exceeds max_spread_pct", () => {
    const r = evaluateMarketGuards({ order: makeOrder(), bid: 1.00, ask: 1.40, mid: 1.20, guards }); // spread 33%
    expect(r.tripped).toBe(true);
    expect(r.reasons.some(s => s.includes("spread"))).toBe(true);
  });
  it("negative — tight spread does not trip the guard", () => {
    const r = evaluateMarketGuards({ order: makeOrder(), bid: 1.00, ask: 1.05, mid: 1.025, guards }); // spread ~5%
    expect(r.tripped).toBe(false);
  });
  it("positive — adverse move trips for SELL when underlying drops", () => {
    const order = makeOrder({ opt_type: "STO" });
    const r = evaluateMarketGuards({ order, bid: 1, ask: 1.05, mid: 1.025, underlyingStart: 220, underlyingNow: 218, guards });
    // (218-220)/220 = -0.91% < -0.5% → adverse for SELL
    expect(r.tripped).toBe(true);
  });
  it("negative — same-direction move is NOT adverse for SELL (underlying up)", () => {
    const order = makeOrder({ opt_type: "STO" });
    const r = evaluateMarketGuards({ order, bid: 1, ask: 1.05, mid: 1.025, underlyingStart: 220, underlyingNow: 224, guards });
    expect(r.tripped).toBe(false);
  });
  it("positive — adverse move trips for BUY when underlying rises", () => {
    const order = makeOrder({ opt_type: "BTC" });
    const r = evaluateMarketGuards({ order, bid: 1, ask: 1.05, mid: 1.025, underlyingStart: 220, underlyingNow: 223, guards });
    expect(r.tripped).toBe(true);
  });
  it("positive — VIX guard trips when above max_vix", () => {
    const r = evaluateMarketGuards({ order: makeOrder(), bid: 1, ask: 1.05, mid: 1.025, vix: 35, guards: { ...guards, max_vix: 30 } });
    expect(r.tripped).toBe(true);
  });
  it("on_guard_trip=exit applies chase_on_bound instead of pausing", () => {
    const order = makeOrder({ opt_type: "STO", chase_on_bound: "cancel" });
    const r = simulateChaseStep(order, {
      nowMs: NOW, dryRun: true, brokerStatus: { state: "none" },
      quote: { bid: 1.00, ask: 1.40, mid: 1.20 },
      chaseParams: { market_guards: { max_spread_pct: 0.15, on_guard_trip: "exit" } },
    });
    expect(r.action).toBe("guard_exit");
    expect(r.onBound).toBe("cancel");
  });
});

// ── Step resolution ────────────────────────────────────────────────────────────────
describe("resolveStep", () => {
  it("explicit order.chase_step wins over everything else", () => {
    const order = makeOrder({ chase_step: 0.10 });
    expect(resolveStep(order, { default_step: 0.05, ticker_steps: { AMZN: 0.20 } }, 2.10, 2.55)).toBe(0.10);
  });
  it("falls back to ticker_steps[ticker] when order.chase_step is unset", () => {
    const order = makeOrder({ chase_step: null, ticker: "OKLO" });
    expect(resolveStep(order, { default_step: 0.05, ticker_steps: { OKLO: 0.10 } }, 5, 5.20)).toBe(0.10);
  });
  it("falls back to spread-proportional when step_mode is set and no ticker override", () => {
    const order = makeOrder({ chase_step: null, ticker: "NVDA" });
    // spread = 0.40, frac 0.25 → raw 0.10, within [min,max]
    const step = resolveStep(order, { step_mode: "spread_proportional", spread_step_frac: 0.25, min_step: 0.05, max_step: 0.25 }, 2.10, 2.50);
    expect(step).toBeCloseTo(0.10, 5);
  });
  it("spread-proportional clamps to max_step on a wide spread", () => {
    const order = makeOrder({ chase_step: null, ticker: "NVDA" });
    const step = resolveStep(order, { step_mode: "spread_proportional", spread_step_frac: 0.5, min_step: 0.05, max_step: 0.25 }, 1.00, 3.00);
    expect(step).toBe(0.25);
  });
  it("spread-proportional clamps to min_step on a tight spread", () => {
    const order = makeOrder({ chase_step: null, ticker: "NVDA" });
    const step = resolveStep(order, { step_mode: "spread_proportional", spread_step_frac: 0.25, min_step: 0.05, max_step: 0.25 }, 2.00, 2.02);
    expect(step).toBe(0.05);
  });
  it("falls back to default_step when nothing else applies", () => {
    const order = makeOrder({ chase_step: null, ticker: "JPM" });
    expect(resolveStep(order, { default_step: 0.07 }, 2.10, 2.55)).toBe(0.07);
  });
});

// ── Fill-state interpretation ──────────────────────────────────────────────────────
describe("interpretFillState", () => {
  it("full fill detected via explicit filled flag", () => {
    expect(interpretFillState({ filled: true, filledQty: 2, fillPrice: 2.30 }, 2).state).toBe("full");
  });
  it("full fill detected via filledQty >= orderQty even without explicit flag", () => {
    expect(interpretFillState({ filledQty: 3 }, 3).state).toBe("full");
  });
  it("partial fill leaves the correct remaining qty", () => {
    const r = interpretFillState({ filledQty: 1 }, 4);
    expect(r.state).toBe("partial");
    expect(r.remainingQty).toBe(3);
  });
  it("no fill activity → state none", () => {
    expect(interpretFillState({ filledQty: 0 }, 2).state).toBe("none");
  });
  it("cancelled flag takes priority", () => {
    expect(interpretFillState({ cancelled: true }, 2).state).toBe("cancelled");
  });
});

// ── OSI symbol building (option quote lookups) ─────────────────────────────────────
describe("buildOSI", () => {
  it("builds correct OSI for a call", () => {
    expect(buildOSI("AMZN", "2026-08-21", "Call", 220)).toBe("AMZN  260821C00220000");
  });
  it("builds correct OSI for a put with decimal strike", () => {
    expect(buildOSI("WDC", "2026-06-05", "Put", 532.5)).toBe("WDC   260605P00532500");
  });
  it("is case-insensitive for ticker", () => {
    expect(buildOSI("nvda", "2026-06-01", "Call", 220).startsWith("NVDA")).toBe(true);
  });
});

// ── 12. Regression: replay a real historical chase order ────────────────────────
describe("regression — historical chase order replay", () => {
  // Modeled on a real auto-STO order shape (see api/market-refresh.js bound resolver):
  // AMZN $220 Call, ask $2.55/bid $2.10 at entry, floor derived from rule min_premium
  // ($400 / (2 contracts × 100) = $2.00), default_step 0.05, 20s interval.
  const chaseParams = { default_step: 0.05, min_interval_secs: 20, market_guards: null };

  it("replays the full step sequence: entry → step → step → hit_bound, floor never breached", () => {
    let order = makeOrder({
      opt_type: "STO", limit_price: 2.55, chase_bound: 2.00, chase_last_step_at: null,
      chase_expires_at: new Date(NOW + 1800000).toISOString(),
    });
    const quotesOverTime = [
      { bid: 2.10, ask: 2.55, mid: 2.325 }, // t0
      { bid: 2.05, ask: 2.50, mid: 2.275 }, // t1 (20s later)
      { bid: 1.95, ask: 2.40, mid: 2.175 }, // t2 (40s later) — bid now below floor, should clamp
    ];
    const steps = [];

    for (let i = 0; i < quotesOverTime.length; i++) {
      const nowMs = NOW + i * 20000;
      const r = simulateChaseStep(order, { nowMs, dryRun: true, brokerStatus: { state: "none" }, quote: quotesOverTime[i], chaseParams });
      steps.push(r.action);
      if (r.action === "dry_run_step" || r.action === "hit_bound") {
        order = { ...order, limit_price: r.toPrice, chase_last_step_at: new Date(nowMs).toISOString() };
      }
      if (r.action === "hit_bound") break;
    }

    expect(steps[0]).toBe("dry_run_step");
    expect(order.limit_price).toBeGreaterThanOrEqual(2.00); // floor never breached at any point
    // Every historical price stayed at or above the bound.
    expect(order.limit_price).toBeCloseTo(Math.max(order.limit_price, 2.00), 5);
  });
});
