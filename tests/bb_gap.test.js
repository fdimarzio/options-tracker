// tests/bb_gap.test.js
// Vitest tests for computeBollingerBands and computeGapFlag
// Run: npx vitest run

import { describe, it, expect } from "vitest";

// ── Helpers (keep in sync with market-refresh.js) ────────────────────────────

function computeBollingerBands(candles, period = 20) {
  if (!candles || candles.length < period) return null;
  const recent = candles.slice(-period);
  const closes = recent.map(c => c.close);
  const sma      = closes.reduce((s, v) => s + v, 0) / period;
  const variance = closes.reduce((s, v) => s + Math.pow(v - sma, 2), 0) / period;
  const stdDev   = Math.sqrt(variance);
  const upper    = sma + 2 * stdDev;
  const lower    = sma - 2 * stdDev;
  const currentClose = candles[candles.length - 1].close;
  const bbPctB   = stdDev === 0 ? 0.5 : (currentClose - lower) / (upper - lower);
  const bbWidth  = stdDev === 0 ? 0 : Math.round((upper - lower) / sma * 100 * 100) / 100;
  const bbPosition = stdDev === 0 ? 0
    : currentClose >= upper - (stdDev * 0.2) ? 1
    : currentClose <= lower + (stdDev * 0.2) ? -1
    : 0;
  return {
    bb_pct_b:    Math.round(bbPctB * 1000) / 1000,
    bb_width:    bbWidth,
    bb_position: bbPosition,
    bb_upper:    Math.round(upper * 100) / 100,
    bb_lower:    Math.round(lower * 100) / 100,
    bb_mid:      Math.round(sma * 100) / 100,
  };
}

