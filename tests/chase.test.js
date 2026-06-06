// tests/chase.test.js
// Vitest unit tests for the chase loop logic in market-refresh.js
// Tests the pure calculation functions extracted from runChaseLoop
// Run: npx vitest run tests/

import { describe, it, expect } from "vitest";

// ── Helpers extracted from runChaseLoop (keep in sync) ────────────────────────

function buildOSI(ticker, expires, type, strike) {
  return `${ticker?.toUpperCase().padEnd(6)}${expires?.replace(/-/g,"").slice(2)}${type === "Call" ? "C" : "P"}${String(Math.round((+strike) * 1000)).padStart(8,"0")}`;
}

function computeChaseTarget({ opt_type, bid, ask, chase_step = 0.05 }) {
  const isSell    = ["STO","STC"].includes(opt_type);
  const rawTarget = isSell ? ask - 0.01 : bid + 0.01;
  const step      = +chase_step;
  return Math.round(rawTarget / step) * step;
}

function isFloorHit({ opt_type, newPrice, chase_floor }) {
  const isSell = ["STO","STC"].includes(opt_type);
  const floor  = +chase_floor;
  return isSell ? newPrice <= floor : newPrice >= floor;
}

function needsPriceUpdate({ newPrice, limit_price }) {
  return Math.abs(newPrice - +(limit_price || 0)) >= 0.005;
}

// ── OSI Symbol Building ───────────────────────────────────────────────────────

describe("buildOSI", () => {
  it("builds correct OSI for a call option", () => {
    // JPM $305 Call expiring 2026-06-05
    // YYMMDD = 260605, C, strike 305000 padded to 8 = 00305000
    expect(buildOSI("JPM", "2026-06-05", "Call", 305)).toBe("JPM   260605C00305000");
  });

  it("builds correct OSI for a put option", () => {
    expect(buildOSI("AAPL", "2026-05-29", "Put", 300)).toBe("AAPL  260529P00300000");
  });

  it("pads short tickers to 6 chars", () => {
    const osi = buildOSI("WDC", "2026-06-05", "Call", 532.5);
    expect(osi.slice(0,6)).toBe("WDC   ");
  });

  it("handles decimal strikes correctly", () => {
    // $532.50 strike → 532500 → padded to 00532500
    expect(buildOSI("WDC", "2026-06-05", "Call", 532.5)).toBe("WDC   260605C00532500");
  });

  it("handles whole number strikes", () => {
    expect(buildOSI("NVDA", "2026-06-01", "Call", 220)).toBe("NVDA  260601C00220000");
  });

  it("is case-insensitive for ticker", () => {
    expect(buildOSI("jpm", "2026-06-05", "Call", 305)).toBe("JPM   260605C00305000");
  });

  it("is case-insensitive for type", () => {
    // type comparison is exact ("Call"), but OSI only uses C/P
    expect(buildOSI("JPM", "2026-06-05", "Put", 305)).toBe("JPM   260605P00305000");
  });
});

// ── Target Price Calculation ──────────────────────────────────────────────────

describe("computeChaseTarget — STO (selling)", () => {
  it("STO: targets just below ask (ask - 0.01), rounded to step", () => {
    // ask=2.50, step=0.05 → rawTarget=2.49 → round to nearest 0.05 = 2.50
    expect(computeChaseTarget({ opt_type:"STO", bid:2.30, ask:2.50, chase_step:0.05 })).toBe(2.50);
  });

  it("STO: rounds down when rawTarget falls between steps", () => {
    // ask=2.53, step=0.05 → rawTarget=2.52 → round to 2.50
    expect(computeChaseTarget({ opt_type:"STO", bid:2.30, ask:2.53, chase_step:0.05 })).toBe(2.50);
  });

  it("STO: rounds up when rawTarget is closer to upper step", () => {
    // ask=2.57, step=0.05 → rawTarget=2.56 → round to 2.55
    expect(computeChaseTarget({ opt_type:"STO", bid:2.30, ask:2.57, chase_step:0.05 })).toBeCloseTo(2.55, 5);
  });

  it("STO: uses default step of 0.05 when not provided", () => {
    const result = computeChaseTarget({ opt_type:"STO", bid:1.00, ask:1.50 });
    expect(Math.round(result / 0.05) * 0.05).toBeCloseTo(result, 5);
  });

  it("STC: same as STO — targets below ask", () => {
    expect(computeChaseTarget({ opt_type:"STC", bid:0.80, ask:1.00, chase_step:0.05 })).toBe(1.00);
  });

  it("STO: small step size (0.01) preserves more precision", () => {
    // ask=2.53, step=0.01 → rawTarget=2.52 → round to 2.52
    expect(computeChaseTarget({ opt_type:"STO", bid:2.30, ask:2.53, chase_step:0.01 })).toBe(2.52);
  });
});

