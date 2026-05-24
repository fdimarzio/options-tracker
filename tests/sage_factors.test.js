// tests/sage_factors.test.js
// Vitest unit tests for SAGE scoring factor helpers in market-refresh.js
// Run: npx vitest run

import { describe, it, expect } from "vitest";

// ── Helpers copied from market-refresh.js ─────────────────────────────────────
// Keep these in sync manually if the source changes

function computeRSI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const closes = candles.map(c => c.close);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }
  let avgGain = gains  / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

function getAtmIv(chainData, symbol, stockPrice) {
  if (!chainData || !symbol || !stockPrice) return null;
  let bestIv = null, bestDist = Infinity;
  for (const [chainKey, chain] of Object.entries(chainData)) {
    const [chainTicker] = chainKey.split("|");
    if (chainTicker !== symbol.toUpperCase()) continue;
    for (const strike of (chain.calls || [])) {
      const dist = Math.abs(strike.strikePrice - stockPrice);
      if (dist < bestDist && strike.volatility != null) {
        bestDist = dist;
        bestIv   = strike.volatility;
      }
    }
  }
  return bestIv != null ? Math.round(bestIv * 100 * 100) / 100 : null;
}

// ── Shared mock chain data ────────────────────────────────────────────────────
const mockChain = {
  "AAPL|2026-05-30": {
    calls: [
      { strikePrice: 210, volatility: 0.72, bid: 1.5, ask: 1.7 },
      { strikePrice: 215, volatility: 0.68, bid: 0.9, ask: 1.1 },
      { strikePrice: 220, volatility: 0.64, bid: 0.4, ask: 0.6 },
    ],
  },
  "NVDA|2026-05-30": {
    calls: [
      { strikePrice: 900, volatility: 1.15, bid: 8.0, ask: 8.5 },
      { strikePrice: 910, volatility: 1.10, bid: 5.0, ask: 5.5 },
    ],
  },
  "WDC|2026-05-30": {
    calls: [
      { strikePrice: 50, volatility: null, bid: 0.5, ask: 0.7 },
    ],
  },
};

// ── computeRSI ────────────────────────────────────────────────────────────────
describe("computeRSI", () => {
  it("returns null for empty array", () => {
    expect(computeRSI([])).toBeNull();
  });

  it("returns null when fewer than period+1 candles (14 candles)", () => {
    const candles = Array.from({ length: 14 }, (_, i) => ({ close: 100 + i }));
    expect(computeRSI(candles)).toBeNull();
  });

  it("returns a number for exactly period+1 candles (15 candles)", () => {
    const candles = Array.from({ length: 15 }, (_, i) => ({ close: 100 + (i % 2 === 0 ? 1 : -0.5) }));
    expect(typeof computeRSI(candles)).toBe("number");
  });

  it("returns 100 when all days are up (no losses)", () => {
    const candles = Array.from({ length: 20 }, (_, i) => ({ close: 100 + i }));
    expect(computeRSI(candles)).toBe(100);
  });

  it("returns 0 when all days are down (no gains)", () => {
    const candles = Array.from({ length: 20 }, (_, i) => ({ close: 200 - i }));
    expect(computeRSI(candles)).toBe(0);
  });

  it("returns value near 50 for alternating up/down days", () => {
    const closes = [100];
    for (let i = 1; i < 20; i++) closes.push(i % 2 === 0 ? closes[i-1] + 1 : closes[i-1] - 1);
    const candles = closes.map(close => ({ close }));
    const rsi = computeRSI(candles);
    expect(rsi).toBeGreaterThanOrEqual(40);
    expect(rsi).toBeLessThanOrEqual(60);
  });

  it("returns value in valid 0-100 range", () => {
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.15, 43.61, 44.33, 44.83, 45.10, 45.15, 43.61, 44.33];
    const candles = closes.map(close => ({ close }));
    const rsi = computeRSI(candles);
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });

  it("returns a rounded number (2 decimal places)", () => {
    const candles = Array.from({ length: 20 }, (_, i) => ({ close: 100 + Math.sin(i) * 3 }));
    const rsi = computeRSI(candles);
    expect(rsi).toBe(Math.round(rsi * 100) / 100);
  });

  it("handles overbought conditions (strong uptrend) → RSI > 70", () => {
    // Strong uptrend with occasional small pullbacks
    const closes = [100, 102, 104, 103, 106, 108, 107, 110, 113, 112, 115, 118, 117, 120, 123, 122, 125, 128, 127, 130];
    const candles = closes.map(close => ({ close }));
    expect(computeRSI(candles)).toBeGreaterThan(70);
  });

  it("handles oversold conditions (strong downtrend) → RSI < 30", () => {
    const closes = [130, 128, 127, 125, 122, 123, 120, 117, 118, 115, 112, 113, 110, 107, 108, 106, 103, 102, 104, 100];
    const candles = closes.map(close => ({ close }));
    expect(computeRSI(candles)).toBeLessThan(30);
  });
});

// ── getAtmIv ──────────────────────────────────────────────────────────────────
describe("getAtmIv", () => {
  it("returns null for null chainData", () => {
    expect(getAtmIv(null, "AAPL", 210)).toBeNull();
  });

  it("returns null for null symbol", () => {
    expect(getAtmIv(mockChain, null, 210)).toBeNull();
  });

  it("returns null for null stockPrice", () => {
    expect(getAtmIv(mockChain, "AAPL", null)).toBeNull();
  });

  it("returns null for unknown ticker", () => {
    expect(getAtmIv(mockChain, "TSLA", 200)).toBeNull();
  });

  it("returns null when all strikes have null volatility", () => {
    expect(getAtmIv(mockChain, "WDC", 50)).toBeNull();
  });

  it("picks the nearest ATM strike — price closer to 215 than 210", () => {
    // price=213: dist to 215=2, dist to 210=3 → picks 215 (volatility 0.68 → 68%)
    expect(getAtmIv(mockChain, "AAPL", 213)).toBe(68);
  });

  it("picks strike 210 when price is exactly at it", () => {
    expect(getAtmIv(mockChain, "AAPL", 210)).toBe(72);
  });

  it("returns IV as percentage not decimal (72 not 0.72)", () => {
    const iv = getAtmIv(mockChain, "AAPL", 210);
    expect(iv).toBeGreaterThan(1); // confirms it's not a 0-1 decimal
    expect(iv).toBe(72);
  });

  it("handles high-IV tickers correctly (NVDA > 100%)", () => {
    const iv = getAtmIv(mockChain, "NVDA", 905);
    expect(iv).toBeGreaterThanOrEqual(100);
    expect(iv).toBeLessThanOrEqual(120);
  });

  it("is case-insensitive for symbol lookup", () => {
    expect(getAtmIv(mockChain, "aapl", 210)).toBe(72);
    expect(getAtmIv(mockChain, "Aapl", 210)).toBe(72);
  });

  it("works with multiple expiry dates for same ticker — picks nearest strike across all", () => {
    const multiExpiryChain = {
      "AAPL|2026-05-30": { calls: [{ strikePrice: 220, volatility: 0.64 }] },
      "AAPL|2026-06-06": { calls: [{ strikePrice: 213, volatility: 0.70 }] },
    };
    // price=213: strike 213 in Jun expiry is exact match (dist=0) vs strike 220 (dist=7)
    expect(getAtmIv(multiExpiryChain, "AAPL", 213)).toBe(70);
  });
});
