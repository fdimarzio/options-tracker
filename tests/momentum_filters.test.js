// tests/momentum_filters.test.js
// End-to-end tests for the unified STO momentum filters
// Tests evaluateMomentum (pullback, deceleration, gap-up) + technical filters (RSI, trend, SMA)
// Run: npx vitest run tests/momentum_filters.test.js

import { describe, it, expect } from "vitest";

// ── evaluateMomentum — copied from market-refresh.js ─────────────────────────
// Keep in sync if the source changes

function evaluateMomentum(symbol, quote, priceHistory, config) {
  if (!config) return { pass: true, reasons: ["no momentum config — passing"], indicators: {} };

  const reasons    = [];
  const indicators = {};
  let pass         = true;

  const last      = quote.lastPrice;
  const dayHigh   = quote.dayHigh;
  const openPrice = quote.openPrice;

  // 1. Pullback from intraday high
  if (config.pullback_enabled && dayHigh && last) {
    const pullbackPct = ((dayHigh - last) / dayHigh) * 100;
    indicators.pullbackFromHigh = Math.round(pullbackPct * 100) / 100;
    if (pullbackPct < config.min_pullback_from_high_pct) {
      pass = false;
      reasons.push(`within ${pullbackPct.toFixed(2)}% of intraday high — momentum still running`);
    } else {
      reasons.push(`✓ pullback ${pullbackPct.toFixed(2)}% from high — momentum fading`);
    }
  }

  // 2. Rate of change (deceleration)
  if (config.momentum_enabled && config.require_decelerating) {
    const symHistory = (Array.isArray(priceHistory) ? priceHistory : [])
      .filter(r => r.symbol === symbol)
      .sort((a, b) => new Date(b.captured_at) - new Date(a.captured_at));

    const lookbackMs = (config.momentum_lookback_mins || 30) * 60000;
    const cutoff     = new Date(Date.now() - lookbackMs);
    const historical = symHistory.find(r => new Date(r.captured_at) <= cutoff);

    if (historical?.change_pct != null && quote.changePct != null) {
      const currentChangePct   = quote.changePct * 100;
      const historicalChangePct = historical.change_pct;
      const isDecelerating     = currentChangePct <= historicalChangePct;
      indicators.changePctNow  = Math.round(currentChangePct * 100) / 100;
      indicators.changePct30m  = Math.round(historicalChangePct * 100) / 100;
      indicators.decelerating  = isDecelerating;
      if (!isDecelerating) {
        pass = false;
        reasons.push(`accelerating: +${historicalChangePct.toFixed(2)}% → +${currentChangePct.toFixed(2)}%`);
      } else {
        reasons.push(`✓ decelerating: +${historicalChangePct.toFixed(2)}% → +${currentChangePct.toFixed(2)}%`);
      }
    } else {
      reasons.push(`no historical snapshot for deceleration check`);
    }
  }

  // 3. Open gap check
  if (config.gap_enabled && openPrice && last) {
    const moveFromOpen = ((last - openPrice) / openPrice) * 100;
    indicators.moveFromOpen = Math.round(moveFromOpen * 100) / 100;
    if (config.max_gap_up_pct && moveFromOpen > config.max_gap_up_pct) {
      pass = false;
      reasons.push(`gap-up ${moveFromOpen.toFixed(2)}% from open exceeds max ${config.max_gap_up_pct}%`);
    } else {
      reasons.push(`✓ move from open ${moveFromOpen.toFixed(2)}% within acceptable range`);
    }
  }

  return { pass, reasons, indicators };
}

// ── Technical filters — same logic as market-refresh.js STO scanner ──────────