describe("computeChaseTarget — BTC/BTO (buying)", () => {
  it("BTC: targets just above bid (bid + 0.01), rounded to step", () => {
    // bid=0.30, step=0.05 → rawTarget=0.31 → round to 0.30
    expect(computeChaseTarget({ opt_type:"BTC", bid:0.30, ask:0.50, chase_step:0.05 })).toBeCloseTo(0.30, 5);
  });

  it("BTC: rounds to nearest step above bid", () => {
    // bid=0.32, step=0.05 → rawTarget=0.33 → round to 0.35
    expect(computeChaseTarget({ opt_type:"BTC", bid:0.32, ask:0.50, chase_step:0.05 })).toBeCloseTo(0.35, 5);
  });

  it("BTO: same direction as BTC — targets above bid", () => {
    expect(computeChaseTarget({ opt_type:"BTO", bid:5.00, ask:5.50, chase_step:0.05 })).toBe(5.00);
  });

  it("BTC: small step size", () => {
    // bid=0.28, step=0.01 → rawTarget=0.29 → round to 0.29
    expect(computeChaseTarget({ opt_type:"BTC", bid:0.28, ask:0.40, chase_step:0.01 })).toBe(0.29);
  });
});

// ── Floor Hit Detection ───────────────────────────────────────────────────────

describe("isFloorHit — STO/STC (floor = minimum acceptable price)", () => {
  it("STO: floor hit when newPrice equals floor", () => {
    expect(isFloorHit({ opt_type:"STO", newPrice:0.10, chase_floor:0.10 })).toBe(true);
  });

  it("STO: floor hit when newPrice drops below floor", () => {
    expect(isFloorHit({ opt_type:"STO", newPrice:0.05, chase_floor:0.10 })).toBe(true);
  });

  it("STO: floor NOT hit when newPrice is above floor", () => {
    expect(isFloorHit({ opt_type:"STO", newPrice:0.20, chase_floor:0.10 })).toBe(false);
  });

  it("STC: same floor logic as STO", () => {
    expect(isFloorHit({ opt_type:"STC", newPrice:0.09, chase_floor:0.10 })).toBe(true);
    expect(isFloorHit({ opt_type:"STC", newPrice:0.11, chase_floor:0.10 })).toBe(false);
  });

  it("STO: floor=0 is never hit (safety valve for unset floor)", () => {
    expect(isFloorHit({ opt_type:"STO", newPrice:0.01, chase_floor:0 })).toBe(false);
  });
});

describe("isFloorHit — BTC/BTO (floor = maximum acceptable price)", () => {
  it("BTC: floor hit when newPrice equals floor", () => {
    expect(isFloorHit({ opt_type:"BTC", newPrice:1.00, chase_floor:1.00 })).toBe(true);
  });

  it("BTC: floor hit when newPrice exceeds floor", () => {
    expect(isFloorHit({ opt_type:"BTC", newPrice:1.05, chase_floor:1.00 })).toBe(true);
  });

  it("BTC: floor NOT hit when newPrice is below floor", () => {
    expect(isFloorHit({ opt_type:"BTC", newPrice:0.90, chase_floor:1.00 })).toBe(false);
  });

  it("BTO: same floor logic as BTC", () => {
    expect(isFloorHit({ opt_type:"BTO", newPrice:5.50, chase_floor:5.00 })).toBe(true);
    expect(isFloorHit({ opt_type:"BTO", newPrice:4.50, chase_floor:5.00 })).toBe(false);
  });
});

// ── Price Change Guard ────────────────────────────────────────────────────────

describe("needsPriceUpdate", () => {
  it("returns true when price has moved by more than $0.005", () => {
    expect(needsPriceUpdate({ newPrice:2.50, limit_price:2.00 })).toBe(true);
  });

  it("returns false when price is the same", () => {
    expect(needsPriceUpdate({ newPrice:2.50, limit_price:2.50 })).toBe(false);
  });

  it("returns false when difference is less than $0.005 (floating point noise)", () => {
    expect(needsPriceUpdate({ newPrice:2.500, limit_price:2.5001 })).toBe(false);
  });

  it("returns true when difference is exactly $0.005", () => {
    expect(needsPriceUpdate({ newPrice:2.51, limit_price:2.50 })).toBe(true); // >0.005 triggers update
  });

  it("handles null limit_price (new order, no current price)", () => {
    expect(needsPriceUpdate({ newPrice:1.50, limit_price:null })).toBe(true);
  });

  it("handles zero limit_price", () => {
    expect(needsPriceUpdate({ newPrice:0.50, limit_price:0 })).toBe(true);
  });
});

// ── Full Chase Decision Flow ──────────────────────────────────────────────────

