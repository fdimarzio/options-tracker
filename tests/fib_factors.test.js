// tests/fib_factors.test.js
// Vitest unit tests for Fibonacci helpers
// Run: npx vitest run

import { describe, it, expect } from "vitest";

// ── Helpers copied from market-refresh.js / pri-tod-v3.jsx ───────────────────
// Keep in sync manually if source changes

function computeFibFactors(candles, stockPrice, lookback = 60) {
  if (!candles || candles.length < 10 || !stockPrice) return null;
  const window = candles.slice(-Math.min(lookback, candles.length));
  const swingHigh = Math.max(...window.map(c => c.high));
  const swingLow  = Math.min(...window.map(c => c.low));
  const range = swingHigh - swingLow;
  if (range <= 0) return null;
  const FIB_PCTS = [0.236, 0.382, 0.5, 0.618, 0.786];
  const levels = FIB_PCTS.map(pct => ({
    pct, price: Math.round((swingHigh - pct * range) * 100) / 100,
  }));
  let nearestLevel = null, nearestDistPct = Infinity;
  for (const lvl of levels) {
    const distPct = Math.abs(stockPrice - lvl.price) / stockPrice * 100;
    if (distPct < nearestDistPct) { nearestDistPct = distPct; nearestLevel = lvl; }
  }
  const prevClose  = candles[candles.length - 2]?.close;
  const brokeBelow = nearestLevel && prevClose > nearestLevel.price && stockPrice < nearestLevel.price;
  return {
    fib_proximity_pct:   Math.round(nearestDistPct * 100) / 100,
    fib_level:           nearestLevel?.pct ?? null,
    fib_broke_below:     brokeBelow ? 1 : 0,
    fib_near_resistance: (nearestLevel?.pct <= 0.382 && nearestDistPct < 1.5) ? 1 : 0,
    fib_near_support:    (nearestLevel?.pct >= 0.618 && nearestDistPct < 1.5) ? 1 : 0,
  };
}

// Shared mock candles — 20 daily bars, high=150, low=100
function makeTrendCandles({ swingHigh = 150, swingLow = 100, n = 20 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    open:  swingLow + (swingHigh - swingLow) * (i / n),
    high:  i === n - 1 ? swingHigh : swingLow + (swingHigh - swingLow) * ((i + 1) / n),
    low:   i === 0     ? swingLow  : swingLow + (swingHigh - swingLow) * (i / n) - 1,
    close: swingLow + (swingHigh - swingLow) * ((i + 0.5) / n),
  }));
}