function computeGapFlag(candles, threshold = 0.5) {
  if (!candles || candles.length < 2) return null;
  const today     = candles[candles.length - 1];
  const yesterday = candles[candles.length - 2];
  if (!today?.open || !yesterday?.close) return null;
  const gapPct = (today.open - yesterday.close) / yesterday.close * 100;
  const gapAbs = Math.abs(gapPct);
  return {
    gap_pct:       Math.round(gapPct * 100) / 100,
    gap_flag:      gapAbs >= threshold ? 1 : 0,
    gap_direction: gapAbs >= threshold ? (gapPct > 0 ? 1 : -1) : 0,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCandles(closes, opens = null) {
  return closes.map((close, i) => ({
    open:  opens ? opens[i] : close,
    high:  close + 1,
    low:   close - 1,
    close,
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
  }));
}

// 20 flat candles at price P
function flatCandles(price, n = 20) {
  return makeCandles(Array(n).fill(price));
}

// ── computeBollingerBands ─────────────────────────────────────────────────────
describe("computeBollingerBands", () => {
  it("returns null for empty array", () => {
    expect(computeBollingerBands([])).toBeNull();
  });

  it("returns null for fewer than period candles (19 < 20)", () => {
    expect(computeBollingerBands(makeCandles(Array(19).fill(100)))).toBeNull();
  });

  it("returns object with all expected keys", () => {
    const result = computeBollingerBands(makeCandles(Array(20).fill(100)));
    expect(result).toHaveProperty("bb_pct_b");
    expect(result).toHaveProperty("bb_width");
    expect(result).toHaveProperty("bb_position");
    expect(result).toHaveProperty("bb_upper");
    expect(result).toHaveProperty("bb_lower");
    expect(result).toHaveProperty("bb_mid");
  });

  it("flat prices → zero width, bb_pct_b = 0.5, bb_position = 0", () => {
    const result = computeBollingerBands(flatCandles(100));
    expect(result.bb_width).toBe(0);
    expect(result.bb_pct_b).toBe(0.5);
    expect(result.bb_position).toBe(0);
  });

  it("price at upper band → bb_pct_b ≈ 1, bb_position = 1", () => {
    // Build candles where last close is at upper band
    const closes = Array(19).fill(100);
    closes.push(110); // spike up to push near upper band
    const result = computeBollingerBands(makeCandles(closes));
    expect(result.bb_pct_b).toBeGreaterThan(0.8);
    expect(result.bb_position).toBe(1);
  });

  it("price at lower band → bb_pct_b ≈ 0, bb_position = -1", () => {
    const closes = Array(19).fill(100);
    closes.push(90); // drop to push near lower band
    const result = computeBollingerBands(makeCandles(closes));
    expect(result.bb_pct_b).toBeLessThan(0.2);
    expect(result.bb_position).toBe(-1);
  });

  it("bb_upper > bb_mid > bb_lower", () => {
    const closes = Array(20).fill(0).map((_, i) => 100 + i * 0.5);
    const result = computeBollingerBands(makeCandles(closes));
    expect(result.bb_upper).toBeGreaterThan(result.bb_mid);
    expect(result.bb_mid).toBeGreaterThan(result.bb_lower);
  });

  it("bb_pct_b is a valid number", () => {
    const closes = Array(20).fill(0).map((_, i) => 100 + Math.sin(i) * 5);
    const result = computeBollingerBands(makeCandles(closes));
    expect(typeof result.bb_pct_b).toBe("number");
    expect(isNaN(result.bb_pct_b)).toBe(false);
  });

  it("uses only last 20 candles even with 30 provided", () => {
    // First 10 candles at 50, last 20 at 100 — SMA should be near 100
    const closes = [...Array(10).fill(50), ...Array(20).fill(100)];
    const result = computeBollingerBands(makeCandles(closes));
    expect(result.bb_mid).toBeCloseTo(100, 0);
  });

  it("bb_width is non-negative", () => {
    const closes = Array(20).fill(0).map((_, i) => 100 + Math.sin(i) * 5);
    expect(computeBollingerBands(makeCandles(closes)).bb_width).toBeGreaterThanOrEqual(0);
  });

  it("higher volatility → wider bands (larger bb_width)", () => {
    const lowVol  = makeCandles(Array(20).fill(0).map((_, i) => 100 + (i % 2 === 0 ? 0.1 : -0.1)));
    const highVol = makeCandles(Array(20).fill(0).map((_, i) => 100 + (i % 2 === 0 ? 5 : -5)));
    expect(computeBollingerBands(highVol).bb_width).toBeGreaterThan(computeBollingerBands(lowVol).bb_width);
  });
});

// ── computeGapFlag ────────────────────────────────────────────────────────────
describe("computeGapFlag", () => {
  it("returns null for empty array", () => {
    expect(computeGapFlag([])).toBeNull();
  });

  it("returns null for single candle", () => {
    expect(computeGapFlag([{ open: 100, close: 101 }])).toBeNull();
  });

  it("returns null when open or close is missing", () => {
    expect(computeGapFlag([{ close: 100 }, { close: 102 }])).toBeNull();
    expect(computeGapFlag([{ open: 100, close: 100 }, { close: 102 }])).toBeNull();
  });

  it("returns object with all expected keys", () => {
    const candles = makeCandles([100, 102], [100, 103]);
    const result  = computeGapFlag(candles);
    expect(result).toHaveProperty("gap_pct");
    expect(result).toHaveProperty("gap_flag");
    expect(result).toHaveProperty("gap_direction");
  });

  it("gap up > threshold → gap_flag=1, gap_direction=1", () => {
    // yesterday close=100, today open=102 → gap up 2%
    const candles = [
      { open: 98, high: 101, low: 97, close: 100 },
      { open: 102, high: 105, low: 101, close: 103 },
    ];
    const result = computeGapFlag(candles);
    expect(result.gap_flag).toBe(1);
    expect(result.gap_direction).toBe(1);
    expect(result.gap_pct).toBeCloseTo(2, 0);
  });

  it("gap down > threshold → gap_flag=1, gap_direction=-1", () => {
    // yesterday close=100, today open=98 → gap down 2%
    const candles = [
      { open: 101, high: 102, low: 99, close: 100 },
      { open: 98,  high: 99,  low: 96, close: 97  },
    ];
    const result = computeGapFlag(candles);
    expect(result.gap_flag).toBe(1);
    expect(result.gap_direction).toBe(-1);
    expect(result.gap_pct).toBeCloseTo(-2, 0);
  });

  it("small gap below threshold → gap_flag=0, gap_direction=0", () => {
    // yesterday close=100, today open=100.2 → gap 0.2% < 0.5% threshold
    const candles = [
      { open: 99.8, high: 100.5, low: 99.5, close: 100   },
      { open: 100.2, high: 101,  low: 100,  close: 100.5 },
    ];
    const result = computeGapFlag(candles);
    expect(result.gap_flag).toBe(0);
    expect(result.gap_direction).toBe(0);
  });

  it("no gap (open = prev close) → gap_pct = 0", () => {
    const candles = [
      { open: 99, high: 101, low: 98, close: 100 },
      { open: 100, high: 102, low: 99, close: 101 },
    ];
    expect(computeGapFlag(candles).gap_pct).toBe(0);
  });

  it("custom threshold respected", () => {
    // 1% gap with default threshold 0.5 → flag=1; with threshold 2.0 → flag=0
    const candles = [
      { open: 99, high: 101, low: 98, close: 100 },
      { open: 101, high: 103, low: 100, close: 102 },
    ];
    expect(computeGapFlag(candles, 0.5).gap_flag).toBe(1);
    expect(computeGapFlag(candles, 2.0).gap_flag).toBe(0);
  });

  it("gap_pct sign is correct — positive for gap up", () => {
    const candles = [
      { open: 99, high: 101, low: 98, close: 100 },
      { open: 103, high: 105, low: 102, close: 104 },
    ];
    expect(computeGapFlag(candles).gap_pct).toBeGreaterThan(0);
  });

  it("gap_pct sign is correct — negative for gap down", () => {
    const candles = [
      { open: 101, high: 103, low: 100, close: 102 },
      { open: 99,  high: 100, low: 97,  close: 98  },
    ];
    expect(computeGapFlag(candles).gap_pct).toBeLessThan(0);
  });
});