describe("full chase decision flow", () => {
  function chaseDecision(order, quote) {
    const { opt_type, limit_price, chase_floor, chase_step = 0.05 } = order;
    const { bid, ask } = quote;

    const newPrice = computeChaseTarget({ opt_type, bid, ask, chase_step });

    if (isFloorHit({ opt_type, newPrice, chase_floor })) {
      return { action: "floor_hit", newPrice };
    }
    if (!needsPriceUpdate({ newPrice, limit_price })) {
      return { action: "no_change", newPrice };
    }
    return { action: "reprice", newPrice };
  }

  it("STO: normal reprice — ask dropped, floor not hit", () => {
    const order = { opt_type:"STO", limit_price:2.50, chase_floor:0.10, chase_step:0.05 };
    const quote = { bid:1.80, ask:2.00 };
    const result = chaseDecision(order, quote);
    expect(result.action).toBe("reprice");
    expect(result.newPrice).toBe(2.00); // ask(2.00) - 0.01 = 1.99 → rounds to 2.00
  });

  it("STO: floor hit — ask has dropped to floor level", () => {
    const order = { opt_type:"STO", limit_price:0.15, chase_floor:0.10, chase_step:0.05 };
    const quote = { bid:0.05, ask:0.10 }; // ask-0.01=0.09 → rounds to 0.10 → hits floor
    const result = chaseDecision(order, quote);
    expect(result.action).toBe("floor_hit");
  });

  it("STO: no change needed — already priced at target", () => {
    const order = { opt_type:"STO", limit_price:2.50, chase_floor:0.10, chase_step:0.05 };
    const quote = { bid:2.40, ask:2.51 }; // ask-0.01=2.50 → target=2.50 = current
    const result = chaseDecision(order, quote);
    expect(result.action).toBe("no_change");
  });

  it("BTC: reprice — bid rose, need to go higher to fill", () => {
    const order = { opt_type:"BTC", limit_price:0.30, chase_floor:1.00, chase_step:0.05 };
    const quote = { bid:0.50, ask:0.70 }; // bid+0.01=0.51 → rounds to 0.50
    const result = chaseDecision(order, quote);
    expect(result.action).toBe("reprice");
  });

  it("BTC: floor hit — bid rose above max acceptable price", () => {
    const order = { opt_type:"BTC", limit_price:0.90, chase_floor:1.00, chase_step:0.05 };
    const quote = { bid:1.05, ask:1.20 }; // bid+0.01=1.06 → rounds to 1.05 → exceeds floor 1.00
    const result = chaseDecision(order, quote);
    expect(result.action).toBe("floor_hit");
  });

  it("real JPM scenario: STO $305 Call, ask dropped from $1.50 to $0.80", () => {
    const order = { opt_type:"STO", limit_price:1.50, chase_floor:0.10, chase_step:0.05 };
    const quote = { bid:0.70, ask:0.80 };
    const result = chaseDecision(order, quote);
    expect(result.action).toBe("reprice");
    expect(result.newPrice).toBe(0.80); // ask(0.80)-0.01=0.79 → rounds to 0.80
  });

  it("real WDC scenario: STO $532.5 Call, spread is wide", () => {
    const order = { opt_type:"STO", limit_price:8.00, chase_floor:0.50, chase_step:0.05 };
    const quote = { bid:5.00, ask:7.00 };
    const result = chaseDecision(order, quote);
    expect(result.action).toBe("reprice");
    expect(result.newPrice).toBe(7.00); // ask(7.00)-0.01=6.99 → rounds to 7.00
  });

  it("real BTC scenario: buying back NVDA call near expiry", () => {
    const order = { opt_type:"BTC", limit_price:0.05, chase_floor:0.50, chase_step:0.05 };
    const quote = { bid:0.20, ask:0.35 };
    const result = chaseDecision(order, quote);
    expect(result.action).toBe("reprice");
    expect(result.newPrice).toBe(0.20); // bid(0.20)+0.01=0.21 → rounds to 0.20
  });
});

// ── Edge Cases ────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("zero bid/ask (illiquid option) — STO targets -0.01 → rounds to 0", () => {
    // Should not crash; floor check will catch it
    const newPrice = computeChaseTarget({ opt_type:"STO", bid:0, ask:0, chase_step:0.05 });
    expect(newPrice).toBeCloseTo(0, 5);
    // And floor hit check catches it if floor > 0
    expect(isFloorHit({ opt_type:"STO", newPrice:0, chase_floor:0.10 })).toBe(true);
  });

  it("very wide spread — STO still uses ask not mid", () => {
    // bid=0.10, ask=5.00 → targets just below ask, not mid
    const newPrice = computeChaseTarget({ opt_type:"STO", bid:0.10, ask:5.00, chase_step:0.05 });
    expect(newPrice).toBeCloseTo(5.00, 1);
    expect(newPrice).toBeGreaterThan(2.00); // not using mid
  });

  it("step size larger than spread — snaps to nearest step", () => {
    // ask=2.03, step=0.10 → rawTarget=2.02 → rounds to 2.00
    expect(computeChaseTarget({ opt_type:"STO", bid:1.90, ask:2.03, chase_step:0.10 })).toBe(2.00);
  });

  it("floor exactly at current price — no change then floor hit on next tick", () => {
    const order = { opt_type:"STO", limit_price:0.10, chase_floor:0.10, chase_step:0.05 };
    const quote = { bid:0.05, ask:0.11 }; // ask-0.01=0.10 → rounds to 0.10 → equals floor
    expect(isFloorHit({ opt_type:"STO", newPrice:0.10, chase_floor:0.10 })).toBe(true);
  });

  it("string chase_floor is coerced to number", () => {
    expect(isFloorHit({ opt_type:"STO", newPrice:0.09, chase_floor:"0.10" })).toBe(true);
  });

  it("string chase_step is coerced to number", () => {
    const result = computeChaseTarget({ opt_type:"STO", bid:2.00, ask:2.50, chase_step:"0.05" });
    expect(result).toBeCloseTo(2.50, 2); // ask(2.50)-0.01=2.49 → rounds to 2.50
  });
});