function evaluateTechnicalFilters(mfRule, trendData) {
  if (!mfRule) return { pass: true, reason: "no filters" };
  if (!trendData) return { pass: true, reason: "no trend data" };

  if (mfRule.max_rsi != null && trendData.rsi14 != null && trendData.rsi14 > +mfRule.max_rsi) {
    return { pass: false, reason: `RSI ${trendData.rsi14} > max ${mfRule.max_rsi}` };
  }
  if (mfRule.min_rsi != null && trendData.rsi14 != null && trendData.rsi14 < +mfRule.min_rsi) {
    return { pass: false, reason: `RSI ${trendData.rsi14} < min ${mfRule.min_rsi}` };
  }
  if (Array.isArray(mfRule.require_trend) && mfRule.require_trend.length && trendData.trend_regime) {
    if (!mfRule.require_trend.includes(trendData.trend_regime)) {
      return { pass: false, reason: `trend "${trendData.trend_regime}" not in [${mfRule.require_trend.join(",")}]` };
    }
  }
  if (mfRule.min_sma_alignment != null && trendData.sma_alignment != null && trendData.sma_alignment < +mfRule.min_sma_alignment) {
    return { pass: false, reason: `sma_alignment ${trendData.sma_alignment} < min ${mfRule.min_sma_alignment}` };
  }
  return { pass: true, reason: "all filters passed" };
}

// ── OTM-by-DTE table lookup — same logic as market-refresh.js ────────────────

function getEffectiveMinOTM(otmDteTable, dte, fallback) {
  if (!Array.isArray(otmDteTable) || !otmDteTable.length) return fallback;
  const sorted = [...otmDteTable].sort((a, b) => a.max_dte - b.max_dte);
  const match  = sorted.find(row => dte <= row.max_dte);
  if (match) return +match.min_otm_pct;
  return +sorted[sorted.length - 1].min_otm_pct;
}

// ── Your actual production config (from signal_rules id:1) ───────────────────

const PROD_MOMENTUM_FILTERS = {
  max_rsi: 75,
  min_rsi: null,
  require_trend: ["bullish", "neutral"],
  min_sma_alignment: null,
  pullback_enabled: true,
  min_pullback_from_high_pct: 0.3,
  require_decelerating: true,
  momentum_enabled: true,
  momentum_lookback_mins: 10,
  gap_enabled: true,
  max_gap_up_pct: 2.0,
  min_gap_up_pct: 0.0,
};