// ── computeFibFactors ─────────────────────────────────────────────────────────
describe("computeFibFactors", () => {
  it("returns null for empty candles", () => {
    expect(computeFibFactors([], 125)).toBeNull();
  });

  it("returns null for fewer than 10 candles", () => {
    const candles = Array.from({ length: 9 }, () => ({ open: 100, high: 110, low: 90, close: 105 }));
    expect(computeFibFactors(candles, 105)).toBeNull();
  });

  it("returns null for null stockPrice", () => {
    expect(computeFibFactors(makeTrendCandles(), null)).toBeNull();
  });

  it("returns null when all candles have same high/low (zero range)", () => {
    const candles = Array.from({ length: 15 }, () => ({ open: 100, high: 100, low: 100, close: 100 }));
    expect(computeFibFactors(candles, 100)).toBeNull();
  });

  it("returns an object with all expected keys", () => {
    const result = computeFibFactors(makeTrendCandles(), 125);
    expect(result).toHaveProperty("fib_proximity_pct");
    expect(result).toHaveProperty("fib_level");
    expect(result).toHaveProperty("fib_broke_below");
    expect(result).toHaveProperty("fib_near_resistance");
    expect(result).toHaveProperty("fib_near_support");
  });

  it("fib_proximity_pct is a non-negative number", () => {
    const result = computeFibFactors(makeTrendCandles(), 125);
    expect(result.fib_proximity_pct).toBeGreaterThanOrEqual(0);
  });

  it("fib_level is one of the standard Fib ratios", () => {
    const validLevels = [0.236, 0.382, 0.5, 0.618, 0.786];
    const result = computeFibFactors(makeTrendCandles(), 125);
    expect(validLevels).toContain(result.fib_level);
  });

  it("fib_broke_below is 0 or 1", () => {
    const result = computeFibFactors(makeTrendCandles(), 125);
    expect([0, 1]).toContain(result.fib_broke_below);
  });

  it("fib_near_resistance is 1 when price is within 1.5% of a high Fib level (23.6% or 38.2%)", () => {
    // swingHigh=150, swingLow=100, range=50
    // 23.6% level = 150 - 0.236*50 = 138.2
    // 38.2% level = 150 - 0.382*50 = 130.9
    // Place price exactly at 38.2% level
    const candles = makeTrendCandles({ swingHigh: 150, swingLow: 100 });
    const price = 150 - 0.382 * 50; // = 130.9
    const result = computeFibFactors(candles, price);
    expect(result.fib_near_resistance).toBe(1);
    expect(result.fib_level).toBe(0.382);
  });

  it("fib_near_support is 1 when price is within 1.5% of a low Fib level (61.8% or 78.6%)", () => {
    // 61.8% level = 150 - 0.618*50 = 119.1
    const candles = makeTrendCandles({ swingHigh: 150, swingLow: 100 });
    const price = 150 - 0.618 * 50; // = 119.1
    const result = computeFibFactors(candles, price);
    expect(result.fib_near_support).toBe(1);
    expect(result.fib_level).toBe(0.618);
  });

  it("fib_near_resistance and fib_near_support are both 0 in neutral zone", () => {
    // Price at exactly 50% level — neutral
    const candles = makeTrendCandles({ swingHigh: 150, swingLow: 100 });
    const price = 150 - 0.5 * 50; // = 125
    const result = computeFibFactors(candles, price);
    expect(result.fib_near_resistance).toBe(0);
    expect(result.fib_near_support).toBe(0);
  });

  it("fib_broke_below is 1 when prev close was above level and current price is below", () => {
    // Explicit candles: swingHigh=150, swingLow=100, range=50
    // 38.2% level = 150 - 0.382*50 = 130.9
    // prevClose=132 (above), stockPrice=129 (below) → broke below
    const candles = Array.from({ length: 18 }, (_, i) => ({
      open: 100 + i * 2, high: 100 + i * 2 + 1, low: 100 + i * 2 - 1, close: 100 + i * 2,
    }));
    candles.push({ open: 150, high: 150, low: 149, close: 150 }); // sets swingHigh=150
    candles.push({ open: 100, high: 101, low: 100, close: 100 }); // sets swingLow=100
    candles.push({ open: 132, high: 133, low: 131, close: 132 }); // prevClose above 130.9
    candles.push({ open: 129, high: 130, low: 128, close: 129 }); // stockPrice below 130.9
    const result = computeFibFactors(candles, 129);
    expect(result.fib_broke_below).toBe(1);
  });

  it("fib_broke_below is 0 when price is above prior close (upward move)", () => {
    const candles = makeTrendCandles({ swingHigh: 150, swingLow: 100 });
    // Both closes above a level — no break
    candles[candles.length - 2] = { open: 128, high: 130, low: 127, close: 129 };
    candles[candles.length - 1] = { open: 130, high: 133, low: 129, close: 132 };
    const result = computeFibFactors(candles, 132);
    expect(result.fib_broke_below).toBe(0);
  });

  it("uses lookback window correctly — limits to last N candles", () => {
    // 80 candles but lookback=20 — swing high/low should reflect only last 20
    const oldCandles = Array.from({ length: 60 }, () => ({ open: 200, high: 250, low: 180, close: 220 }));
    const recentCandles = makeTrendCandles({ swingHigh: 150, swingLow: 100, n: 20 });
    const candles = [...oldCandles, ...recentCandles];
    // With lookback=20, swing should be ~150/100; without it would be 250/180
    const result20  = computeFibFactors(candles, 125, 20);
    const resultAll = computeFibFactors(candles, 125, 80);
    // fib_level should differ because the swing range differs
    expect(result20).not.toBeNull();
    expect(resultAll).not.toBeNull();
    // The 38.2% level with high=150 low=100 is 130.9; with high=250 low=180 it's ~223.3
    // Proximity to 125 should be smaller with the recent-only window
    expect(result20.fib_proximity_pct).toBeLessThan(resultAll.fib_proximity_pct);
  });

  it("fib_proximity_pct is 0 when price is exactly on a Fib level", () => {
    const candles = makeTrendCandles({ swingHigh: 150, swingLow: 100 });
    const exactPrice = 150 - 0.5 * 50; // exactly 125 = 50% level
    const result = computeFibFactors(candles, exactPrice);
    expect(result.fib_proximity_pct).toBe(0);
    expect(result.fib_level).toBe(0.5);
  });
});