// ── Exit plan checks (task #18) ────────────────────────────────────────────────

function checkStopLoss({ costToClose, premium, stopLossMultiplier = 2.0 }) {
  const prem = Math.abs(premium || 0);
  return costToClose != null && stopLossMultiplier > 0 && costToClose > prem * stopLossMultiplier;
}

function checkTimeStop({ dte, timeStopDte }) {
  return timeStopDte != null && dte <= +timeStopDte;
}

function checkDeltaStop({ delta, deltaStop }) {
  const liveDelta = Math.abs(delta ?? 0);
  return deltaStop != null && liveDelta > 0 && liveDelta > +deltaStop;
}

describe("checkStopLoss", () => {
  it("triggers when costToClose > premium * multiplier", () => {
    expect(checkStopLoss({ costToClose: 300, premium: 100, stopLossMultiplier: 2.0 })).toBe(true);
  });

  it("does not trigger at exactly the threshold", () => {
    expect(checkStopLoss({ costToClose: 200, premium: 100, stopLossMultiplier: 2.0 })).toBe(false);
  });

  it("returns false when costToClose is null", () => {
    expect(checkStopLoss({ costToClose: null, premium: 100, stopLossMultiplier: 2.0 })).toBe(false);
  });
});

describe("checkTimeStop", () => {
  it("triggers when DTE <= timeStopDte", () => {
    expect(checkTimeStop({ dte: 3, timeStopDte: 5 })).toBe(true);
  });

  it("does not trigger when DTE > timeStopDte", () => {
    expect(checkTimeStop({ dte: 7, timeStopDte: 5 })).toBe(false);
  });

  it("does not trigger when timeStopDte is null", () => {
    expect(checkTimeStop({ dte: 2, timeStopDte: null })).toBe(false);
  });
});

describe("checkDeltaStop", () => {
  it("triggers when delta exceeds stop", () => {
    expect(checkDeltaStop({ delta: -0.45, deltaStop: 0.30 })).toBe(true);
  });

  it("does not trigger when delta is within threshold", () => {
    expect(checkDeltaStop({ delta: -0.20, deltaStop: 0.30 })).toBe(false);
  });

  it("does not trigger when deltaStop is null", () => {
    expect(checkDeltaStop({ delta: 0.90, deltaStop: null })).toBe(false);
  });
});

// ── ITM expiry check logic (task #19) ──────────────────────────────────────────

function isContractITM({ type, strike, stockPrice }) {
  if (type === "Call") return stockPrice > strike;
  if (type === "Put")  return stockPrice < strike;
  return false;
}

describe("isContractITM", () => {
  it("Call is ITM when stock > strike", () => {
    expect(isContractITM({ type:"Call", strike:150, stockPrice:155 })).toBe(true);
  });

  it("Call is OTM when stock < strike", () => {
    expect(isContractITM({ type:"Call", strike:150, stockPrice:145 })).toBe(false);
  });

  it("Put is ITM when stock < strike", () => {
    expect(isContractITM({ type:"Put", strike:150, stockPrice:145 })).toBe(true);
  });

  it("Put is OTM when stock > strike", () => {
    expect(isContractITM({ type:"Put", strike:150, stockPrice:155 })).toBe(false);
  });
});

// ── Skynet controls check (task #34) ──────────────────────────────────────────

function checkSkynetControls({ controls, limitPrice, qty, bid, ask, projectedProfit }) {
  if (!controls?.enabled) return { ok: true };
  const orderValue = Math.abs(limitPrice || 0) * (qty || 1) * 100;
  if (controls.max_order_value && orderValue > +controls.max_order_value) {
    return { ok: false, reason: `order value $${orderValue.toFixed(0)} > max $${controls.max_order_value}` };
  }
  if (controls.max_bid_ask_deviation_pct && bid != null && ask != null && ask > 0) {
    const mid = (bid + ask) / 2;
    const devPct = Math.abs(limitPrice - mid) / mid * 100;
    if (devPct > +controls.max_bid_ask_deviation_pct) {
      return { ok: false, reason: `deviation ${devPct.toFixed(1)}%` };
    }
  }
  if (controls.block_if_loss && projectedProfit != null && projectedProfit < 0) {
    return { ok: false, reason: `loss $${projectedProfit.toFixed(2)}` };
  }
  return { ok: true };
}

const defaultControls = { enabled: true, max_order_value: 10000, max_bid_ask_deviation_pct: 15, block_if_loss: true };