const PROD_OTM_DTE_TABLE = [
  { max_dte: 3,  min_otm_pct: 1.75 },
  { max_dte: 7,  min_otm_pct: 2.0 },
  { max_dte: 14, min_otm_pct: 2.5 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 1: Perfect STO setup — stock up 1.2%, pulling back, decelerating
// Expected: ALL gates pass
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario 1: Perfect STO entry — NVDA up 1.2%, pulling back from high", () => {
  const quote = { lastPrice: 135.50, dayHigh: 136.20, openPrice: 133.90, changePct: 0.012, closePrice: 133.89 };
  const priceHistory = [
    { symbol: "NVDA", change_pct: 1.5, captured_at: new Date(Date.now() - 15 * 60000).toISOString() },
  ];
  const trend = { rsi14: 62, trend_regime: "bullish", sma_alignment: 2 };

  it("pullback gate passes — stock pulled back 0.51% from high", () => {
    const result = evaluateMomentum("NVDA", quote, priceHistory, PROD_MOMENTUM_FILTERS);
    expect(result.indicators.pullbackFromHigh).toBeGreaterThan(0.3);
    expect(result.reasons.some(r => r.includes("✓ pullback"))).toBe(true);
  });

  it("deceleration gate passes — was +1.5% now +1.2%", () => {
    const result = evaluateMomentum("NVDA", quote, priceHistory, PROD_MOMENTUM_FILTERS);
    expect(result.indicators.decelerating).toBe(true);
  });

  it("gap-up gate passes — 1.2% move from open < 2% max", () => {
    const result = evaluateMomentum("NVDA", quote, priceHistory, PROD_MOMENTUM_FILTERS);
    expect(result.indicators.moveFromOpen).toBeLessThan(2.0);
  });

  it("overall momentum passes", () => {
    const result = evaluateMomentum("NVDA", quote, priceHistory, PROD_MOMENTUM_FILTERS);
    expect(result.pass).toBe(true);
  });

  it("technical filters pass — RSI 62, bullish trend", () => {
    const result = evaluateTechnicalFilters(PROD_MOMENTUM_FILTERS, trend);
    expect(result.pass).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 2: Stock still ripping — at intraday high, accelerating
// Expected: Pullback AND deceleration gates BLOCK the STO
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario 2: Stock still running — AMZN at high, accelerating", () => {
  const quote = { lastPrice: 272.80, dayHigh: 272.90, openPrice: 268.00, changePct: 0.018, closePrice: 267.95 };
  const priceHistory = [
    { symbol: "AMZN", change_pct: 1.2, captured_at: new Date(Date.now() - 15 * 60000).toISOString() },
  ];

  it("pullback gate BLOCKS — only 0.04% from high (need 0.3%)", () => {
    const result = evaluateMomentum("AMZN", quote, priceHistory, PROD_MOMENTUM_FILTERS);
    expect(result.indicators.pullbackFromHigh).toBeLessThan(0.3);
    expect(result.pass).toBe(false);
  });

  it("deceleration gate would also BLOCK — accelerating from +1.2% to +1.8%", () => {
    // Test with pullback disabled to isolate deceleration
    const config = { ...PROD_MOMENTUM_FILTERS, pullback_enabled: false };
    const result = evaluateMomentum("AMZN", quote, priceHistory, config);
    expect(result.indicators.decelerating).toBe(false);
    expect(result.pass).toBe(false);
  });

  it("overall momentum FAILS", () => {
    const result = evaluateMomentum("AMZN", quote, priceHistory, PROD_MOMENTUM_FILTERS);
    expect(result.pass).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 3: Big gap-up morning — stock gapped up 3%
// Expected: Gap-up filter BLOCKS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario 3: Gap-up morning — CEG opened +3% from yesterday", () => {
  const quote = { lastPrice: 310.00, dayHigh: 312.00, openPrice: 300.00, changePct: 0.033, closePrice: 300.97 };
  const priceHistory = [
    { symbol: "CEG", change_pct: 3.5, captured_at: new Date(Date.now() - 15 * 60000).toISOString() },
  ];

  it("gap-up gate BLOCKS — 3.33% move from open > 2% max", () => {
    const result = evaluateMomentum("CEG", quote, priceHistory, PROD_MOMENTUM_FILTERS);
    expect(result.indicators.moveFromOpen).toBeGreaterThan(2.0);
    expect(result.pass).toBe(false);
    expect(result.reasons.some(r => r.includes("gap-up"))).toBe(true);
  });

  it("with gap filter disabled, passes (pullback and decel ok)", () => {
    const config = { ...PROD_MOMENTUM_FILTERS, gap_enabled: false };
    const result = evaluateMomentum("CEG", quote, priceHistory, config);
    // Pullback: (312-310)/312 = 0.64% > 0.3 ✓
    // Deceleration: 3.5 → 3.3 ✓
    expect(result.pass).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 4: RSI too high — overbought stock
// Expected: RSI filter BLOCKS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario 4: Overbought — AMD RSI at 82", () => {
  const trend = { rsi14: 82, trend_regime: "bullish", sma_alignment: 3 };

  it("RSI filter BLOCKS — 82 > max 75", () => {
    const result = evaluateTechnicalFilters(PROD_MOMENTUM_FILTERS, trend);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("RSI");
  });

  it("with max_rsi raised to 85, passes", () => {
    const config = { ...PROD_MOMENTUM_FILTERS, max_rsi: 85 };
    const result = evaluateTechnicalFilters(config, trend);
    expect(result.pass).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 5: Bearish trend — stock in downtrend
// Expected: Trend filter BLOCKS for STO calls (but we noted this is fine for calls)
// This test documents current behavior — when we remove trend filter for calls,
// update this test
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario 5: Bearish trend — COST trending down", () => {
  const trend = { rsi14: 45, trend_regime: "bearish", sma_alignment: 0 };

  it("trend filter BLOCKS — bearish not in [bullish, neutral]", () => {
    const result = evaluateTechnicalFilters(PROD_MOMENTUM_FILTERS, trend);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("bearish");
  });

  it("with require_trend including bearish, passes", () => {
    const config = { ...PROD_MOMENTUM_FILTERS, require_trend: ["bullish", "neutral", "bearish"] };
    const result = evaluateTechnicalFilters(config, trend);
    expect(result.pass).toBe(true);
  });

  it("with require_trend set to null (any), passes", () => {
    const config = { ...PROD_MOMENTUM_FILTERS, require_trend: null };
    const result = evaluateTechnicalFilters(config, trend);
    expect(result.pass).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 6: No data — missing price history, missing trend
// Expected: Gates without data should PASS (not block), log warning
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario 6: Missing data — no price history, no trend data", () => {
  const quote = { lastPrice: 150, dayHigh: 151, openPrice: 149, changePct: 0.007 };

  it("momentum passes with empty price history (no deceleration data)", () => {
    const result = evaluateMomentum("AAPL", quote, [], PROD_MOMENTUM_FILTERS);
    // Pullback: 0.66% > 0.3 ✓
    // Deceleration: no data → warning, not block
    // Gap: 0.67% < 2% ✓
    expect(result.pass).toBe(true);
  });

  it("technical filters pass with null trend data", () => {
    const result = evaluateTechnicalFilters(PROD_MOMENTUM_FILTERS, null);
    expect(result.pass).toBe(true);
  });

  it("no config at all → everything passes", () => {
    const result = evaluateMomentum("AAPL", quote, [], null);
    expect(result.pass).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 7: Toggle individual gates on/off
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario 7: Individual gate toggles", () => {
  // Stock at its high, accelerating, big gap — would fail everything
  const quote = { lastPrice: 200, dayHigh: 200.10, openPrice: 194, changePct: 0.031 };
  const priceHistory = [
    { symbol: "TEST", change_pct: 2.0, captured_at: new Date(Date.now() - 15 * 60000).toISOString() },
  ];

  it("all gates ON → fails", () => {
    const result = evaluateMomentum("TEST", quote, priceHistory, PROD_MOMENTUM_FILTERS);
    expect(result.pass).toBe(false);
  });

  it("all gates OFF → passes", () => {
    const config = { ...PROD_MOMENTUM_FILTERS, pullback_enabled: false, require_decelerating: false, momentum_enabled: false, gap_enabled: false };
    const result = evaluateMomentum("TEST", quote, priceHistory, config);
    expect(result.pass).toBe(true);
  });

  it("only pullback ON → fails on pullback alone", () => {
    const config = { ...PROD_MOMENTUM_FILTERS, require_decelerating: false, momentum_enabled: false, gap_enabled: false };
    const result = evaluateMomentum("TEST", quote, priceHistory, config);
    expect(result.pass).toBe(false);
    expect(result.reasons.some(r => r.includes("intraday high"))).toBe(true);
  });

  it("only gap ON → fails on gap alone", () => {
    const config = { ...PROD_MOMENTUM_FILTERS, pullback_enabled: false, require_decelerating: false, momentum_enabled: false };
    const result = evaluateMomentum("TEST", quote, priceHistory, config);
    expect(result.pass).toBe(false);
    expect(result.reasons.some(r => r.includes("gap-up"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OTM-BY-DTE TABLE
// ═══════════════════════════════════════════════════════════════════════════════

describe("OTM-by-DTE table lookup", () => {
  it("DTE 2 → min OTM 1.75% (first tier)", () => {
    expect(getEffectiveMinOTM(PROD_OTM_DTE_TABLE, 2, 1)).toBe(1.75);
  });

  it("DTE 3 → min OTM 1.75% (boundary, ≤ 3)", () => {
    expect(getEffectiveMinOTM(PROD_OTM_DTE_TABLE, 3, 1)).toBe(1.75);
  });

  it("DTE 5 → min OTM 2.0% (second tier)", () => {
    expect(getEffectiveMinOTM(PROD_OTM_DTE_TABLE, 5, 1)).toBe(2.0);
  });

  it("DTE 7 → min OTM 2.0% (boundary, ≤ 7)", () => {
    expect(getEffectiveMinOTM(PROD_OTM_DTE_TABLE, 7, 1)).toBe(2.0);
  });

  it("DTE 10 → min OTM 2.5% (third tier)", () => {
    expect(getEffectiveMinOTM(PROD_OTM_DTE_TABLE, 10, 1)).toBe(2.5);
  });

  it("DTE 14 → min OTM 2.5% (boundary, ≤ 14)", () => {
    expect(getEffectiveMinOTM(PROD_OTM_DTE_TABLE, 14, 1)).toBe(2.5);
  });

  it("DTE 20 → min OTM 2.5% (beyond table, uses last row)", () => {
    expect(getEffectiveMinOTM(PROD_OTM_DTE_TABLE, 20, 1)).toBe(2.5);
  });

  it("empty table → uses fallback", () => {
    expect(getEffectiveMinOTM([], 5, 1.5)).toBe(1.5);
  });

  it("null table → uses fallback", () => {
    expect(getEffectiveMinOTM(null, 5, 1.5)).toBe(1.5);
  });

  it("single-row table applies to all DTEs", () => {
    const table = [{ max_dte: 14, min_otm_pct: 3.0 }];
    expect(getEffectiveMinOTM(table, 1, 1)).toBe(3.0);
    expect(getEffectiveMinOTM(table, 14, 1)).toBe(3.0);
  });

  it("unsorted table still works (sorts internally)", () => {
    const table = [
      { max_dte: 14, min_otm_pct: 2.5 },
      { max_dte: 3,  min_otm_pct: 1.75 },
      { max_dte: 7,  min_otm_pct: 2.0 },
    ];
    expect(getEffectiveMinOTM(table, 2, 1)).toBe(1.75);
    expect(getEffectiveMinOTM(table, 5, 1)).toBe(2.0);
    expect(getEffectiveMinOTM(table, 10, 1)).toBe(2.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FULL E2E: Simulate what market-refresh does for a single stock
// ═══════════════════════════════════════════════════════════════════════════════

describe("Full E2E: STO decision flow for a single stock", () => {

  function simulateStoDecision({ symbol, quote, priceHistory, trend, momentumFilters, otmDteTable, dte, otmPct }) {
    // Step 1: Momentum check (pullback, deceleration, gap)
    const momCfg = { ...momentumFilters };
    if (!momCfg.momentum_enabled && momCfg.require_decelerating) momCfg.momentum_enabled = true;
    const momentum = evaluateMomentum(symbol, quote, priceHistory, momCfg);
    if (!momentum.pass) return { action: "blocked", gate: "momentum", detail: momentum.reasons.filter(r => !r.startsWith("✓")) };

    // Step 2: Technical filters (RSI, trend, SMA)
    const techResult = evaluateTechnicalFilters(momentumFilters, trend);
    if (!techResult.pass) return { action: "blocked", gate: "technical", detail: techResult.reason };

    // Step 3: OTM-by-DTE check
    const effectiveMinOTM = getEffectiveMinOTM(otmDteTable, dte, 1.0);
    if (otmPct < effectiveMinOTM) return { action: "blocked", gate: "otm_dte", detail: `OTM ${otmPct}% < min ${effectiveMinOTM}% for DTE ${dte}` };

    return { action: "suggest", gate: null, detail: `STO ${symbol} ${otmPct}% OTM, ${dte} DTE` };
  }

  it("perfect setup → suggests STO", () => {
    const result = simulateStoDecision({
      symbol: "NVDA",
      quote: { lastPrice: 135.50, dayHigh: 136.20, openPrice: 133.90, changePct: 0.012 },
      priceHistory: [{ symbol: "NVDA", change_pct: 1.5, captured_at: new Date(Date.now() - 15 * 60000).toISOString() }],
      trend: { rsi14: 62, trend_regime: "bullish", sma_alignment: 2 },
      momentumFilters: PROD_MOMENTUM_FILTERS,
      otmDteTable: PROD_OTM_DTE_TABLE,
      dte: 3,
      otmPct: 2.0,
    });
    expect(result.action).toBe("suggest");
  });

  it("stock at high → blocked by momentum", () => {
    const result = simulateStoDecision({
      symbol: "AMZN",
      quote: { lastPrice: 272.80, dayHigh: 272.90, openPrice: 268.00, changePct: 0.018 },
      priceHistory: [{ symbol: "AMZN", change_pct: 1.2, captured_at: new Date(Date.now() - 15 * 60000).toISOString() }],
      trend: { rsi14: 65, trend_regime: "bullish", sma_alignment: 2 },
      momentumFilters: PROD_MOMENTUM_FILTERS,
      otmDteTable: PROD_OTM_DTE_TABLE,
      dte: 5,
      otmPct: 2.5,
    });
    expect(result.action).toBe("blocked");
    expect(result.gate).toBe("momentum");
  });

  it("RSI too high → blocked by technical", () => {
    const result = simulateStoDecision({
      symbol: "AMD",
      quote: { lastPrice: 170, dayHigh: 171, openPrice: 168, changePct: 0.012 },
      priceHistory: [{ symbol: "AMD", change_pct: 1.5, captured_at: new Date(Date.now() - 15 * 60000).toISOString() }],
      trend: { rsi14: 82, trend_regime: "bullish", sma_alignment: 3 },
      momentumFilters: PROD_MOMENTUM_FILTERS,
      otmDteTable: PROD_OTM_DTE_TABLE,
      dte: 7,
      otmPct: 3.0,
    });
    expect(result.action).toBe("blocked");
    expect(result.gate).toBe("technical");
  });

  it("OTM too tight for DTE → blocked by otm_dte", () => {
    const result = simulateStoDecision({
      symbol: "CAT",
      quote: { lastPrice: 420, dayHigh: 422, openPrice: 418, changePct: 0.005 },
      priceHistory: [{ symbol: "CAT", change_pct: 0.8, captured_at: new Date(Date.now() - 15 * 60000).toISOString() }],
      trend: { rsi14: 55, trend_regime: "neutral", sma_alignment: 1 },
      momentumFilters: PROD_MOMENTUM_FILTERS,
      otmDteTable: PROD_OTM_DTE_TABLE,
      dte: 10,       // DTE 10 → needs 2.5% OTM min
      otmPct: 1.8,   // only 1.8% OTM → too tight
    });
    expect(result.action).toBe("blocked");
    expect(result.gate).toBe("otm_dte");
    expect(result.detail).toContain("2.5%");
  });

  it("bearish trend → blocked by technical", () => {
    const result = simulateStoDecision({
      symbol: "UPS",
      quote: { lastPrice: 98, dayHigh: 99, openPrice: 97.5, changePct: 0.005 },
      priceHistory: [{ symbol: "UPS", change_pct: 0.8, captured_at: new Date(Date.now() - 15 * 60000).toISOString() }],
      trend: { rsi14: 40, trend_regime: "bearish", sma_alignment: 0 },
      momentumFilters: PROD_MOMENTUM_FILTERS,
      otmDteTable: PROD_OTM_DTE_TABLE,
      dte: 3,
      otmPct: 2.0,
    });
    expect(result.action).toBe("blocked");
    expect(result.gate).toBe("technical");
  });
});