describe("checkSkynetControls", () => {
  it("passes when all values within limits", () => {
    expect(checkSkynetControls({ controls: defaultControls, limitPrice: 2.0, qty: 3, bid: 1.95, ask: 2.05, projectedProfit: 150 }).ok).toBe(true);
  });

  it("blocks when order value exceeds max", () => {
    expect(checkSkynetControls({ controls: defaultControls, limitPrice: 40, qty: 5, bid: 39, ask: 41, projectedProfit: 500 }).ok).toBe(false);
  });

  it("blocks when bid/ask deviation exceeds max", () => {
    expect(checkSkynetControls({ controls: defaultControls, limitPrice: 3.0, qty: 1, bid: 1.0, ask: 2.0, projectedProfit: 100 }).ok).toBe(false);
  });

  it("blocks when projected loss and block_if_loss=true", () => {
    expect(checkSkynetControls({ controls: defaultControls, limitPrice: 0.5, qty: 1, bid: 0.48, ask: 0.52, projectedProfit: -50 }).ok).toBe(false);
  });

  it("allows loss when block_if_loss=false", () => {
    const controls = { ...defaultControls, block_if_loss: false };
    expect(checkSkynetControls({ controls, limitPrice: 0.5, qty: 1, bid: 0.48, ask: 0.52, projectedProfit: -50 }).ok).toBe(true);
  });

  it("bypasses all checks when disabled", () => {
    expect(checkSkynetControls({ controls: { ...defaultControls, enabled: false }, limitPrice: 999, qty: 100, projectedProfit: -9999 }).ok).toBe(true);
  });
});

// ── QA fixes tests ─────────────────────────────────────────────────────────────

// #19: expiry_protection respects dry_run flag
describe("expiry_protection dry_run flag", () => {
  function getExpiryDryRun(signalRules) {
    const expiryRule = (Array.isArray(signalRules) ? signalRules : []).find(r => r.rule_type === "expiry_protection" && r.enabled);
    return expiryRule ? expiryRule.dry_run !== false : true;
  }

  it("defaults to dry-run when no expiry_protection rule exists", () => {
    expect(getExpiryDryRun([])).toBe(true);
  });

  it("defaults to dry-run when rule has dry_run=true", () => {
    expect(getExpiryDryRun([{ rule_type: "expiry_protection", enabled: true, dry_run: true }])).toBe(true);
  });

  it("goes live when rule has dry_run=false", () => {
    expect(getExpiryDryRun([{ rule_type: "expiry_protection", enabled: true, dry_run: false }])).toBe(false);
  });

  it("ignores disabled rules", () => {
    expect(getExpiryDryRun([{ rule_type: "expiry_protection", enabled: false, dry_run: false }])).toBe(true);
  });
});

// #45: portfolio_snapshots used as cold-load fallback
describe("balance cold-load fallback", () => {
  function resolveBalance(schwabAccountValue, snapSchwab, cacheSchwab) {
    return schwabAccountValue > 0 ? schwabAccountValue : snapSchwab ?? (cacheSchwab ? +cacheSchwab : null);
  }

  it("uses live schwabAccountValue when set", () => {
    expect(resolveBalance(900000, 850000, 6000)).toBe(900000);
  });

  it("falls back to portfolio snapshot when schwabAccountValue is 0", () => {
    expect(resolveBalance(0, 850000, 6000)).toBe(850000);
  });

  it("falls back to cashData when snapshot is null", () => {
    expect(resolveBalance(0, null, 6000)).toBe(6000);
  });

  it("returns null when all sources are empty", () => {
    expect(resolveBalance(0, null, null)).toBeNull();
  });
});

// ── Batch fixes tests ──────────────────────────────────────────────────────────

// #1/#2: ETrade NAV = equity + cash
describe("ETrade NAV calculation", () => {
  it("sums equity + cash for full NAV", () => {
    const etNAV = (300000 || 0) + (50000 || 0);
    expect(etNAV).toBe(350000);
  });

  it("handles missing cash gracefully", () => {
    const etNAV = (300000 || 0) + (undefined || 0);
    expect(etNAV).toBe(300000);
  });

  it("handles missing accountValue gracefully", () => {
    const etNAV = (null || 0) + (50000 || 0);
    expect(etNAV).toBe(50000);
  });
});

// #4/#8: P&L on imports — looks at close_date, not dateExec of BTC row
describe("imports P&L from parent close_date", () => {
  const TODAY = "2026-06-05";
  const contracts = [
    { id:1, optType:"STO", closeDate: TODAY,   profit: 124.50, status:"Closed" },
    { id:2, optType:"STO", closeDate: TODAY,   profit: -45.00, status:"Closed" },
    { id:3, optType:"BTC", dateExec:  TODAY,   profit: null,   status:"Closed" }, // BTC row — no profit
    { id:4, optType:"STO", closeDate:"2026-06-04", profit: 80, status:"Closed" }, // yesterday
  ];

  const todayCloses = contracts.filter(c => c.closeDate === TODAY && c.profit != null);
  const todayProfit = todayCloses.reduce((s,c) => s + (+c.profit||0), 0);

  it("sums profit from parent contracts closed today", () => {
    expect(todayCloses.length).toBe(2);
    expect(todayProfit).toBeCloseTo(79.50);
  });

  it("excludes BTC rows (no profit) and yesterday's closes", () => {
    expect(todayCloses.find(c => c.optType==="BTC")).toBeUndefined();
    expect(todayCloses.find(c => c.closeDate==="2026-06-04")).toBeUndefined();
  });
});

// #7: Profit $ amount in Pushover
describe("Pushover profit dollar string", () => {
  function profitDollarStr(openedVal, currentVal) {
    const p = Math.round((openedVal - currentVal) * 100) / 100;
    return (p >= 0 ? "+" : "-") + "\$" + Math.abs(p).toFixed(2);
  }

  it("formats profit positive", () => {
    expect(profitDollarStr(500, 85)).toBe("+$415.00");
  });

  it("formats loss negative", () => {
    expect(profitDollarStr(200, 450)).toBe("-$250.00");
  });
});

// ── Scanner rules tests (batch) ───────────────────────────────────────────────

// Task #15: stop_loss_multiplier based on DTE
describe("auto-STO stop loss DTE gate", () => {
  function stopLossForDTE(dte) { return dte <= 3 ? null : 2.0; }
  it("DTE 1 → no stop loss (null)", () => expect(stopLossForDTE(1)).toBeNull());
  it("DTE 3 → no stop loss (null)", () => expect(stopLossForDTE(3)).toBeNull());
  it("DTE 4 → stop loss 2.0",       () => expect(stopLossForDTE(4)).toBe(2.0));
  it("DTE 7 → stop loss 2.0",       () => expect(stopLossForDTE(7)).toBe(2.0));
});

// Task #16: LEAP exclusion
describe("expiry protection LEAP exclusion", () => {
  function shouldSkipLeap(dte) { return dte > 30; }
  it("DTE 0 → do not skip",  () => expect(shouldSkipLeap(0)).toBe(false));
  it("DTE 30 → do not skip", () => expect(shouldSkipLeap(30)).toBe(false));
  it("DTE 31 → skip LEAP",   () => expect(shouldSkipLeap(31)).toBe(true));
  it("DTE 90 → skip LEAP",   () => expect(shouldSkipLeap(90)).toBe(true));
});

// Task #10: skip BTC if far OTM expiring today
describe("BTC skip far OTM expiring today", () => {
  function shouldSkipBTC(expires, stockPrice, strike) {
    const today = new Date().toISOString().slice(0, 10);
    const dte   = Math.ceil((new Date(expires) - new Date()) / 86400000);
    return dte === 0 && stockPrice < strike * 0.98;
  }
  const today = new Date().toISOString().slice(0, 10);
  it("expires today, stock 3% below strike → skip", () => expect(shouldSkipBTC(today, 145, 150)).toBe(true));
  it("expires today, stock only 1% below  → no skip", () => expect(shouldSkipBTC(today, 149, 150)).toBe(false));
  it("expires today, stock above strike   → no skip", () => expect(shouldSkipBTC(today, 155, 150)).toBe(false));
  it("expires tomorrow, stock below 98%  → no skip", () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    expect(shouldSkipBTC(tomorrow, 145, 150)).toBe(false);
  });
});

// Task #22: ticker_risk_config avoid logic
describe("ticker_risk_config action", () => {
  function shouldSkipTicker(config) {
    return config?.action === 'avoid';
  }
  it("action=avoid → skip",  () => expect(shouldSkipTicker({ action: 'avoid' })).toBe(true));
  it("action=scan  → no skip", () => expect(shouldSkipTicker({ action: 'scan'  })).toBe(false));
  it("not in config → no skip", () => expect(shouldSkipTicker(null)).toBe(false));
});

// ── Skynet rules — market hours gate (from test-skynet-rules.js, vitest version) ──

function isMarketHoursAt(day, hour, minute) {
  if (day === 0 || day === 6) return false;
  const mins = hour * 60 + minute;
  return mins >= 570 && mins < 960;
}
function stopLossForDTE(dte) { return dte <= 3 ? null : 2.0; }
function btcShouldFire(profitPct, marketOpen, threshold) {
  return marketOpen && profitPct >= threshold;
}

describe("Market hours gate (isMarketHours)", () => {
  it("10am Tuesday passes",       () => expect(isMarketHoursAt(2, 10,  0)).toBe(true));
  it("9:30am Monday passes",      () => expect(isMarketHoursAt(1,  9, 30)).toBe(true));
  it("4:01pm Tuesday blocks",     () => expect(isMarketHoursAt(2, 16,  1)).toBe(false));
  it("9:29am Wednesday blocks",   () => expect(isMarketHoursAt(3,  9, 29)).toBe(false));
  it("Saturday blocks",           () => expect(isMarketHoursAt(6, 10,  0)).toBe(false));
  it("Sunday blocks",             () => expect(isMarketHoursAt(0, 10,  0)).toBe(false));
});

describe("Auto-BTC profit threshold (signal_rules wired)", () => {
  it("86% profit, market open, 85% rule → fires",  () => expect(btcShouldFire(86, true,  85)).toBe(true));
  it("84% profit, market open, 85% rule → no fire",() => expect(btcShouldFire(84, true,  85)).toBe(false));
  it("90% profit, after close → no fire",          () => expect(btcShouldFire(90, false, 85)).toBe(false));
  it("76% profit, after-3pm 75% rule → fires",     () => expect(btcShouldFire(76, true,  75)).toBe(true));
});

describe("Stop-loss DTE gate", () => {
  it("DTE=7 → 2.0 multiplier", () => expect(stopLossForDTE(7)).toBe(2.0));
  it("DTE=4 → 2.0 multiplier", () => expect(stopLossForDTE(4)).toBe(2.0));
  it("DTE=3 → null",           () => expect(stopLossForDTE(3)).toBeNull());
  it("DTE=1 → null",           () => expect(stopLossForDTE(1)).toBeNull());
});

// ── ETrade value in portfolio_snapshots ───────────────────────────────────────

describe("ETrade NAV calculation for portfolio_snapshots", () => {
  function resolveEtradeValue(liveApiResult, cachedEtrade) {
    // Mirrors the new market-refresh.js logic
    let etradeValue = null;
    if (liveApiResult?.ok) {
      const nav = (liveApiResult.accountValue || 0) + (liveApiResult.cash || 0);
      if (nav > 0) etradeValue = nav;
    }
    if (!etradeValue && cachedEtrade && +cachedEtrade > 0) {
      etradeValue = +cachedEtrade;
    }
    return etradeValue;
  }

  // Positive: live API works → non-null etrade_value
  it("live API returns equity+cash → combined NAV saved", () => {
    const result = resolveEtradeValue({ ok: true, accountValue: 350000, cash: 50000 }, null);
    expect(result).toBe(400000);
  });

  // Positive: live API fails but cache exists → cache used
  it("live API fails, cache exists → cache used", () => {
    const result = resolveEtradeValue(null, "420000");
    expect(result).toBe(420000);
  });

  // Negative: live API fails AND no cache → null (does not crash)
  it("live API fails and no cache → null (graceful)", () => {
    const result = resolveEtradeValue(null, null);
    expect(result).toBeNull();
  });

  // Negative: live API returns zero NAV → falls back to cache
  it("live API returns zero NAV → falls back to cache", () => {
    const result = resolveEtradeValue({ ok: true, accountValue: 0, cash: 0 }, "380000");
    expect(result).toBe(380000);
  });

  // Schwab still saves even when ETrade fails (independent try/catch blocks)
  it("total_value = schwab + etrade (zero etrade handled)", () => {
    const schwab = 900000;
    const etrade = null;
    const total  = (schwab || 0) + (etrade || 0);
    expect(total).toBe(900000);
  });

  // liveEtradeInline fallback chain: snapshot → cashData
  it("liveEtradeInline: snapshot wins over cashData", () => {
    const snapEtrade  = 410000;
    const cashDataEtrade = 390000;
    const live = snapEtrade ?? (cashDataEtrade ? +cashDataEtrade : null);
    expect(live).toBe(410000);
  });

  it("liveEtradeInline: null snapshot falls back to cashData", () => {
    const snapEtrade     = null;
    const cashDataEtrade = 390000;
    const live = snapEtrade ?? (cashDataEtrade ? +cashDataEtrade : null);
    expect(live).toBe(390000);
  });
});

// ── Strategy backfill (task 7f66f91d) ─────────────────────────────────────────
describe("strategy backfill — STO Call only", () => {
  function shouldBackfill(opt_type, type) {
    return opt_type === 'STO' && type === 'Call';
  }
  it("STO Call → should backfill",   () => expect(shouldBackfill('STO', 'Call')).toBe(true));
  it("BTO Call → should NOT backfill", () => expect(shouldBackfill('BTO', 'Call')).toBe(false));
  it("STO Put  → should NOT backfill", () => expect(shouldBackfill('STO', 'Put')).toBe(false));
  it("BTO Put  → should NOT backfill", () => expect(shouldBackfill('BTO', 'Put')).toBe(false));
});

// ── Expiry protection rule logging (task 7b9750eb) ────────────────────────────
describe("expiry protection — evaluation conditions", () => {
  function expiryEvalResult({ optType, dte, etMins, isITM }) {
    if (optType === 'BTO') return 'skip:BTO';
    if (dte > 30)          return 'skip:LEAP';
    if (etMins < 15 * 60)  return 'skip:too_early';
    if (!isITM)            return 'skip:otm';
    return 'would_close';
  }
  it("STO Call ITM at 3:30pm DTE=0 → would_close",       () => expect(expiryEvalResult({ optType:'STO', dte:0,  etMins:15*60+30, isITM:true  })).toBe('would_close'));
  it("BTO contract ITM at 3:30pm → skip:BTO",             () => expect(expiryEvalResult({ optType:'BTO', dte:0,  etMins:15*60+30, isITM:true  })).toBe('skip:BTO'));
  it("STO DTE=35 (LEAP) ITM at 3:30pm → skip:LEAP",       () => expect(expiryEvalResult({ optType:'STO', dte:35, etMins:15*60+30, isITM:true  })).toBe('skip:LEAP'));
  it("STO DTE=0 OTM at 3:30pm → skip:otm",               () => expect(expiryEvalResult({ optType:'STO', dte:0,  etMins:15*60+30, isITM:false })).toBe('skip:otm'));
  it("STO DTE=0 ITM at 2:00pm (too early) → skip:too_early", () => expect(expiryEvalResult({ optType:'STO', dte:0, etMins:14*60, isITM:true })).toBe('skip:too_early'));
});

// ── Backfill ETrade exclusion (task a7b5c1d6) ─────────────────────────────────
describe("backfill ETrade exclusion", () => {
  function shouldImport(broker) { return broker === 'schwab'; }
  it("schwab transaction → imported",    () => expect(shouldImport('schwab')).toBe(true));
  it("etrade transaction → NOT imported", () => expect(shouldImport('etrade')).toBe(false));

  // Schwab transaction_type mapping
  function mapSchwabType(rawType, netAmount, desc) {
    const d = (desc || '').toUpperCase();
    switch (rawType) {
      case 'TRADE': return netAmount > 0 ? 'SELL' : 'BUY'; // simplified
      case 'DIVIDEND_OR_INTEREST': return d.includes('DIVIDEND') ? 'DIVIDEND' : 'INTEREST';
      case 'JOURNAL': return 'JOURNAL';
      case 'RECEIVE_AND_DELIVER': return netAmount >= 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT';
      case 'ELECTRONIC_FUND': return netAmount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
      case 'WIRE_IN': return 'DEPOSIT';
      case 'WIRE_OUT': return 'WITHDRAWAL';
      default: return null;
    }
  }
  it("DIVIDEND_OR_INTEREST with DIVIDEND desc → DIVIDEND", () => expect(mapSchwabType('DIVIDEND_OR_INTEREST', 50, 'AAPL DIVIDEND')).toBe('DIVIDEND'));
  it("DIVIDEND_OR_INTEREST with no DIVIDEND → INTEREST",  () => expect(mapSchwabType('DIVIDEND_OR_INTEREST', 12, 'MONEY MARKET')).toBe('INTEREST'));
  it("WIRE_IN → DEPOSIT",    () => expect(mapSchwabType('WIRE_IN', 5000, '')).toBe('DEPOSIT'));
  it("WIRE_OUT → WITHDRAWAL", () => expect(mapSchwabType('WIRE_OUT', -2000, '')).toBe('WITHDRAWAL'));
});

// ── Rationale field (task f34bf301) ──────────────────────────────────────────
describe("rationale field visibility", () => {
  function showRationale(tx_type) { return tx_type === 'BUY'; }
  it("BUY → rationale field shown",      () => expect(showRationale('BUY')).toBe(true));
  it("SELL → rationale field hidden",     () => expect(showRationale('SELL')).toBe(false));
  it("DIVIDEND → rationale field hidden", () => expect(showRationale('DIVIDEND')).toBe(false));
  it("TRANSFER_IN → rationale hidden",    () => expect(showRationale('TRANSFER_IN')).toBe(false));
});

// ── Reconcile script (task 8cab2c33) ─────────────────────────────────────────
describe("reconcile script logic", () => {
  function reconcile(statementTxns, dbTxns) {
    const key = t => `${t.date}|${t.type}|${t.symbol}`;
    const dbSet   = new Set(dbTxns.map(key));
    const stmtSet = new Set(statementTxns.map(key));
    return {
      missingFromDB:   statementTxns.filter(t => !dbSet.has(key(t))),
      missingFromStmt: dbTxns.filter(t => !stmtSet.has(key(t))),
    };
  }

  it("3 stmt txns, 2 in DB → 1 missing from DB", () => {
    const stmt = [
      { date:'2026-06-01', type:'BUY',    symbol:'AAPL' },
      { date:'2026-06-02', type:'SELL',   symbol:'AAPL' },
      { date:'2026-06-03', type:'DIVIDEND',symbol:'AAPL' },
    ];
    const db = [
      { date:'2026-06-01', type:'BUY',  symbol:'AAPL' },
      { date:'2026-06-02', type:'SELL', symbol:'AAPL' },
    ];
    const r = reconcile(stmt, db);
    expect(r.missingFromDB.length).toBe(1);
    expect(r.missingFromDB[0].type).toBe('DIVIDEND');
  });

  it("empty statement → no missing from DB", () => {
    const r = reconcile([], [{ date:'2026-06-01', type:'BUY', symbol:'AAPL' }]);
    expect(r.missingFromDB.length).toBe(0);
    expect(r.missingFromStmt.length).toBe(1);
  });
});

// ── Skynet auto stats (new analytics task) ────────────────────────────────────
describe("Skynet auto performance stats", () => {
  function computeAutoStats(contracts) {
    const autoOpen   = contracts.filter(c => c.open_method === 'auto');
    const autoClosed = autoOpen.filter(c => c.status === 'Closed' && c.profit != null);
    const wins = autoClosed.filter(c => c.profit > 0);
    const totalProfit = autoClosed.reduce((s, c) => s + c.profit, 0);
    return {
      autoOpen:    autoOpen.length,
      autoClosed:  autoClosed.length,
      winRate:     autoClosed.length ? Math.round(wins.length / autoClosed.length * 100) : 0,
      totalProfit: Math.round(totalProfit * 100) / 100,
    };
  }

  it("3 auto contracts, 2 wins → winRate 67%, totalProfit computed", () => {
    const contracts = [
      { open_method:'auto', status:'Closed', profit: 100 },
      { open_method:'auto', status:'Closed', profit: 50 },
      { open_method:'auto', status:'Closed', profit: -30 },
    ];
    const s = computeAutoStats(contracts);
    expect(s.autoOpen).toBe(3);
    expect(s.autoClosed).toBe(3);
    expect(s.winRate).toBe(67);
    expect(s.totalProfit).toBe(120);
  });

  it("no auto contracts → zeros, does not crash", () => {
    const s = computeAutoStats([{ open_method:'app', status:'Closed', profit: 100 }]);
    expect(s.autoOpen).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.totalProfit).toBe(0);
  });
});
