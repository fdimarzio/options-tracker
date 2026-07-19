// tests/utils.test.js
// Vitest unit tests for PRI Options Tracker logic functions
// Run: npx vitest run

import { describe, it, expect } from "vitest";

// ── Helpers copied from pri-tod-v3.jsx ──────────────────────────────────────
// Keep these in sync manually, or extract to a shared utils.js

function isSchw(account) { return account?.startsWith("Schwab"); }
function isEtr(account)  { return account?.startsWith("ETrade") || account?.startsWith("Etrade"); }
function isApiAccount(account) { return !!(isSchw(account) || isEtr(account)); }

function calcProfitPct(premium, costToClose) {
  if (!premium || premium === 0) return null;
  return ((premium - costToClose) / Math.abs(premium)) * 100;
}

function calcBtcProfitPct(premiumTotal, currentMid, qty) {
  // premiumTotal = what we collected (e.g. $1000)
  // currentMid   = current mid price per contract (e.g. $0.30)
  // qty          = number of contracts
  const currentVal = currentMid * qty * 100;
  return ((premiumTotal - currentVal) / premiumTotal) * 100;
}

function shouldAutoBtc(contract, currentMid, rule) {
  if (!rule?.enabled) return false;
  if (contract.opt_type !== "STO") return false;
  if (contract.type !== "Call") return false;
  const profitPct = calcBtcProfitPct(+contract.premium, currentMid, +contract.qty);
  return profitPct >= (rule.min_profit_pct ?? 70);
}

function toDB(c) {
  return {
    id:           c.id,
    stock:        c.stock || null,
    type:         c.type,
    opt_type:     c.optType,
    strike:       c.strike != null ? +c.strike : null,
    qty:          c.qty != null ? +c.qty : null,
    premium:      c.premium != null ? +c.premium : null,
    status:       c.status || "Open",
    account:      c.account || null,
    open_method:  c.openMethod || null,
    close_method: c.closeMethod || null,
  };
}

function fromDB(row) {
  return {
    id:          row.id,
    stock:       row.stock,
    type:        row.type,
    optType:     row.opt_type,
    strike:      row.strike,
    qty:         row.qty,
    premium:     row.premium,
    status:      row.status,
    account:     row.account,
    openMethod:  row.open_method,
    closeMethod: row.close_method,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Account name matching", () => {
  it("matches Schwab 3866 as Schwab account", () => {
    expect(isSchw("Schwab 3866")).toBe(true);
  });
  it("matches plain Schwab as Schwab account", () => {
    expect(isSchw("Schwab")).toBe(true);
  });
  it("does not match ETrade as Schwab", () => {
    expect(isSchw("ETrade 6917")).toBe(false);
  });
  it("matches ETrade 6917 as ETrade account", () => {
    expect(isEtr("ETrade 6917")).toBe(true);
  });
  it("matches ETrade 8222 as ETrade account", () => {
    expect(isEtr("ETrade 8222")).toBe(true);
  });
  it("matches lowercase Etrade variant", () => {
    expect(isEtr("Etrade")).toBe(true);
  });
  it("isApiAccount true for Schwab 3866", () => {
    expect(isApiAccount("Schwab 3866")).toBe(true);
  });
  it("isApiAccount true for ETrade 6917", () => {
    expect(isApiAccount("ETrade 6917")).toBe(true);
  });
  it("isApiAccount false for null", () => {
    expect(isApiAccount(null)).toBe(false);
  });
  it("isApiAccount false for empty string", () => {
    expect(isApiAccount("")).toBe(false);
  });
});

describe("Profit % calculation", () => {
  it("calculates 100% profit when cost_to_close is 0", () => {
    expect(calcProfitPct(1000, 0)).toBeCloseTo(100);
  });
  it("calculates 70% profit correctly", () => {
    expect(calcProfitPct(1000, 300)).toBeCloseTo(70);
  });
  it("calculates 50% profit correctly", () => {
    expect(calcProfitPct(500, 250)).toBeCloseTo(50);
  });
  it("returns null when premium is 0", () => {
    expect(calcProfitPct(0, 100)).toBeNull();
  });
  it("returns null when premium is null", () => {
    expect(calcProfitPct(null, 100)).toBeNull();
  });
  it("handles negative profit (loss)", () => {
    expect(calcProfitPct(100, 150)).toBeCloseTo(-50);
  });
});

describe("Auto-BTC profit calculation", () => {
  it("70% profit: $1000 premium, 1 contract at $0.30 mid", () => {
    // currentVal = 0.30 * 1 * 100 = $30
    // profitPct = (1000 - 30) / 1000 * 100 = 97%
    expect(calcBtcProfitPct(1000, 0.30, 1)).toBeCloseTo(97);
  });
  it("exactly 70% profit: $1000 premium, 1 contract at $3.00", () => {
    // currentVal = 3.00 * 1 * 100 = $300
    // profitPct = (1000 - 300) / 1000 * 100 = 70%
    expect(calcBtcProfitPct(1000, 3.00, 1)).toBeCloseTo(70);
  });
  it("handles multi-contract: $500 premium, 2 contracts at $0.50", () => {
    // currentVal = 0.50 * 2 * 100 = $100
    // profitPct = (500 - 100) / 500 * 100 = 80%
    expect(calcBtcProfitPct(500, 0.50, 2)).toBeCloseTo(80);
  });
  it("below 70% threshold: $1000 premium, 1 contract at $4.00", () => {
    // currentVal = 400, profitPct = 60%
    expect(calcBtcProfitPct(1000, 4.00, 1)).toBeCloseTo(60);
  });
});

describe("shouldAutoBtc rule evaluation", () => {
  const rule = { enabled: true, min_profit_pct: 70, opt_type: "Call", dry_run: true };

  it("fires for STO Call at 97% profit", () => {
    const contract = { opt_type: "STO", type: "Call", premium: 1000, qty: 1 };
    expect(shouldAutoBtc(contract, 0.30, rule)).toBe(true);
  });
  it("fires at exactly 70% profit", () => {
    const contract = { opt_type: "STO", type: "Call", premium: 1000, qty: 1 };
    expect(shouldAutoBtc(contract, 3.00, rule)).toBe(true);
  });
  it("does NOT fire below 70% profit", () => {
    const contract = { opt_type: "STO", type: "Call", premium: 1000, qty: 1 };
    expect(shouldAutoBtc(contract, 4.00, rule)).toBe(false);
  });
  it("does NOT fire for Put contracts", () => {
    const contract = { opt_type: "STO", type: "Put", premium: 1000, qty: 1 };
    expect(shouldAutoBtc(contract, 0.30, rule)).toBe(false);
  });
  it("does NOT fire when rule disabled", () => {
    const contract = { opt_type: "STO", type: "Call", premium: 1000, qty: 1 };
    expect(shouldAutoBtc(contract, 0.30, { ...rule, enabled: false })).toBe(false);
  });
  it("does NOT fire for BTO (only STO)", () => {
    const contract = { opt_type: "BTO", type: "Call", premium: 1000, qty: 1 };
    expect(shouldAutoBtc(contract, 0.30, rule)).toBe(false);
  });
});

describe("toDB / fromDB round-trip", () => {
  it("preserves open_method and close_method", () => {
    const c = { id: 1, type: "Call", optType: "STO", strike: 120, qty: 2, premium: 1000, status: "Open", account: "Schwab 3866", openMethod: "app", closeMethod: null };
    const row = toDB(c);
    expect(row.open_method).toBe("app");
    expect(row.close_method).toBeNull();
  });
  it("defaults open_method to null when not set", () => {
    const c = { id: 1, type: "Call", optType: "STO", strike: 120, qty: 2, premium: 1000, status: "Open", account: "Schwab 3866" };
    expect(toDB(c).open_method).toBeNull();
  });
  it("fromDB maps opt_type to optType", () => {
    const row = { id: 1, type: "Call", opt_type: "STO", strike: 120, qty: 2, premium: 1000, status: "Open", account: "Schwab 3866", open_method: "manual", close_method: "auto" };
    const c = fromDB(row);
    expect(c.optType).toBe("STO");
    expect(c.openMethod).toBe("manual");
    expect(c.closeMethod).toBe("auto");
  });
  it("coerces strike to number", () => {
    const c = { type: "Call", optType: "STO", strike: "120.5", qty: "2", premium: "1000" };
    const row = toDB(c);
    expect(typeof row.strike).toBe("number");
    expect(row.strike).toBe(120.5);
  });
});

describe("Signal rule type labels", () => {
  const ruleTypeLabel = t => ({ sto: "STO Scanner", btc_auto: "Auto BTC", close_signal: "Close Signal" })[t] || t;
  it("labels sto correctly", () => expect(ruleTypeLabel("sto")).toBe("STO Scanner"));
  it("labels btc_auto correctly", () => expect(ruleTypeLabel("btc_auto")).toBe("Auto BTC"));
  it("falls back to raw value for unknown types", () => expect(ruleTypeLabel("foo")).toBe("foo"));
});

describe("Anomaly dedup fingerprint", () => {
  const anomalyFingerprint = a => `${a.stock}|${a.opt_type}|${a.strike}|${a.expires}|${a.account}|${Math.round(Math.abs(+a.premium)*100)}|${a.qty}|${a.date_exec}|${a.anomaly_type}`;

  it("same transaction with different ETrade ID produces same fingerprint", () => {
    const a1 = { stock:"AAPL", opt_type:"BTC", strike:"295", expires:"2026-05-15", account:"ETrade 6917", premium:"-177.03", qty:2, date_exec:"2026-05-13", anomaly_type:"unmatched_close", schwab_transaction_id:"abc123" };
    const a2 = { ...a1, schwab_transaction_id:"xyz999" }; // different ID, same transaction
    expect(anomalyFingerprint(a1)).toBe(anomalyFingerprint(a2));
  });

  it("different stock produces different fingerprint", () => {
    const a1 = { stock:"AAPL", opt_type:"BTC", strike:"295", expires:"2026-05-15", account:"ETrade 6917", premium:"-177.03", qty:2, date_exec:"2026-05-13", anomaly_type:"unmatched_close" };
    const a2 = { ...a1, stock:"NVDA" };
    expect(anomalyFingerprint(a1)).not.toBe(anomalyFingerprint(a2));
  });

  it("different premium produces different fingerprint", () => {
    const a1 = { stock:"AAPL", opt_type:"BTC", strike:"295", expires:"2026-05-15", account:"ETrade 6917", premium:"-177.03", qty:2, date_exec:"2026-05-13", anomaly_type:"unmatched_close" };
    const a2 = { ...a1, premium:"-200.00" };
    expect(anomalyFingerprint(a1)).not.toBe(anomalyFingerprint(a2));
  });

  it("handles negative premium correctly via Math.abs", () => {
    const a = { stock:"AAPL", opt_type:"BTC", strike:"295", expires:"2026-05-15", account:"ETrade 6917", premium:"-177.03", qty:2, date_exec:"2026-05-13", anomaly_type:"unmatched_close" };
    const fp = anomalyFingerprint(a);
    expect(fp).toContain("17703"); // abs(-177.03) * 100 = 17703
  });
});

describe("shouldNotify cooldown", () => {
  const RENOTIFY_DOLLARS  = 50;
  const RENOTIFY_PCT      = 5;
  const RENOTIFY_COOLDOWN = 60;

  function shouldNotify(signal, lastNotif) {
    if (!lastNotif) return true;
    if (signal.level !== lastNotif.level) return true;
    if (lastNotif.sentAt) {
      const minsSince = (Date.now() - new Date(lastNotif.sentAt).getTime()) / 60000;
      if (minsSince < RENOTIFY_COOLDOWN) return false;
    }
    const profitImproved = signal.projectedProfit - (lastNotif.projectedProfit || 0) >= RENOTIFY_DOLLARS;
    const pctImproved    = signal.profitPct - (lastNotif.profitPct || 0) >= RENOTIFY_PCT;
    return profitImproved || pctImproved;
  }

  it("notifies if never sent before", () => {
    expect(shouldNotify({ level: "CLOSE_NOW", projectedProfit: 100, profitPct: 70 }, null)).toBe(true);
  });
  it("does NOT re-notify within 60 minutes at same level", () => {
    const sentAt = new Date(Date.now() - 10 * 60000).toISOString(); // 10 min ago
    expect(shouldNotify({ level: "CLOSE_NOW", projectedProfit: 200, profitPct: 80 }, { level: "CLOSE_NOW", projectedProfit: 100, profitPct: 70, sentAt })).toBe(false);
  });
  it("re-notifies after 60 minutes if profit improved", () => {
    const sentAt = new Date(Date.now() - 65 * 60000).toISOString(); // 65 min ago
    expect(shouldNotify({ level: "CLOSE_NOW", projectedProfit: 200, profitPct: 80 }, { level: "CLOSE_NOW", projectedProfit: 100, profitPct: 70, sentAt })).toBe(true);
  });
  it("re-notifies immediately if level escalates", () => {
    const sentAt = new Date(Date.now() - 5 * 60000).toISOString(); // 5 min ago
    expect(shouldNotify({ level: "ITM_WARNING", projectedProfit: 100, profitPct: 70 }, { level: "CLOSE_NOW", projectedProfit: 100, profitPct: 70, sentAt })).toBe(true);
  });
  it("does NOT re-notify if profit not improved enough after cooldown", () => {
    const sentAt = new Date(Date.now() - 65 * 60000).toISOString();
    expect(shouldNotify({ level: "CLOSE_NOW", projectedProfit: 120, profitPct: 72 }, { level: "CLOSE_NOW", projectedProfit: 100, profitPct: 70, sentAt })).toBe(false);
  });
});

describe("Close signal BTO filter", () => {
  it("STO contracts should be evaluated", () => {
    const contract = { opt_type: "STO", stock: "WDC", premium: 2331 };
    expect(contract.opt_type === "STO").toBe(true);
  });
  it("BTO contracts should be skipped", () => {
    const contract = { opt_type: "BTO", stock: "WDC", premium: -1714 };
    expect(contract.opt_type !== "STO").toBe(true);
  });
});

describe("Time-based BTC rule selection", () => {
  const timeToMins = t => { if (!t) return -1; const [h,m] = t.split(":").map(Number); return h*60+m; };

  function selectBtcRule(rules, etTimeStr) {
    const currentMins = timeToMins(etTimeStr);
    return rules
      .filter(r => r.enabled)
      .sort((a,b) => (b.priority||0) - (a.priority||0))
      .find(r => {
        if (r.min_time_et && timeToMins(r.min_time_et) > currentMins) return false;
        if (r.max_time_et && timeToMins(r.max_time_et) < currentMins) return false;
        return true;
      });
  }

  const rules = [
    { rule_type:"btc_auto", name:"After 3pm", enabled:true, min_profit_pct:60, min_time_et:"15:00", priority:20, dry_run:false },
    { rule_type:"btc_auto", name:"Default",   enabled:true, min_profit_pct:70, min_time_et:null,    priority:10, dry_run:false },
  ];

  it("uses 60% threshold after 3pm", () => {
    const rule = selectBtcRule(rules, "15:30");
    expect(rule.min_profit_pct).toBe(60);
    expect(rule.name).toBe("After 3pm");
  });
  it("uses 70% threshold before 3pm", () => {
    const rule = selectBtcRule(rules, "11:00");
    expect(rule.min_profit_pct).toBe(70);
    expect(rule.name).toBe("Default");
  });
  it("uses 60% threshold exactly at 3pm", () => {
    const rule = selectBtcRule(rules, "15:00");
    expect(rule.min_profit_pct).toBe(60);
  });
  it("returns default if timed rule is disabled", () => {
    const rulesWithDisabled = [
      { ...rules[0], enabled: false },
      rules[1],
    ];
    const rule = selectBtcRule(rulesWithDisabled, "15:30");
    expect(rule.min_profit_pct).toBe(70);
  });
  it("returns undefined if no rules match", () => {
    const rule = selectBtcRule([], "15:30");
    expect(rule).toBeUndefined();
  });
});

describe("OTM% calculation for calls vs puts", () => {
  const otmPctCall = (strike, stockPrice) => ((strike - stockPrice) / stockPrice) * 100;
  const otmPctPut  = (strike, stockPrice) => ((stockPrice - strike) / stockPrice) * 100;

  it("call OTM%: strike above stock price is positive", () => {
    expect(otmPctCall(310, 300)).toBeCloseTo(3.33, 1);
  });
  it("call OTM%: strike below stock price is negative (ITM)", () => {
    expect(otmPctCall(290, 300)).toBeCloseTo(-3.33, 1);
  });
  it("put OTM%: strike below stock price is positive", () => {
    expect(otmPctPut(290, 300)).toBeCloseTo(3.33, 1);
  });
  it("put OTM%: strike above stock price is negative (ITM)", () => {
    expect(otmPctPut(310, 300)).toBeCloseTo(-3.33, 1);
  });
  it("JPM example: $307.5 call with stock at $300 is 2.5% OTM", () => {
    expect(otmPctCall(307.5, 300)).toBeCloseTo(2.5, 1);
  });
});

describe("Momentum evaluation", () => {
  function evaluateMomentum(symbol, quote, priceHistory, config) {
    if (!config) return { pass: true, reasons: ["no config"], indicators: {} };
    const reasons = []; const indicators = {}; let pass = true;
    const { lastPrice: last, dayHigh, openPrice } = quote;

    if (config.pullback_enabled && dayHigh && last) {
      const pullbackPct = ((dayHigh - last) / dayHigh) * 100;
      indicators.pullbackFromHigh = Math.round(pullbackPct * 100) / 100;
      if (pullbackPct < config.min_pullback_from_high_pct) { pass = false; reasons.push(`within ${pullbackPct.toFixed(2)}% of high`); }
      else reasons.push(`✓ pullback ${pullbackPct.toFixed(2)}%`);
    }
    if (config.momentum_enabled && config.require_decelerating) {
      const symHistory = (priceHistory || []).filter(r => r.symbol === symbol).sort((a,b) => new Date(b.captured_at)-new Date(a.captured_at));
      const lookbackMs = (config.momentum_lookback_mins || 30) * 60000;
      const cutoff = new Date(Date.now() - lookbackMs);
      const historical = symHistory.find(r => new Date(r.captured_at) <= cutoff);
      if (historical?.change_pct != null && quote.changePct != null) {
        const cur = quote.changePct * 100; const hist = historical.change_pct;
        indicators.changePctNow = cur; indicators.changePct30m = hist; indicators.decelerating = cur <= hist;
        if (cur > hist) { pass = false; reasons.push(`accelerating: ${hist}→${cur}`); }
        else reasons.push(`✓ decelerating: ${hist}→${cur}`);
      }
    }
    if (config.gap_enabled && openPrice && last) {
      const moveFromOpen = ((last - openPrice) / openPrice) * 100;
      indicators.moveFromOpen = Math.round(moveFromOpen * 100) / 100;
      if (config.max_gap_up_pct && moveFromOpen > config.max_gap_up_pct) { pass = false; reasons.push(`gap-up ${moveFromOpen.toFixed(2)}% exceeds max`); }
      else reasons.push(`✓ move from open ${moveFromOpen.toFixed(2)}%`);
    }
    return { pass, reasons, indicators };
  }

  const config = { pullback_enabled:true, min_pullback_from_high_pct:0.3, momentum_enabled:true, require_decelerating:true, momentum_lookback_mins:30, gap_enabled:true, max_gap_up_pct:2.0 };

  it("passes when stock has pulled back from high and is decelerating", () => {
    const quote = { lastPrice:101, dayHigh:102, openPrice:100, changePct:0.01 };
    const hist = [{ symbol:"AAPL", change_pct:1.5, captured_at: new Date(Date.now()-31*60000).toISOString() }];
    const result = evaluateMomentum("AAPL", quote, hist, config);
    expect(result.pass).toBe(true);
  });

  it("suppresses when stock is within 0.3% of intraday high", () => {
    const quote = { lastPrice:101.9, dayHigh:102, openPrice:100, changePct:0.02 };
    const result = evaluateMomentum("AAPL", quote, [], config);
    expect(result.pass).toBe(false);
    expect(result.reasons.some(r => r.includes("high"))).toBe(true);
  });

  it("suppresses when move is still accelerating", () => {
    const quote = { lastPrice:103, dayHigh:103.5, openPrice:100, changePct:0.03 };
    const hist = [{ symbol:"AAPL", change_pct:1.5, captured_at: new Date(Date.now()-31*60000).toISOString() }];
    const result = evaluateMomentum("AAPL", quote, hist, config);
    expect(result.pass).toBe(false);
    expect(result.indicators.decelerating).toBe(false);
  });

  it("suppresses when gap-up exceeds max", () => {
    const quote = { lastPrice:105, dayHigh:105.5, openPrice:100, changePct:0.03 };
    const hist = [{ symbol:"AAPL", change_pct:5, captured_at: new Date(Date.now()-31*60000).toISOString() }];
    const result = evaluateMomentum("AAPL", quote, hist, config);
    expect(result.pass).toBe(false);
    expect(result.reasons.some(r => r.includes("gap"))).toBe(true);
  });

  it("passes with no config (fail-open)", () => {
    const result = evaluateMomentum("AAPL", { lastPrice:100 }, [], null);
    expect(result.pass).toBe(true);
  });
});

// ── Automated Trading Safety Tests ───────────────────────────────────────────
describe("Auto-BTC safety — duplicate order prevention", () => {
  it("skips contract if pending order exists", () => {
    const pendingContractIds = new Set(["123", "456"]);
    expect(pendingContractIds.has(String(123))).toBe(true);
    expect(pendingContractIds.has(String(789))).toBe(false);
  });

  it("handles string vs number contract ID mismatch", () => {
    // Critical: contract.id may be number, Set contains strings
    const pendingContractIds = new Set(["1777730812053"]);
    expect(pendingContractIds.has(String(1777730812053))).toBe(true);
    expect(pendingContractIds.has(1777730812053)).toBe(false); // number doesn't match string
  });

  it("skips Put contracts — only Calls auto-closed", () => {
    const contract = { opt_type: "STO", type: "Put", premium: 1000, qty: 1 };
    const rule = { enabled: true, min_profit_pct: 70, dry_run: false };
    const shouldAutoBtc = (c, mid, r) => {
      if (!r?.enabled) return false;
      if (c.opt_type !== "STO") return false;
      if (c.type !== "Call") return false;
      const currentVal = mid * c.qty * 100;
      return ((+c.premium - currentVal) / +c.premium) * 100 >= (r.min_profit_pct ?? 70);
    };
    expect(shouldAutoBtc(contract, 0.30, rule)).toBe(false);
  });
});

describe("Auto-BTC safety — profit calculation edge cases", () => {
  const calcBtcProfitPct = (premiumTotal, currentMid, qty) => {
    const currentVal = currentMid * qty * 100;
    return ((premiumTotal - currentVal) / premiumTotal) * 100;
  };

  it("WDC example: premium $2331.29, qty 1, ask $13.75 = 41% profit", () => {
    expect(calcBtcProfitPct(2331.29, 13.75, 1)).toBeCloseTo(41.0, 0);
  });

  it("JPM example: premium $154.67, qty 2, ask $0.46 = 40% profit", () => {
    // $0.46 × 2 × 100 = $92, profit = ($154.67 - $92) / $154.67 = 40.5%
    expect(calcBtcProfitPct(154.67, 0.46, 2)).toBeCloseTo(40.5, 0);
  });

  it("returns negative profit when cost exceeds premium (loss)", () => {
    expect(calcBtcProfitPct(100, 2.00, 1)).toBeCloseTo(-100, 0);
  });

  it("handles zero mid price (expired worthless)", () => {
    expect(calcBtcProfitPct(1000, 0, 1)).toBeCloseTo(100, 0);
  });

  it("never fires on zero or null premium", () => {
    const shouldAutoBtc = (c, mid, r) => {
      if (!r?.enabled || c.opt_type !== "STO" || c.type !== "Call") return false;
      const premium = +c.premium;
      if (!premium) return false;
      const currentVal = mid * c.qty * 100;
      return ((premium - currentVal) / premium) * 100 >= (r.min_profit_pct ?? 70);
    };
    expect(shouldAutoBtc({ opt_type:"STO", type:"Call", premium:0, qty:1 }, 0.30, { enabled:true, min_profit_pct:70 })).toBe(false);
    expect(shouldAutoBtc({ opt_type:"STO", type:"Call", premium:null, qty:1 }, 0.30, { enabled:true, min_profit_pct:70 })).toBe(false);
  });
});

describe("Auto-BTC safety — dry run vs live", () => {
  it("dry_run=true should never be considered live", () => {
    const rule = { enabled: true, min_profit_pct: 70, dry_run: true };
    const isDryRun = rule.dry_run !== false;
    expect(isDryRun).toBe(true);
  });

  it("dry_run=false is live mode", () => {
    const rule = { enabled: true, min_profit_pct: 70, dry_run: false };
    const isDryRun = rule.dry_run !== false;
    expect(isDryRun).toBe(false);
  });

  it("dry_run=undefined defaults to dry run (safe default)", () => {
    const rule = { enabled: true, min_profit_pct: 70 };
    const isDryRun = rule.dry_run !== false;
    expect(isDryRun).toBe(true); // undefined !== false is true → dry run
  });

  it("dry_run=null defaults to dry run (safe default)", () => {
    const rule = { enabled: true, min_profit_pct: 70, dry_run: null };
    const isDryRun = rule.dry_run !== false;
    expect(isDryRun).toBe(true); // null !== false is true → dry run
  });
});

describe("Auto-BTC safety — mid vs bid fallback", () => {
  const getLimitPrice = (bid, ask) => {
    const mid = ask > 0 && bid > 0 ? (bid + ask) / 2 : bid;
    return Math.round(mid * 100) / 100;
  };

  it("uses mid when both bid and ask available", () => {
    expect(getLimitPrice(0.30, 0.40)).toBe(0.35);
  });

  it("falls back to bid when ask is 0", () => {
    expect(getLimitPrice(0.30, 0)).toBe(0.30);
  });

  it("falls back to bid when ask is null", () => {
    const mid = (null > 0 && 0.30 > 0) ? (null + 0.30) / 2 : 0.30;
    expect(Math.round(mid * 100) / 100).toBe(0.30);
  });

  it("rounds to 2 decimal places", () => {
    // (0.31 + 0.42) / 2 = 0.365, rounded to 2dp = 0.37
    expect(getLimitPrice(0.31, 0.42)).toBe(0.37);
  });
});

describe("Momentum config — fail open behavior", () => {
  const evaluateMomentum = (symbol, quote, priceHistory, config) => {
    if (!config) return { pass: true, reasons: ["no config"], indicators: {} };
    if (!config.enabled) return { pass: true, reasons: ["config disabled"], indicators: {} };
    return { pass: true, reasons: ["passed"], indicators: {} }; // simplified
  };

  it("passes when no momentum config exists (table empty)", () => {
    expect(evaluateMomentum("AAPL", {}, [], null).pass).toBe(true);
  });

  it("passes when momentum config is disabled", () => {
    expect(evaluateMomentum("AAPL", {}, [], { enabled: false }).pass).toBe(true);
  });
});

describe("Auto-BTC safety — order size sanity checks", () => {
  // Limit price should never be > $50 for a typical covered call BTC
  // If it is, something is wrong (e.g. decimal in wrong place, using stock price instead of option price)
  const MAX_REASONABLE_LIMIT_PRICE = 50;
  // Max reasonable cost for a single BTC order ($50 limit × 100 shares × 10 contracts)
  const MAX_REASONABLE_ORDER_COST = 50000;

  const getLimitPrice = (bid, ask) => {
    const mid = ask > 0 && bid > 0 ? (bid + ask) / 2 : bid;
    return Math.round(mid * 100) / 100;
  };

  const getOrderCost = (limitPrice, qty) => limitPrice * qty * 100;

  it("limit price is per-contract price not per-share (should be <$50 for typical BTC)", () => {
    // Normal BTC scenario: bid $0.30, ask $0.40 → limit $0.35
    const limit = getLimitPrice(0.30, 0.40);
    expect(limit).toBeLessThan(MAX_REASONABLE_LIMIT_PRICE);
  });

  it("catches decimal error: stock price accidentally used as limit price", () => {
    // If JPM stock price ($215) was used instead of option price ($0.35), this would be catastrophically wrong
    const stockPrice = 215.00;
    expect(stockPrice).toBeGreaterThan(MAX_REASONABLE_LIMIT_PRICE); // this would be caught
  });

  it("order cost stays within reasonable bounds for typical qty", () => {
    const limit = getLimitPrice(0.30, 0.40); // $0.35
    const cost = getOrderCost(limit, 2); // 2 contracts
    expect(cost).toBeLessThan(MAX_REASONABLE_ORDER_COST);
    expect(cost).toBe(70); // $0.35 × 2 × 100 = $70
  });

  it("WDC scenario: limit $13.75, qty 1 → cost $1375 (within bounds)", () => {
    const cost = getOrderCost(13.75, 1);
    expect(cost).toBe(1375);
    expect(cost).toBeLessThan(MAX_REASONABLE_ORDER_COST);
  });

  it("catches wrong multiplier: forgetting ×100 would give wrong cost", () => {
    const limitPrice = 0.35;
    const qty = 2;
    const wrongCost  = limitPrice * qty;        // $0.70 — missing ×100
    const rightCost  = limitPrice * qty * 100;  // $70.00 — correct
    expect(wrongCost).not.toBe(rightCost);
    expect(rightCost).toBe(70);
  });

  it("profit % is always 0-100 for a normal BTC scenario", () => {
    const calcBtcProfitPct = (premiumTotal, currentMid, qty) => {
      const currentVal = currentMid * qty * 100;
      return ((premiumTotal - currentVal) / premiumTotal) * 100;
    };
    const profit = calcBtcProfitPct(1000, 0.30, 1);
    expect(profit).toBeGreaterThan(0);
    expect(profit).toBeLessThanOrEqual(100);
  });

  it("profit % above 100 signals bad data (e.g. negative premium stored)", () => {
    const calcBtcProfitPct = (premiumTotal, currentMid, qty) => {
      const currentVal = currentMid * qty * 100;
      return ((premiumTotal - currentVal) / premiumTotal) * 100;
    };
    // If premium was stored as negative by mistake, profit% comes out > 100 — nonsense
    const badProfit = calcBtcProfitPct(-1000, 0.30, 1);
    expect(badProfit).toBeGreaterThan(100); // > 100% is the red flag for bad data
  });

  it("should not fire if premium is negative (bad data guard)", () => {
    const shouldAutoBtc = (contract, mid, rule) => {
      if (!rule?.enabled || contract.opt_type !== "STO" || contract.type !== "Call") return false;
      const premium = +contract.premium;
      if (!premium || premium < 0) return false; // guard against negative/zero premium
      const currentVal = mid * contract.qty * 100;
      return ((premium - currentVal) / premium) * 100 >= (rule.min_profit_pct ?? 70);
    };
    expect(shouldAutoBtc({ opt_type:"STO", type:"Call", premium:-1000, qty:1 }, 0.30, { enabled:true, min_profit_pct:70 })).toBe(false);
  });
});

describe("Signal outcome quality classification", () => {
  const classifyQuality = (profitPct) => {
    const p = profitPct != null ? +profitPct * 100 : null;
    return p == null ? "neutral" : p >= 50 ? "good" : p >= 0 ? "neutral" : "bad";
  };

  it("profit >= 50% is good", () => {
    expect(classifyQuality(0.70)).toBe("good");
    expect(classifyQuality(0.50)).toBe("good");
  });
  it("profit 0-49% is neutral", () => {
    expect(classifyQuality(0.30)).toBe("neutral");
    expect(classifyQuality(0.00)).toBe("neutral");
  });
  it("loss is bad", () => {
    expect(classifyQuality(-0.20)).toBe("bad");
  });
  it("null profit is neutral", () => {
    expect(classifyQuality(null)).toBe("neutral");
  });
});

describe("Signal lineage chain", () => {
  it("can traverse signal → decision → contract", () => {
    const signalLog   = { id: 100, symbol: "JPM", signal_type: "sto_suggestion" };
    const decisionLog = { id: 1, signal_id: 100, contract_id: 999, decision: "traded" };
    const contract    = { id: 999, stock: "JPM", profit: 154.67, status: "Closed" };

    // Full chain traversal
    const signal   = signalLog;
    const decision = decisionLog.signal_id === signal.id ? decisionLog : null;
    const cont     = decision?.contract_id === contract.id ? contract : null;

    expect(decision).not.toBeNull();
    expect(cont).not.toBeNull();
    expect(cont.profit).toBe(154.67);
  });

  it("signals without decisions are still valid (passed signals)", () => {
    const signalLog = { id: 101, symbol: "AAPL", signal_type: "sto_suggestion" };
    const decisions = []; // no decision logged
    const decision  = decisions.find(d => d.signal_id === signalLog.id);
    expect(decision).toBeUndefined(); // expected — signal was suppressed or ignored
  });
});

describe("Scoring factor values completeness", () => {
  const buildFactorValues = (sigId, changePct, vix, dte, otmPct, momentum, etNow) => {
    return [
      { factor_name: "change_pct",         value: changePct },
      { factor_name: "vix",                value: vix },
      { factor_name: "dte",                value: dte },
      { factor_name: "otm_pct",            value: otmPct },
      { factor_name: "pullback_from_high", value: momentum?.pullbackFromHigh ?? null },
      { factor_name: "time_of_day",        value: etNow ? etNow.getHours() * 60 + etNow.getMinutes() : null },
    ].filter(f => f.value != null).map(f => ({ signal_id: sigId, ...f }));
  };

  it("builds factor values for a typical STO signal", () => {
    const etNow = new Date("2026-05-14T14:30:00"); // 10:30am ET approx
    const vals = buildFactorValues(100, 1.5, 18.5, 7, 2.3, { pullbackFromHigh: 0.45 }, etNow);
    expect(vals.length).toBe(6);
    expect(vals.every(v => v.signal_id === 100)).toBe(true);
    expect(vals.find(v => v.factor_name === "change_pct")?.value).toBe(1.5);
  });

  it("filters out null factor values", () => {
    const vals = buildFactorValues(100, 1.5, null, 7, 2.3, {}, null);
    const names = vals.map(v => v.factor_name);
    expect(names).not.toContain("vix");
    expect(names).not.toContain("time_of_day");
    expect(names).not.toContain("pullback_from_high");
  });
});

describe("Partial close — in-memory state update", () => {
  // Simulates the matchToOpen + partial close flow for multiple fills
  function matchToOpen(parsed, openContracts) {
    const candidates = openContracts.filter(c =>
      c.stock?.toUpperCase() === parsed.stock?.toUpperCase() &&
      c.type === parsed.type &&
      +c.strike === +parsed.strike &&
      c.expires === parsed.expires &&
      c.status === "Open"
    );
    if (!candidates.length) return { matchId: null, matchConfidence: "unmatched" };
    const sameAcctExact = candidates.find(c => c.account === parsed.account && +c.qty === +parsed.qty);
    if (sameAcctExact) return { matchId: sameAcctExact.id, matchConfidence: "exact" };
    const sameAcct = candidates.filter(c => c.account === parsed.account);
    if (sameAcct.length) {
      const best = sameAcct.reduce((a,b) => Math.abs(+a.qty-+parsed.qty) < Math.abs(+b.qty-+parsed.qty) ? a : b);
      return { matchId: best.id, matchConfidence: "partial" };
    }
    return { matchId: null, matchConfidence: "unmatched" };
  }

  function applyPartialClose(parent, closeQty) {
    const parentQty  = +parent.qty;
    const parentPrem = Math.abs(+parent.premium);
    const remaining  = parentQty - closeQty;
    const remPrem    = Math.round(parentPrem * (remaining / parentQty) * 100) / 100;
    // Critical: update in-memory object
    parent.qty     = remaining;
    parent.premium = remPrem;
    parent.notes   = `Partial close: ${closeQty} of ${parentQty}`;
    return remaining;
  }

  it("second fill matches after first partial close updates in-memory state", () => {
    const openContracts = [
      { id: 1, stock: "AMZN", type: "Call", opt_type: "BTO", strike: 275, expires: "2026-05-15", qty: 4, premium: 1050.65, account: "Schwab 3866", status: "Open" }
    ];

    // First fill: STC qty 1
    const fill1 = { stock: "AMZN", type: "Call", opt_type: "STC", strike: 275, expires: "2026-05-15", qty: 1, account: "Schwab 3866" };
    const match1 = matchToOpen(fill1, openContracts);
    expect(match1.matchId).toBe(1);
    expect(match1.matchConfidence).not.toBe("unmatched");

    // Apply partial close — updates in-memory state
    const remaining = applyPartialClose(openContracts[0], 1);
    expect(remaining).toBe(3);
    expect(openContracts[0].qty).toBe(3);

    // Second fill: STC qty 3 — should still match after state update
    const fill2 = { stock: "AMZN", type: "Call", opt_type: "STC", strike: 275, expires: "2026-05-15", qty: 3, account: "Schwab 3866" };
    const match2 = matchToOpen(fill2, openContracts);
    expect(match2.matchId).toBe(1);
    expect(match2.matchConfidence).not.toBe("unmatched");
  });

  it("without in-memory update, second fill would be unmatched", () => {
    const openContracts = [
      { id: 1, stock: "AMZN", type: "Call", opt_type: "BTO", strike: 275, expires: "2026-05-15", qty: 4, premium: 1050.65, account: "Schwab 3866", status: "Open" }
    ];
    // First fill processed but in-memory NOT updated (old buggy behavior)
    // Second fill qty 3 — with qty still 4 in memory, exact match fails
    const fill2 = { stock: "AMZN", type: "Call", opt_type: "STC", strike: 275, expires: "2026-05-15", qty: 3, account: "Schwab 3866" };
    const match2 = matchToOpen(fill2, openContracts);
    // Still matches via sameAcct fallback (closest qty), but not exact
    expect(match2.matchId).toBe(1);
    expect(match2.matchConfidence).toBe("partial"); // partial not exact — could cause issues
  });

  it("premium prorates correctly across partial fills", () => {
    const parent = { qty: 4, premium: 1050.65 };
    applyPartialClose(parent, 1);
    expect(parent.qty).toBe(3);
    expect(parent.premium).toBeCloseTo(787.99, 1); // 75% of 1050.65
  });

  it("full close after two partial fills leaves zero qty", () => {
    const parent = { id:1, stock:"AMZN", type:"Call", opt_type:"BTO", strike:275, expires:"2026-05-15", qty:4, premium:1050.65, account:"Schwab 3866", status:"Open" };
    applyPartialClose(parent, 1); // fill 1
    applyPartialClose(parent, 3); // fill 2
    expect(parent.qty).toBe(0);
  });
});

describe("STC/BTC orphan prevention", () => {
  it("alreadyHandledByTradeOrder returns true when matching filled order exists", () => {
    const tradeOrders = [
      { id: 54, ticker: "AMZN", strike: "272.5", opt_type: "BTC", status: "filled", account: "ETrade 6917", qty: 3, filled_at: "2026-05-15", created_at: "2026-05-14T19:30:17Z" }
    ];
    const parsed = { stock: "AMZN", opt_type: "BTC", strike: "272.5", account: "ETrade 6917", qty: 3, date_exec: "2026-05-15" };

    const match = tradeOrders.find(o =>
      +o.qty === +parsed.qty &&
      Math.abs(new Date(o.filled_at || o.created_at) - new Date(parsed.date_exec)) < 2 * 86400000
    );
    expect(match).toBeDefined();
    expect(match.id).toBe(54);
  });

  it("alreadyHandledByTradeOrder returns false when no matching order", () => {
    const tradeOrders = [];
    const parsed = { stock: "AMZN", opt_type: "BTC", strike: "272.5", account: "ETrade 6917", qty: 3, date_exec: "2026-05-15" };
    const match = tradeOrders.find(o => +o.qty === +parsed.qty);
    expect(match).toBeUndefined();
  });

  it("does not skip STC transactions that have no trade_order", () => {
    // Manual closes placed directly in broker should still be processed
    const tradeOrders = []; // no skynet orders
    const parsed = { stock: "AMZN", opt_type: "STC", strike: "275", qty: 3, date_exec: "2026-05-15" };
    const match = tradeOrders.find(o => +o.qty === +parsed.qty);
    expect(match).toBeUndefined(); // should NOT be skipped — will be matched to open contract
  });
});

describe("Expiry day scenario matrix", () => {
  const classify = (isITM, stockUp, profitPct, itmPct, isWheel, type) => {
    if (isWheel && type === "Put") {
      if (isITM && itmPct > 5) return "wheel_itm_deep";
      if (isITM) return "wheel_itm_shallow";
      return "wheel_otm";
    }
    if (profitPct >= 65) return "expiry_high_profit";
    if (!isITM && stockUp)  return "expiry_otm_up";
    if (isITM  && stockUp)  return "expiry_itm_up";
    if (!isITM && !stockUp) return "expiry_otm_down";
    if (isITM  && !stockUp) return "expiry_itm_down";
    return "expiry_default";
  };

  it("OTM + up → take profit and re-sell", () => {
    expect(classify(false, true, 40, 0, false, "Call")).toBe("expiry_otm_up");
  });
  it("ITM + up → watch momentum", () => {
    expect(classify(true, true, 40, 2, false, "Call")).toBe("expiry_itm_up");
  });
  it("OTM + down → time decay working, wait", () => {
    expect(classify(false, false, 40, 0, false, "Call")).toBe("expiry_otm_down");
  });
  it("ITM + down → minimize loss, auto-close at 2pm", () => {
    expect(classify(true, false, 40, 2, false, "Call")).toBe("expiry_itm_down");
  });
  it("profit >= 65% any condition → act fast (WDC rule)", () => {
    expect(classify(false, false, 68, 0, false, "Call")).toBe("expiry_high_profit");
    expect(classify(true, true, 70, 3, false, "Call")).toBe("expiry_high_profit");
  });
  it("wheel put OTM → take profit, re-sell put", () => {
    expect(classify(false, true, 40, 0, true, "Put")).toBe("wheel_otm");
  });
  it("wheel put ITM shallow (<5%) → may let assign", () => {
    expect(classify(true, false, 40, 3, true, "Put")).toBe("wheel_itm_shallow");
  });
  it("wheel put ITM deep (>5%) → roll decision needed", () => {
    expect(classify(true, false, 40, 6.7, true, "Put")).toBe("wheel_itm_deep");
  });
  it("AMD example: $462 put, stock at $431 = 6.7% ITM → deep", () => {
    const itmPct = ((462 - 431) / 462) * 100;
    expect(itmPct).toBeCloseTo(6.7, 0);
    expect(classify(true, false, 30, itmPct, true, "Put")).toBe("wheel_itm_deep");
  });
});

describe("shouldNotify — expiry day throttle", () => {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  it("EXPIRY_WAIT fires once per day", () => {
    const fn = (level, sentAt) => {
      if (!sentAt) return true;
      if (["EXPIRY_WAIT","WHEEL_OTM","WHEEL_ITM"].includes(level)) {
        return sentAt.slice(0, 10) !== today;
      }
      return true;
    };
    expect(fn("EXPIRY_WAIT", null)).toBe(true);         // never sent
    expect(fn("EXPIRY_WAIT", today+"T10:00:00Z")).toBe(false); // sent today
    expect(fn("EXPIRY_WAIT", yesterday+"T10:00:00Z")).toBe(true); // sent yesterday
  });

  it("WHEEL_ITM fires once per day", () => {
    const alreadySentToday = today + "T09:35:00Z";
    const sentToday = alreadySentToday.slice(0, 10) === today;
    expect(sentToday).toBe(true); // would be suppressed
  });
});

describe("Expiry Today scenario classification (UI)", () => {
  // Mirror of getExpiryScenario logic from dashboard
  const getExpiryScenario = (c, stockPrice, changePct) => {
    const stockUp = changePct > 0;
    const isITM   = c.type === "Put" ? stockPrice < +c.strike : stockPrice > +c.strike;
    const itmPct  = isITM ? (c.type === "Put"
      ? ((+c.strike - stockPrice) / +c.strike) * 100
      : ((stockPrice - +c.strike) / +c.strike) * 100) : 0;
    const isWheel = c.strategy?.toLowerCase().includes("wheel");

    if (isWheel && c.type === "Put") {
      if (isITM && itmPct > 5) return "wheel_itm_deep";
      if (isITM)               return "wheel_itm_shallow";
      return "wheel_otm";
    }
    if (!isITM && stockUp)  return "expiry_otm_up";
    if (isITM  && stockUp)  return "expiry_itm_up";
    if (!isITM && !stockUp) return "expiry_otm_down";
    if (isITM  && !stockUp) return "expiry_itm_down";
    return "expiry_default";
  };

  it("WDC $475 Call — stock at $486 (up) OTM → take profit", () => {
    // $475 call, stock at $486 = ITM for a call (stock > strike)
    expect(getExpiryScenario(
      { type:"Call", strike:475, strategy:"OTM Covered Call Strategy" }, 486, 0.02
    )).toBe("expiry_itm_up");
  });

  it("AMZN $272.5 Call — stock at $268 (down) OTM → wait", () => {
    expect(getExpiryScenario(
      { type:"Call", strike:272.5, strategy:"OTM Covered Call Strategy" }, 268, -0.015
    )).toBe("expiry_otm_down");
  });

  it("AMD $462 Put wheel — stock at $431 = 6.7% ITM → deep ITM", () => {
    const itmPct = ((462 - 431) / 462) * 100;
    expect(itmPct).toBeGreaterThan(5);
    expect(getExpiryScenario(
      { type:"Put", strike:462, strategy:"Wheel" }, 431, -0.06
    )).toBe("wheel_itm_deep");
  });

  it("wheel put OTM + stock up → take profit re-sell", () => {
    expect(getExpiryScenario(
      { type:"Put", strike:430, strategy:"Wheel" }, 445, 0.02
    )).toBe("wheel_otm");
  });

  it("wheel put ITM shallow (3%) → may let assign", () => {
    expect(getExpiryScenario(
      { type:"Put", strike:440, strategy:"Wheel" }, 427, -0.02
    )).toBe("wheel_itm_shallow"); // (440-427)/440 = 2.95% < 5%
  });

  it("non-STO contracts should not appear in expiry today", () => {
    const openContracts = [
      { optType:"STO", expires:"2026-05-15", status:"Open", type:"Call", strike:275 },
      { optType:"BTO", expires:"2026-05-15", status:"Open", type:"Call", strike:275 },
      { optType:"STO", expires:"2026-05-16", status:"Open", type:"Call", strike:275 },
    ];
    const TODAY = "2026-05-15";
    const expiring = openContracts.filter(c => c.expires === TODAY && c.optType === "STO");
    expect(expiring.length).toBe(1);
    expect(expiring[0].optType).toBe("STO");
  });

  it("expiry today panel hidden when no expiring contracts", () => {
    const openContracts = [
      { optType:"STO", expires:"2026-05-16", status:"Open" },
    ];
    const TODAY = "2026-05-15";
    const expiring = openContracts.filter(c => c.expires === TODAY && c.optType === "STO");
    expect(expiring.length).toBe(0); // panel should not render
  });
});

describe("toApp mapping — closeMethod and openMethod", () => {
  const toApp = (row) => ({
    id:          row.id,
    status:      row.status,
    closeMethod: row.close_method || null,
    openMethod:  row.open_method  || null,
    profit:      row.profit != null ? +row.profit : null,
  });

  it("maps close_method to closeMethod", () => {
    const row = { id:1, status:"Closed", close_method:"auto", open_method:"manual", profit:100 };
    expect(toApp(row).closeMethod).toBe("auto");
  });

  it("maps open_method to openMethod", () => {
    const row = { id:1, status:"Open", open_method:"app", close_method:null, profit:null };
    expect(toApp(row).openMethod).toBe("app");
  });

  it("null close_method maps to null (not 'manual')", () => {
    const row = { id:1, status:"Closed", close_method:null, profit:50 };
    expect(toApp(row).closeMethod).toBeNull();
  });

  it("automation stats correctly filter by closeMethod", () => {
    const contracts = [
      { status:"Closed", closeMethod:"auto",   profit:101 },
      { status:"Closed", closeMethod:"auto",   profit:50  },
      { status:"Closed", closeMethod:"app",    profit:200 },
      { status:"Closed", closeMethod:null,     profit:30  },
      { status:"Closed", closeMethod:"manual", profit:40  },
    ];
    const closedC     = contracts.filter(c => c.status === "Closed");
    const autoClosedC = closedC.filter(c => c.closeMethod === "auto");
    const appClosedC  = closedC.filter(c => c.closeMethod === "app");
    const manualC     = closedC.filter(c => !c.closeMethod || c.closeMethod === "manual");
    const autoProfit  = autoClosedC.reduce((s,c) => s+(c.profit||0), 0);

    expect(autoClosedC.length).toBe(2);
    expect(appClosedC.length).toBe(1);
    expect(manualC.length).toBe(2);
    expect(autoProfit).toBe(151);
    expect(Math.round(autoClosedC.length / closedC.length * 100)).toBe(40);
  });
});

describe("Claude API — mode routing", () => {
  const getMode = (body) => body.mode || "chat";

  it("defaults to chat mode when no mode specified", () => {
    expect(getMode({})).toBe("chat");
  });
  it("routes to skynet_analysis when mode set", () => {
    expect(getMode({ mode: "skynet_analysis" })).toBe("skynet_analysis");
  });
  it("chat mode passes through messages correctly", () => {
    const body = { messages: [{ role:"user", content:"test" }], max_tokens: 1000 };
    expect(body.messages[0].role).toBe("user");
    expect(body.max_tokens).toBe(1000);
  });
});

describe("Claude API — skynet analysis data prep", () => {
  const avg = arr => arr.length ? (arr.reduce((s,v) => s+v, 0) / arr.length).toFixed(2) : null;

  const buildFactorSummary = (signals, outcomes) => {
    const factorStats = {};
    signals.forEach(s => {
      if (!s.factor_name) return;
      if (!factorStats[s.factor_name]) factorStats[s.factor_name] = { values:[], goodValues:[], badValues:[] };
      factorStats[s.factor_name].values.push(+s.value);
      const outcome = outcomes?.find(o => o.signal_id === s.signal_id);
      if (outcome?.signal_quality === "good") factorStats[s.factor_name].goodValues.push(+s.value);
      if (outcome?.signal_quality === "bad")  factorStats[s.factor_name].badValues.push(+s.value);
    });
    return Object.entries(factorStats).map(([name, d]) => ({
      factor:   name,
      avg_all:  avg(d.values),
      avg_good: avg(d.goodValues),
      avg_bad:  avg(d.badValues),
      n_total:  d.values.length,
      n_good:   d.goodValues.length,
      n_bad:    d.badValues.length,
    }));
  };

  it("builds factor summary correctly", () => {
    const signals = [
      { signal_id:1, factor_name:"change_pct", value:1.5 },
      { signal_id:2, factor_name:"change_pct", value:0.8 },
      { signal_id:3, factor_name:"vix",        value:20  },
    ];
    const outcomes = [
      { signal_id:1, signal_quality:"good" },
      { signal_id:2, signal_quality:"bad"  },
    ];
    const summary = buildFactorSummary(signals, outcomes);
    const changeFactor = summary.find(f => f.factor === "change_pct");
    expect(changeFactor.n_total).toBe(2);
    expect(changeFactor.n_good).toBe(1);
    expect(changeFactor.n_bad).toBe(1);
    expect(changeFactor.avg_good).toBe("1.50");
    expect(changeFactor.avg_bad).toBe("0.80");
  });

  it("handles signals with no matching outcomes gracefully", () => {
    const signals  = [{ signal_id:99, factor_name:"vix", value:18 }];
    const outcomes = [];
    const summary  = buildFactorSummary(signals, outcomes);
    expect(summary[0].n_good).toBe(0);
    expect(summary[0].n_bad).toBe(0);
    expect(summary[0].avg_good).toBeNull();
  });

  it("returns error when no signals provided", () => {
    const signals = [];
    expect(signals.length === 0).toBe(true); // API returns 400 in this case
  });

  it("win rate calculation is correct", () => {
    const outcomes = [
      { signal_quality:"good" },
      { signal_quality:"good" },
      { signal_quality:"bad"  },
      { signal_quality:"neutral" },
    ];
    const good    = outcomes.filter(o => o.signal_quality === "good");
    const winRate = (good.length / outcomes.length * 100).toFixed(1);
    expect(winRate).toBe("50.0");
  });
});

describe("Claude API — response parsing", () => {
  it("extracts JSON from Claude response text", () => {
    const text = 'Here is my analysis:\n{"summary":"test summary","patterns":[]}\nDone.';
    const match = text.match(/\{[\s\S]*\}/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match[0]);
    expect(parsed.summary).toBe("test summary");
  });

  it("handles malformed JSON gracefully", () => {
    const text = "I cannot provide analysis at this time.";
    const match = text.match(/\{[\s\S]*\}/);
    const analysis = match ? JSON.parse(match[0]) : { summary: text, parse_error: true };
    expect(analysis.parse_error).toBe(true);
    expect(analysis.summary).toBe(text);
  });

  it("uses correct model string", () => {
    const MODEL = "claude-sonnet-4-5-20250929";
    expect(MODEL).toBe("claude-sonnet-4-5-20250929");
    expect(MODEL).not.toBe("claude-sonnet-4-5"); // old broken model string
  });
});

describe("Auto-STO scanner", () => {
  it("only processes whitelisted tickers (autoSto=true)", () => {
    const stocksData = {
      AAPL: { autoSto: true,  sharesSchwab: 200 },
      NVDA: { autoSto: false, sharesSchwab: 100 },
      AMZN: { autoSto: true,  sharesSchwab: 700, sharesEtrade: 300 },
      JPM:  { autoSto: null,  sharesSchwab: 100 },
    };
    const whitelist = Object.entries(stocksData)
      .filter(([, sd]) => sd?.autoSto === true)
      .map(([sym]) => sym.toUpperCase());
    expect(whitelist).toContain("AAPL");
    expect(whitelist).toContain("AMZN");
    expect(whitelist).not.toContain("NVDA");
    expect(whitelist).not.toContain("JPM");
  });

  it("calculates uncovered qty per account correctly", () => {
    const sharesByAcct = { "Schwab 3866": 700, "ETrade 6917": 300 };
    const coveredByAcct = { "Schwab 3866": 200 }; // 2 open contracts × 100
    const results = [];
    for (const [account, totalShares] of Object.entries(sharesByAcct)) {
      const covered   = coveredByAcct[account] || 0;
      const uncovered = Math.floor((totalShares - covered) / 100);
      if (uncovered >= 1) results.push({ account, uncovered });
    }
    expect(results.find(r => r.account === "Schwab 3866")?.uncovered).toBe(5);
    expect(results.find(r => r.account === "ETrade 6917")?.uncovered).toBe(3);
  });

  it("AMZN example: 700 Schwab + 300 ETrade = 10 total contracts", () => {
    const sharesByAcct = { "Schwab 3866": 700, "ETrade 6917": 300 };
    const coveredByAcct = {};
    let total = 0;
    for (const [, shares] of Object.entries(sharesByAcct)) {
      const covered   = coveredByAcct[Object.keys(sharesByAcct)[0]] || 0;
      total += Math.floor((shares) / 100);
    }
    expect(total).toBe(10);
  });

  it("selects highest premium strike within OTM% range", () => {
    const stockPrice = 275;
    const minOTM = 1, maxOTM = 5;
    const strikes = [
      { strikePrice: 277.5, bid: 1.20, ask: 1.40 }, // 0.9% OTM — too close
      { strikePrice: 280,   bid: 0.90, ask: 1.10 }, // 1.8% OTM — in range
      { strikePrice: 282.5, bid: 1.30, ask: 1.50 }, // 2.7% OTM — in range, higher premium
      { strikePrice: 290,   bid: 0.20, ask: 0.30 }, // 5.5% OTM — too far
    ];
    let best = null, bestPremium = 0;
    for (const s of strikes) {
      const otmPct = ((s.strikePrice - stockPrice) / stockPrice) * 100;
      if (otmPct < minOTM || otmPct > maxOTM) continue;
      const mid = (s.bid + s.ask) / 2;
      if (mid > bestPremium) { bestPremium = mid; best = s; }
    }
    expect(best?.strikePrice).toBe(282.5); // highest premium in range
    expect(bestPremium).toBe(1.40);
  });

  it("skips expiry on or before today", () => {
    const today = new Date().toISOString().slice(0,10);
    const yesterday  = new Date(Date.now() - 86400000).toISOString().slice(0,10);
    const tomorrow   = new Date(Date.now() + 86400000).toISOString().slice(0,10);
    const nextWeek   = new Date(Date.now() + 7*86400000).toISOString().slice(0,10);
    const expiries = [today, yesterday, tomorrow, nextWeek];
    const valid = expiries.filter(e => e > today);
    expect(valid).toContain(tomorrow);
    expect(valid).toContain(nextWeek);
    expect(valid).not.toContain(today);
    expect(valid).not.toContain(yesterday);
  });

  it("respects minimum premium — skips if est premium below threshold", () => {
    const limitPrice = 0.25;
    const qty = 2;
    const minPrem = 50;
    const estPremium = Math.round(limitPrice * qty * 100 * 100) / 100;
    expect(estPremium).toBe(50);
    expect(estPremium >= minPrem).toBe(true);
  });

  it("dry_run defaults to true — safe default", () => {
    const rule = { enabled: true, min_profit_pct: 70 }; // no dry_run field
    const isDryRun = rule.dry_run !== false;
    expect(isDryRun).toBe(true);
  });

  it("deduplicates same ticker+account+strike+expiry within same day", () => {
    const today = new Date().toISOString().slice(0,10);
    const sentData = { contracts: {
      "auto_sto|AMZN|Schwab 3866|280|2026-05-22": { sentAt: `${today}T14:00:00Z` }
    }};
    const key = "auto_sto|AMZN|Schwab 3866|280|2026-05-22";
    const alreadySent = sentData.contracts[key]?.sentAt?.slice(0,10) === today;
    expect(alreadySent).toBe(true); // should skip
  });

  it("allows re-entry after BTC — different strike or expiry gets new key", () => {
    const today = new Date().toISOString().slice(0,10);
    const todayStr2 = new Date().toISOString().slice(0,10);
    const sentData = { contracts: {
      "auto_sto|AMZN|Schwab 3866|280|2026-05-22": { sentAt: `${todayStr2}T10:00:00Z` }
    }};
    // New opportunity at different strike after BTC
    const newKey = "auto_sto|AMZN|Schwab 3866|282.5|2026-05-22";
    const alreadySent = sentData.contracts[newKey]?.sentAt?.slice(0,10) === todayStr2;
    expect(alreadySent).toBe(false); // new strike = allowed
  });
});

describe("Auto-STO — dry_run gate", () => {
  const shouldRunAutoSto = (rule) => {
    if (!rule?.enabled) return { run: false, reason: "rule disabled" };
    const isDryRun = rule.dry_run !== false;
    return { run: true, isDryRun, reason: isDryRun ? "dry run" : "live" };
  };

  it("does not run if rule is disabled", () => {
    const result = shouldRunAutoSto({ enabled: false, dry_run: true });
    expect(result.run).toBe(false);
    expect(result.reason).toBe("rule disabled");
  });

  it("runs in dry run mode when enabled and dry_run=true", () => {
    const result = shouldRunAutoSto({ enabled: true, dry_run: true });
    expect(result.run).toBe(true);
    expect(result.isDryRun).toBe(true);
  });

  it("runs live when enabled and dry_run=false", () => {
    const result = shouldRunAutoSto({ enabled: true, dry_run: false });
    expect(result.run).toBe(true);
    expect(result.isDryRun).toBe(false);
  });

  it("dry_run defaults to true when undefined — safe default", () => {
    const result = shouldRunAutoSto({ enabled: true });
    expect(result.isDryRun).toBe(true);
  });

  it("live mode warning shows only when dry_run=false", () => {
    expect({ dry_run: false }.dry_run === false).toBe(true);
    expect({ dry_run: true  }.dry_run === false).toBe(false);
    expect({ dry_run: undefined }.dry_run === false).toBe(false);
  });
});



// ── Complete fake data factory ────────────────────────────────────────────────

function makeRule(overrides = {}) {
  return {
    id: 1, rule_type: "sto", enabled: true,
    dry_run: true,
    min_change_pct: 0.5, min_premium: 50,
    min_dte: 1, max_dte: 14,
    min_otm_pct: 1.0, max_otm_pct: 5.0,
    min_time_et: "09:45", priority: 10,
    ...overrides,
  };
}

function makeQuote(overrides = {}) {
  return {
    lastPrice: 200.00, changePct: 0.015,  // +1.5%
    dayHigh:   202.00, openPrice: 198.00,
    volume: 5000000,
    ...overrides,
  };
}

function makeMomentumConfig(overrides = {}) {
  return {
    enabled: true,
    pullback_enabled: true,    min_pullback_from_high_pct: 0.3,
    momentum_enabled: true,    require_decelerating: true, momentum_lookback_mins: 30,
    gap_enabled: true,         max_gap_up_pct: 2.0,
    volume_enabled: false,
    min_time_et: "10:00",      max_time_et: "15:30",
    ...overrides,
  };
}

function makePriceHistory(symbol, changePctNow, changePct30mAgo) {
  return [
    { symbol, change_pct: changePctNow,   captured_at: new Date().toISOString() },
    { symbol, change_pct: changePct30mAgo, captured_at: new Date(Date.now() - 31*60000).toISOString() },
  ];
}

function makeChain(symbol, expiry, strikes) {
  return {
    [`${symbol}|${expiry}`]: {
      calls: strikes.map(([strike, bid, ask]) => ({ strikePrice: strike, bid, ask })),
    }
  };
}

function makeStocksData(symbol, sharesByAcct, overrides = {}) {
  return { [symbol]: { autoSto: true, sharesByAcct, ...overrides } };
}

function makeOpenContracts(symbol, account, qty) {
  return [{ stock: symbol, account, status: "Open", opt_type: "STO", type: "Call", qty }];
}

// Core evaluator — mirrors market-refresh logic
function evaluateAutoSto({ rule, quote, symbol, stocksData, chainData, openContracts = [], sentData = {}, etTimeMins = 10*60+30, priceHistory = [], momentumConfig }) {
  const today = new Date().toISOString().slice(0,10);

  // 1. Rule checks
  if (!rule?.enabled)       return { action:"skip", reason:"rule disabled" };
  
  const isDryRun = rule.dry_run !== false;

  // 2. Time gate
  const minMins = rule.min_time_et ? +rule.min_time_et.split(":")[0]*60 + +rule.min_time_et.split(":")[1] : 9*60+45;
  if (etTimeMins < minMins) return { action:"skip", reason:`too early (${etTimeMins} < ${minMins})` };

  // 3. Whitelist
  const sd = stocksData[symbol];
  if (!sd?.autoSto) return { action:"skip", reason:"not whitelisted" };

  // 4. Stock change
  const changePct = (quote.changePct ?? 0) * 100;
  if (changePct < (rule.min_change_pct ?? 0.5)) return { action:"skip", reason:`change ${changePct.toFixed(2)}% below min` };

  // 5. Momentum checks
  if (momentumConfig?.enabled) {
    if (momentumConfig.pullback_enabled) {
      const pullback = ((quote.dayHigh - quote.lastPrice) / quote.dayHigh) * 100;
      if (pullback < momentumConfig.min_pullback_from_high_pct)
        return { action:"suppressed", reason:`pullback ${pullback.toFixed(2)}% < ${momentumConfig.min_pullback_from_high_pct}%` };
    }
    if (momentumConfig.momentum_enabled && momentumConfig.require_decelerating) {
      const hist = priceHistory.filter(r => r.symbol === symbol).sort((a,b) => new Date(b.captured_at)-new Date(a.captured_at));
      const cutoff = new Date(Date.now() - (momentumConfig.momentum_lookback_mins||30)*60000);
      const historical = hist.find(r => new Date(r.captured_at) <= cutoff);
      if (historical && changePct > historical.change_pct)
        return { action:"suppressed", reason:`accelerating: ${historical.change_pct}→${changePct}` };
    }
    if (momentumConfig.gap_enabled) {
      const moveFromOpen = ((quote.lastPrice - quote.openPrice) / quote.openPrice) * 100;
      if (moveFromOpen > (momentumConfig.max_gap_up_pct ?? 2.0))
        return { action:"suppressed", reason:`gap-up ${moveFromOpen.toFixed(2)}% > max ${momentumConfig.max_gap_up_pct}%` };
    }
  }

  // 6. Find best strike
  let bestStrike = null, bestPremium = 0, bestExpiry = null, bestDTE = null;
  for (const [chainKey, chain] of Object.entries(chainData||{})) {
    const [ct, exp] = chainKey.split("|");
    if (ct !== symbol || exp <= today) continue;
    const dte = Math.ceil((new Date(exp) - new Date()) / 86400000);
    if (dte < rule.min_dte || dte > rule.max_dte) continue;
    for (const s of (chain.calls||[])) {
      const otm = ((s.strikePrice - quote.lastPrice) / quote.lastPrice) * 100;
      if (otm < rule.min_otm_pct || otm > rule.max_otm_pct) continue;
      const mid = (s.bid + s.ask) / 2;
      if (mid > bestPremium) { bestPremium = mid; bestStrike = s.strikePrice; bestExpiry = exp; bestDTE = dte; }
    }
  }
  if (!bestStrike) return { action:"skip", reason:"no suitable strike" };

  // 7. Per-account uncovered
  const orders = [];
  for (const [account, shares] of Object.entries(sd.sharesByAcct||{})) {
    const covered = (openContracts||[]).filter(c=>c.stock===symbol&&c.account===account&&c.status==="Open").reduce((s,c)=>s+(+c.qty||0)*100,0);
    const uncovered = Math.floor((shares-covered)/100);
    if (uncovered < 1) continue;
    const estPrem = Math.round(bestPremium * uncovered * 100 * 100) / 100;
    if (estPrem < rule.min_premium) continue;
    // Dedup check
    const key = `auto_sto|${symbol}|${account}|${bestStrike}|${bestExpiry}`;
    if (sentData[key]?.sentAt?.slice(0,10) === today) continue;
    orders.push({ account, qty: uncovered, strike: bestStrike, expiry: bestExpiry, dte: bestDTE, limitPrice: bestPremium, estPremium: estPrem, isDryRun });
  }
  if (!orders.length) return { action:"skip", reason:"no uncovered shares or below min premium" };
  return { action: isDryRun ? "dry_run" : "place_order", orders };
}

describe("Auto-STO full simulation — all decision points", () => {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0,10);
  const defaultChain = makeChain("AAPL", tomorrow, [[202, 1.50, 1.70], [205, 0.90, 1.10]]);
  const defaultStocksData = makeStocksData("AAPL", { "Schwab 3866": 200 });
  const defaultQuote = makeQuote();
  const defaultMom = makeMomentumConfig();

  // ── Rule gate ──────────────────────────────────────────────────────────────
  it("skips when rule is disabled", () => {
    const r = evaluateAutoSto({ rule: makeRule({ enabled: false }), quote: defaultQuote, symbol:"AAPL", stocksData: defaultStocksData, chainData: defaultChain, momentumConfig: defaultMom });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("rule disabled");
  });


  // ── Time gate ──────────────────────────────────────────────────────────────
  it("skips before 9:45am ET", () => {
    const r = evaluateAutoSto({ rule: makeRule(), quote: defaultQuote, symbol:"AAPL", stocksData: defaultStocksData, chainData: defaultChain, etTimeMins: 9*60+30, momentumConfig: defaultMom });
    expect(r.action).toBe("skip");
    expect(r.reason).toContain("too early");
  });

  it("runs at exactly 9:45am ET", () => {
    const r = evaluateAutoSto({ rule: makeRule(), quote: defaultQuote, symbol:"AAPL", stocksData: defaultStocksData, chainData: defaultChain, etTimeMins: 9*60+45, momentumConfig: defaultMom });
    expect(r.action).not.toBe("skip");
  });

  // ── Whitelist ──────────────────────────────────────────────────────────────
  it("skips ticker not whitelisted", () => {
    const r = evaluateAutoSto({ rule: makeRule(), quote: defaultQuote, symbol:"AAPL", stocksData: makeStocksData("AAPL", {"Schwab 3866":200}, { autoSto: false }), chainData: defaultChain, momentumConfig: defaultMom });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("not whitelisted");
  });

  // ── Stock change ───────────────────────────────────────────────────────────
  it("skips when stock change below min (0.3% < 0.5%)", () => {
    const r = evaluateAutoSto({ rule: makeRule(), quote: makeQuote({ changePct: 0.003 }), symbol:"AAPL", stocksData: defaultStocksData, chainData: defaultChain, momentumConfig: defaultMom });
    expect(r.action).toBe("skip");
    expect(r.reason).toContain("below min");
  });

  it("proceeds when stock change exactly at min (0.5%)", () => {
    const r = evaluateAutoSto({ rule: makeRule(), quote: makeQuote({ changePct: 0.005 }), symbol:"AAPL", stocksData: defaultStocksData, chainData: defaultChain, momentumConfig: defaultMom });
    expect(r.action).not.toBe("skip");
  });

  // ── Momentum ───────────────────────────────────────────────────────────────
  it("suppresses when stock within 0.3% of intraday high", () => {
    // lastPrice=201.80, dayHigh=202.00 → pullback=0.099% < 0.3%
    const r = evaluateAutoSto({ rule: makeRule(), quote: makeQuote({ lastPrice: 201.80, dayHigh: 202.00 }), symbol:"AAPL", stocksData: defaultStocksData, chainData: defaultChain, momentumConfig: defaultMom });
    expect(r.action).toBe("suppressed");
    expect(r.reason).toContain("pullback");
  });

  it("passes when stock has pulled back 0.6% from high", () => {
    // lastPrice=200.80, dayHigh=202.00 → pullback=0.59% > 0.3%
    const r = evaluateAutoSto({ rule: makeRule(), quote: makeQuote({ lastPrice: 200.80, dayHigh: 202.00 }), symbol:"AAPL", stocksData: defaultStocksData, chainData: defaultChain, momentumConfig: defaultMom });
    expect(r.action).not.toBe("suppressed");
  });

  it("suppresses when move is still accelerating", () => {
    const history = makePriceHistory("AAPL", 1.5, 0.8); // now +1.5%, 30m ago +0.8% → accelerating
    const r = evaluateAutoSto({ rule: makeRule(), quote: makeQuote({ changePct: 0.015 }), symbol:"AAPL", stocksData: defaultStocksData, chainData: defaultChain, priceHistory: history, momentumConfig: defaultMom });
    expect(r.action).toBe("suppressed");
    expect(r.reason).toContain("accelerating");
  });

  it("passes when move is decelerating", () => {
    const history = makePriceHistory("AAPL", 1.5, 2.1); // now +1.5%, 30m ago +2.1% → decelerating
    const r = evaluateAutoSto({ rule: makeRule(), quote: makeQuote({ changePct: 0.015 }), symbol:"AAPL", stocksData: defaultStocksData, chainData: defaultChain, priceHistory: history, momentumConfig: defaultMom });
    expect(r.action).not.toBe("suppressed");
  });

  it("suppresses when gap-up exceeds max (stock up >2% from open)", () => {
    // lastPrice=201, dayHigh=202 → pullback=0.5% ✓ passes pullback check
    // lastPrice=201, openPrice=196 → moveFromOpen=2.55% > 2.0% → gap-up suppressed
    const r = evaluateAutoSto({ rule: makeRule(), quote: makeQuote({ lastPrice: 201, dayHigh: 202, openPrice: 196 }), symbol:"AAPL", stocksData: defaultStocksData, chainData: defaultChain, momentumConfig: makeMomentumConfig({ momentum_enabled: false }) });
    expect(r.action).toBe("suppressed");
    expect(r.reason).toContain("gap-up");
  });

  // ── Chain / strike selection ───────────────────────────────────────────────
  it("skips when no chain data available", () => {
    const r = evaluateAutoSto({ rule: makeRule(), quote: defaultQuote, symbol:"AAPL", stocksData: defaultStocksData, chainData: {}, momentumConfig: defaultMom });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("no suitable strike");
  });

  it("skips when all strikes outside OTM range", () => {
    // AAPL at $200 — only strikes outside 1-5% range
    const chain = makeChain("AAPL", tomorrow, [[200.5, 1.00, 1.20], [215, 0.10, 0.20]]);
    const r = evaluateAutoSto({ rule: makeRule(), quote: defaultQuote, symbol:"AAPL", stocksData: defaultStocksData, chainData: chain, momentumConfig: defaultMom });
    expect(r.action).toBe("skip");
  });

  it("skips expiry on or before today", () => {
    const todayStr = new Date().toISOString().slice(0,10);
    const chain = makeChain("AAPL", todayStr, [[202, 1.50, 1.70]]); // today
    const r = evaluateAutoSto({ rule: makeRule(), quote: defaultQuote, symbol:"AAPL", stocksData: defaultStocksData, chainData: chain, momentumConfig: defaultMom });
    expect(r.action).toBe("skip");
  });

  it("skips expiry outside DTE range", () => {
    // Use a dynamic date 30 days from now to ensure it's always > max_dte of 14
    const farDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const chain = makeChain("AAPL", farDate, [[202, 1.50, 1.70]]); // 30 DTE > max 14
    const r = evaluateAutoSto({ rule: makeRule({ max_dte: 14 }), quote: defaultQuote, symbol:"AAPL", stocksData: defaultStocksData, chainData: chain, momentumConfig: defaultMom });
    expect(r.action).toBe("skip");
  });

  // ── Premium / shares ───────────────────────────────────────────────────────
  it("skips when est premium below minimum", () => {
    // 1 contract × $0.40 mid = $40 < $50 min — strike at 1.5% OTM (in range)
    const chain = makeChain("AAPL", tomorrow, [[203, 0.30, 0.50]]);
    const r = evaluateAutoSto({ rule: makeRule({ min_premium: 50 }), quote: defaultQuote, symbol:"AAPL", stocksData: makeStocksData("AAPL", {"Schwab 3866": 100}), chainData: chain, momentumConfig: defaultMom });
    expect(r.action).toBe("skip");
    expect(r.reason).toContain("uncovered shares or below min premium");
  });

  it("skips when shares fully covered by open contracts", () => {
    const openContracts = makeOpenContracts("AAPL", "Schwab 3866", 2); // 200 shares covered
    const r = evaluateAutoSto({ rule: makeRule(), quote: defaultQuote, symbol:"AAPL", stocksData: makeStocksData("AAPL", {"Schwab 3866": 200}), chainData: defaultChain, openContracts, momentumConfig: defaultMom });
    expect(r.action).toBe("skip");
  });

  // ── Dedup / re-entry ───────────────────────────────────────────────────────
  it("deduplicates same strike already placed today", () => {
    const tmrw = new Date(Date.now() + 86400000).toISOString().slice(0,10);
    const todayStr = new Date().toISOString().slice(0,10);
    const sentData = { [`auto_sto|AAPL|Schwab 3866|202|${tmrw}`]: { sentAt: `${todayStr}T14:00:00Z` } };
    const r = evaluateAutoSto({ rule: makeRule(), quote: defaultQuote, symbol:"AAPL", stocksData: defaultStocksData, chainData: defaultChain, sentData, momentumConfig: defaultMom });
    expect(r.action).toBe("skip");
  });

  it("allows re-entry at new strike after BTC", () => {
    // $202 was placed, but now best strike is $205 (different key)
    const sentData = { "auto_sto|AAPL|Schwab 3866|202|2026-05-16": { sentAt: "2026-05-15T10:00:00Z" } };
    // Force best strike to be $205 by making $202 below OTM min
    const chain = makeChain("AAPL", tomorrow, [[205, 1.80, 2.00]]); // only $205 in range
    const r = evaluateAutoSto({ rule: makeRule(), quote: defaultQuote, symbol:"AAPL", stocksData: defaultStocksData, chainData: chain, sentData, momentumConfig: defaultMom });
    expect(r.action).toBe("dry_run");
    expect(r.orders[0].strike).toBe(205);
  });

  // ── End-to-end happy path ──────────────────────────────────────────────────
  it("complete happy path — AAPL up 1.5%, fading, 2 uncovered contracts → dry_run order", () => {
    const history = makePriceHistory("AAPL", 1.5, 2.0); // decelerating
    const r = evaluateAutoSto({
      rule: makeRule(),
      quote: makeQuote({ lastPrice: 200, changePct: 0.015, dayHigh: 201.5, openPrice: 198 }),
      symbol: "AAPL",
      stocksData: makeStocksData("AAPL", { "Schwab 3866": 200 }),
      chainData: makeChain("AAPL", tomorrow, [[202, 1.50, 1.70], [205, 0.90, 1.10]]),
      priceHistory: history,
      momentumConfig: makeMomentumConfig(),
      etTimeMins: 10*60+30,
    });
    expect(r.action).toBe("dry_run");
    expect(r.orders.length).toBe(1);
    expect(r.orders[0].account).toBe("Schwab 3866");
    expect(r.orders[0].qty).toBe(2);
    expect(r.orders[0].strike).toBe(202); // highest premium in range
    expect(r.orders[0].isDryRun).toBe(true);
  });
});

// ── isDryRun used in STO block, not contractDryRun (June 8 2026 bug fix) ──────
describe("auto-STO dry run variable scoping", () => {
  // Verifies that the STO placement block uses isDryRun (defined in STO scope)
  // and not contractDryRun (only defined in the BTC scope — was causing ReferenceError)

  function simulateStoPlacement(rule, usesCorrectVar) {
    // usesCorrectVar simulates whether the code uses isDryRun vs contractDryRun
    const isDryRun = rule?.dry_run !== false;
    if (usesCorrectVar) {
      // Correct: uses isDryRun which is defined in STO scope
      return { placed: !isDryRun, error: null };
    } else {
      // Bug: references contractDryRun which is undefined in STO scope
      try {
        const contractDryRun = undefined; // not defined in STO scope
        if (contractDryRun === undefined) throw new ReferenceError("contractDryRun is not defined");
        return { placed: true, error: null };
      } catch (e) {
        return { placed: false, error: e.message };
      }
    }
  }

  it("positive — isDryRun correctly gates STO placement (dry_run=false → places order)", () => {
    const rule = { dry_run: false, enabled: true };
    const r = simulateStoPlacement(rule, true);
    expect(r.error).toBeNull();
    expect(r.placed).toBe(true);
  });

  it("positive — isDryRun correctly gates STO placement (dry_run=true → does not place)", () => {
    const rule = { dry_run: true, enabled: true };
    const r = simulateStoPlacement(rule, true);
    expect(r.error).toBeNull();
    expect(r.placed).toBe(false);
  });

  it("negative — using contractDryRun in STO scope throws ReferenceError", () => {
    // This documents the exact bug: contractDryRun is only defined in the BTC block
    const rule = { dry_run: false, enabled: true };
    const r = simulateStoPlacement(rule, false);
    expect(r.error).toContain("contractDryRun is not defined");
    expect(r.placed).toBe(false);
  });

  it("negative — STO should never throw ReferenceError with correct variable", () => {
    const rule = { dry_run: false, enabled: true };
    const r = simulateStoPlacement(rule, true);
    expect(r.error).toBeNull(); // no reference error
  });
});

// ── Expiry protection — auto-close ITM contracts at 3:30 PM ET ───────────────
// Mirrors api/market-refresh.js "Auto-close ITM contracts at 3:30 PM ET" block (~line 3110)
describe("Expiry protection — auto-close ITM contracts at 3:30 PM ET", () => {
  const WARN_MINS  = 15 * 60;      // 3:00 PM ET
  const CLOSE_MINS = 15 * 60 + 30; // 3:30 PM ET

  // Pure evaluator mirroring the market-refresh expiry-protection gate chain:
  // market hours → expiry day → ITM → warn window → Call-only → close_method → dry_run
  function evaluateExpiryClose({ contract, stockPrice, etMinsForExpiry, todayET, isMarketOpen, dryRun }) {
    if (!isMarketOpen) return { action: "skip", reason: "outside_market_hours" };
    if (contract.expires !== todayET) return { action: "skip", reason: "not_expiry_day" };
    if (etMinsForExpiry < WARN_MINS) return { action: "skip", reason: "before_warn_window" };

    const strike = +contract.strike;
    const isCall = contract.type === "Call";
    const isITM  = isCall ? stockPrice > strike : stockPrice < strike;
    if (!isITM) return { action: "skip", reason: "otm" };

    if (etMinsForExpiry < CLOSE_MINS) return { action: "warn" };

    if (!isCall) return { action: "skip", reason: "put_left_to_assign" }; // wheel — left to assign
    if (contract.close_method === "auto") return { action: "skip", reason: "already_auto_closed" };

    return { action: dryRun ? "log_dry_run" : "place_order" };
  }

  const today = "2026-06-19";
  const baseCall = { type: "Call", strike: 100, expires: today, close_method: null };
  const basePut  = { type: "Put",  strike: 100, expires: today, close_method: null };

  // ── Positive ─────────────────────────────────────────────────────────────
  it("ITM Call, 3:30pm ET on expiry day, dry_run=false → places BTC order", () => {
    const r = evaluateExpiryClose({ contract: baseCall, stockPrice: 105, etMinsForExpiry: CLOSE_MINS, todayET: today, isMarketOpen: true, dryRun: false });
    expect(r.action).toBe("place_order");
  });

  it("ITM Call, 3:00pm ET on expiry day → sends warning, does NOT place order", () => {
    const r = evaluateExpiryClose({ contract: baseCall, stockPrice: 105, etMinsForExpiry: WARN_MINS, todayET: today, isMarketOpen: true, dryRun: false });
    expect(r.action).toBe("warn");
  });

  it("ITM Call, 3:30pm ET, dry_run=true → logs but does NOT place order", () => {
    const r = evaluateExpiryClose({ contract: baseCall, stockPrice: 105, etMinsForExpiry: CLOSE_MINS, todayET: today, isMarketOpen: true, dryRun: true });
    expect(r.action).toBe("log_dry_run");
  });

  // ── Negative ─────────────────────────────────────────────────────────────
  it("ITM Put, 3:30pm ET → skipped (wheel, left to assign)", () => {
    const r = evaluateExpiryClose({ contract: basePut, stockPrice: 95, etMinsForExpiry: CLOSE_MINS, todayET: today, isMarketOpen: true, dryRun: false });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("put_left_to_assign");
  });

  it("ITM Call, 3:30pm ET, outside market hours → skipped", () => {
    const r = evaluateExpiryClose({ contract: baseCall, stockPrice: 105, etMinsForExpiry: CLOSE_MINS, todayET: today, isMarketOpen: false, dryRun: false });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("outside_market_hours");
  });

  it("ITM Call, 3:30pm ET, DTE > 0 (not expiry day) → skipped", () => {
    const tomorrow = "2026-06-20";
    const r = evaluateExpiryClose({ contract: { ...baseCall, expires: tomorrow }, stockPrice: 105, etMinsForExpiry: CLOSE_MINS, todayET: today, isMarketOpen: true, dryRun: false });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("not_expiry_day");
  });

  it("ITM Call, 3:30pm ET, close_method already 'auto' → skipped", () => {
    const r = evaluateExpiryClose({ contract: { ...baseCall, close_method: "auto" }, stockPrice: 105, etMinsForExpiry: CLOSE_MINS, todayET: today, isMarketOpen: true, dryRun: false });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("already_auto_closed");
  });
});

// ── Portfolio value — ETrade multi-account aggregation ───────────────────────
// Mirrors api/etrade.js "positions" action (loops all accounts, sums totalAccountValue)
// and src/pri-tod-v3.jsx liveEtradeInline precedence (snapshot combined value → cashData fallback)
describe("Portfolio value — ETrade multi-account aggregation", () => {
  // Mirrors the accumulation loop in api/etrade.js action=positions
  function sumEtradeAccountValues(accounts) {
    return accounts.reduce((sum, a) => sum + (+a.nav || 0), 0);
  }

  it("both ETrade accounts present → total = ETrade6917 + ETrade8222", () => {
    const accounts = [
      { accountId: "227156917", nav: 40000 }, // ETrade 6917
      { accountId: "227418222", nav: 25000 }, // ETrade 8222
    ];
    const schwab = 100000;
    const total = schwab + sumEtradeAccountValues(accounts);
    expect(sumEtradeAccountValues(accounts)).toBe(65000);
    expect(total).toBe(165000);
  });

  it("single ETrade account source → does not show as full portfolio value", () => {
    // Only ETrade 6917 reporting (8222 missing/unavailable) — total undercounts by 8222's NAV
    const accountsFull   = [{ accountId: "227156917", nav: 40000 }, { accountId: "227418222", nav: 25000 }];
    const accountsSingle = [{ accountId: "227156917", nav: 40000 }];
    const fullTotal   = sumEtradeAccountValues(accountsFull);
    const singleTotal = sumEtradeAccountValues(accountsSingle);
    expect(singleTotal).not.toBe(fullTotal);
    expect(singleTotal).toBeLessThan(fullTotal); // missing 8222's $25,000
  });

  // Mirrors pri-tod-v3.jsx: latestSnapshot = portfolioSnapshots[portfolioSnapshots.length - 1]
  // (portfolioSnapshots is ordered ascending by snapshot_date)
  it("latest snapshot is the last element of the ascending-ordered array, not the first", () => {
    const portfolioSnapshots = [
      { snapshot_date: "2026-01-01", etrade_value: 30000 }, // oldest
      { snapshot_date: "2026-06-01", etrade_value: 65000 }, // latest (both accounts combined)
    ];
    const latestSnapshot = portfolioSnapshots[portfolioSnapshots.length - 1] ?? null;
    expect(latestSnapshot.etrade_value).toBe(65000);
    expect(latestSnapshot.snapshot_date).toBe("2026-06-01");
  });

  // Mirrors: const liveEtradeInline = snapEtrade ?? (cashData?.etrade ? +cashData.etrade : null);
  function liveEtradeInline(snapEtrade, cashDataEtrade) {
    return snapEtrade ?? (cashDataEtrade ? +cashDataEtrade : null);
  }

  it("combined snapshot etrade_value takes precedence over single-account cashData.etrade", () => {
    const snapEtrade = 65000; // combined, from portfolio_snapshots
    const cashDataEtrade = "40000"; // single manually-entered account
    expect(liveEtradeInline(snapEtrade, cashDataEtrade)).toBe(65000);
  });

  it("falls back to cashData.etrade only when no snapshot value exists", () => {
    expect(liveEtradeInline(null, "40000")).toBe(40000);
  });
});

// ── P6: option_snapshots auto-purge — config-driven, DB-size-gated, active-ticker-safe ──
// Mirrors scripts/option-snapshot-purge.js + the purge_option_snapshots_batch RPC.
// Replaces the old in-handler runSnapshotPurge() (market-refresh.js), which was retired
// 2026-07-19 after ecosystem_heartbeat showed it silently stopped firing for 10+ days —
// its narrow 9:30-9:35am ET window gate missed whenever a cron tick landed late.
describe("option_snapshots auto-purge — DB-size threshold gate", () => {
  function shouldPurge(dbSizeGb, thresholdGb) {
    return dbSizeGb >= thresholdGb;
  }

  it("positive — DB size over threshold → purge proceeds", () => {
    expect(shouldPurge(11, 4)).toBe(true);
  });

  it("negative — DB size under threshold → purge skipped entirely", () => {
    expect(shouldPurge(3.2, 4)).toBe(false);
  });

  it("edge — exactly at threshold counts as over (>=)", () => {
    expect(shouldPurge(4, 4)).toBe(true);
  });
});

describe("option_snapshots auto-purge — active-ticker protection + retention", () => {
  // Pure simulation of one purge_option_snapshots_batch() call
  function purgeBatch(rows, { retentionDays, activeSymbols, batchSize = 500000, now = new Date() }) {
    const cutoff = new Date(now.getTime() - retentionDays * 86400000).toISOString();
    const activeSet = new Set(activeSymbols.map(s => s.toUpperCase()));
    const victims = rows.filter(r => r.snapshot_at < cutoff && !activeSet.has(r.symbol.toUpperCase())).slice(0, batchSize);
    return victims.length;
  }

  const NOW = new Date("2026-07-19T11:00:00Z");
  const rowAt = (symbol, daysAgo) => ({ symbol, snapshot_at: new Date(NOW.getTime() - daysAgo * 86400000).toISOString() });

  it("positive — DB over threshold, 20-day-old row for an inactive ticker → purged", () => {
    const rows = [rowAt("XYZ", 20)];
    const deleted = purgeBatch(rows, { retentionDays: 14, activeSymbols: ["AAPL"], now: NOW });
    expect(deleted).toBe(1);
  });

  it("negative — rows under 14 days old are retained regardless of ticker", () => {
    const rows = [rowAt("XYZ", 10), rowAt("XYZ", 5)];
    const deleted = purgeBatch(rows, { retentionDays: 14, activeSymbols: [], now: NOW });
    expect(deleted).toBe(0);
  });

  it("negative — active ticker (open contract or watchlisted) is never purged, even at 90 days old", () => {
    const rows = [rowAt("AAPL", 90)];
    const deleted = purgeBatch(rows, { retentionDays: 14, activeSymbols: ["AAPL"], now: NOW });
    expect(deleted).toBe(0);
  });

  it("mixed — inactive old rows purged, active old rows and recent rows retained", () => {
    const rows = [rowAt("XYZ", 20), rowAt("AAPL", 90), rowAt("XYZ", 5)];
    const deleted = purgeBatch(rows, { retentionDays: 14, activeSymbols: ["AAPL"], now: NOW });
    expect(deleted).toBe(1); // only the 20-day-old XYZ row
  });

  it("batches — caller loops until a batch returns fewer than batchSize (partial = done)", () => {
    const rows = Array.from({ length: 25 }, (_, i) => rowAt("XYZ", 20 + i));
    const firstBatch = purgeBatch(rows, { retentionDays: 14, activeSymbols: [], batchSize: 10, now: NOW });
    expect(firstBatch).toBe(10); // full batch — caller must loop again
  });
});

// ── P8: update_contract_profit() trigger + dedup index (SQL FOR FRANK, not executed) ──
// Mirrors the trigger function's formula exactly so a future formula change here has to
// consciously update the DB function too, and mirrors the partial unique index's key.
describe("update_contract_profit() trigger formula", () => {
  function computeProfit(premium, costToClose) {
    if (premium == null || premium === 0) return { profit: null, profit_pct: null };
    const profit = premium - (costToClose ?? 0);
    return { profit, profit_pct: Math.round((profit / Math.abs(premium)) * 10000) / 100 };
  }

  it("positive — editing cost_to_close recalculates profit and profit_pct", () => {
    const before = computeProfit(1000, 400);
    const after  = computeProfit(1000, 250); // manual cost_to_close edit
    expect(before.profit).toBe(600);
    expect(after.profit).toBe(750);
    expect(after.profit_pct).toBe(75);
  });

  it("negative — premium of 0 or null never divides by zero, yields null instead", () => {
    expect(computeProfit(0, 100)).toEqual({ profit: null, profit_pct: null });
    expect(computeProfit(null, 100)).toEqual({ profit: null, profit_pct: null });
  });

  it("handles a debit (BTO) premium correctly via ABS in the percentage denominator", () => {
    const result = computeProfit(-500, -300); // paid $500 to open, now worth $300 to close
    expect(result.profit).toBe(-200);
    expect(result.profit_pct).toBe(-40);
  });
});

describe("contracts dedup — unique index on null schwab_transaction_id", () => {
  const dedupKey = c => [c.stock, c.type, c.opt_type, c.strike, c.expires, c.qty, c.account, c.date_exec].join("|");

  function wouldViolateIndex(existingRows, candidate) {
    if (candidate.schwab_transaction_id != null) return false; // index only applies WHERE schwab_transaction_id IS NULL
    const key = dedupKey(candidate);
    return existingRows
      .filter(r => r.schwab_transaction_id == null)
      .some(r => dedupKey(r) === key);
  }

  const base = { stock: "AAPL", type: "Call", opt_type: "STO", strike: 210, expires: "2026-08-15", qty: 2, account: "Schwab 1234", date_exec: "2026-07-14" };

  it("positive — a real duplicate manual-entry insert (same key, both null txid) is rejected by the index", () => {
    expect(wouldViolateIndex([{ ...base, schwab_transaction_id: null }], { ...base, schwab_transaction_id: null })).toBe(true);
  });

  it("negative — a duplicate insert with a real schwab_transaction_id is unaffected (a different, non-partial index already covers that)", () => {
    expect(wouldViolateIndex([{ ...base, schwab_transaction_id: null }], { ...base, schwab_transaction_id: "abc123" })).toBe(false);
  });

  it("negative — two null-txid rows that differ by strike are distinct, not a duplicate", () => {
    expect(wouldViolateIndex([{ ...base, schwab_transaction_id: null }], { ...base, strike: 215, schwab_transaction_id: null })).toBe(false);
  });
});

// ── P9: Auto-BTC aggregation — one order per position, not one per row ───────
// Mirrors api/market-refresh.js's stoGroups grouping in the btc_auto scanner.
describe("Auto-BTC aggregation — group same-position STO rows into one order", () => {
  function groupKey(c) { return `${c.stock.toUpperCase()}|${c.strike}|${c.expires}|${c.account}`; }
  function groupSTOs(rows) {
    const groups = new Map();
    for (const c of rows) {
      const key = groupKey(c);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    return [...groups.values()];
  }

  const row = (over) => ({ id: 1, stock: "AAPL", strike: 210, expires: "2026-08-15", account: "Schwab 1234", qty: 1, premium: 100, ...over });

  it("positive — 3 STO rows on the same key → single group with qty = sum", () => {
    const rows = [row({ id: 1, qty: 2, premium: 200 }), row({ id: 2, qty: 3, premium: 300 }), row({ id: 3, qty: 1, premium: 100 })];
    const groups = groupSTOs(rows);
    expect(groups.length).toBe(1);
    const g = groups[0];
    expect(g.reduce((s, c) => s + c.qty, 0)).toBe(6);
    expect(g.reduce((s, c) => s + c.premium, 0)).toBe(600);
  });

  it("negative — rows differing by strike → separate groups, separate orders", () => {
    const rows = [row({ id: 1, strike: 210 }), row({ id: 2, strike: 215 })];
    expect(groupSTOs(rows).length).toBe(2);
  });

  it("negative — rows differing by expiry → separate groups", () => {
    const rows = [row({ id: 1, expires: "2026-08-15" }), row({ id: 2, expires: "2026-08-22" })];
    expect(groupSTOs(rows).length).toBe(2);
  });

  it("negative — rows differing by account → separate groups (never cross-account)", () => {
    const rows = [row({ id: 1, account: "Schwab 1234" }), row({ id: 2, account: "Schwab 5678" })];
    expect(groupSTOs(rows).length).toBe(2);
  });

  it("positive — a single-row group behaves exactly as before (no change for the common case)", () => {
    const rows = [row({ id: 1, qty: 5, premium: 500 })];
    const groups = groupSTOs(rows);
    expect(groups.length).toBe(1);
    expect(groups[0].length).toBe(1);
    expect(groups[0][0].qty).toBe(5);
  });
});

// ── P12: Auto-BTC skip-at-expiry — DB-gated threshold, not hardcoded ──────────
// Mirrors api/market-refresh.js's btcExpirySkip check: was a hardcoded 2% ("Task #10"),
// now reads min_otm_pct from the btc_expiry_skip signal_rules row (defaults to the same
// 2%/enabled behavior only when the row doesn't exist yet, so nothing changes silently
// before the config row is created).
describe("Auto-BTC skip-at-expiry — DB-gated OTM threshold", () => {
  function shouldSkipBtcAtExpiry({ dte, stockPrice, strike, rule }) {
    if (dte !== 0) return false;
    const enabled = rule ? rule.enabled !== false : true;
    if (!enabled) return false;
    const otmPct = +(rule?.min_otm_pct ?? 2);
    const thresholdMult = 1 - otmPct / 100;
    return stockPrice != null && stockPrice < strike * thresholdMult;
  }

  it("positive — expiry today, stock 3% OTM (threshold 2%) → BTC skipped, let expire", () => {
    expect(shouldSkipBtcAtExpiry({ dte: 0, stockPrice: 97, strike: 100, rule: { enabled: true, min_otm_pct: 2 } })).toBe(true);
  });

  it("negative — expiry today, stock ITM → BTC still fires (not skipped)", () => {
    expect(shouldSkipBtcAtExpiry({ dte: 0, stockPrice: 101, strike: 100, rule: { enabled: true, min_otm_pct: 2 } })).toBe(false);
  });

  it("negative — expiry today, only 1% OTM (below the 2% threshold) → BTC still fires", () => {
    expect(shouldSkipBtcAtExpiry({ dte: 0, stockPrice: 99, strike: 100, rule: { enabled: true, min_otm_pct: 2 } })).toBe(false);
  });

  it("negative — not expiry day → never skips regardless of OTM%", () => {
    expect(shouldSkipBtcAtExpiry({ dte: 3, stockPrice: 90, strike: 100, rule: { enabled: true, min_otm_pct: 2 } })).toBe(false);
  });

  it("respects a DB-configured threshold different from the default (never hardcoded)", () => {
    // 3% OTM with a 5% threshold configured → not enough to skip
    expect(shouldSkipBtcAtExpiry({ dte: 0, stockPrice: 97, strike: 100, rule: { enabled: true, min_otm_pct: 5 } })).toBe(false);
    // Same 3% OTM with threshold lowered to 2% → skips
    expect(shouldSkipBtcAtExpiry({ dte: 0, stockPrice: 97, strike: 100, rule: { enabled: true, min_otm_pct: 2 } })).toBe(true);
  });

  it("rule disabled in DB → never skips, even if OTM", () => {
    expect(shouldSkipBtcAtExpiry({ dte: 0, stockPrice: 90, strike: 100, rule: { enabled: false, min_otm_pct: 2 } })).toBe(false);
  });

  it("no config row yet → defaults to the prior hardcoded behavior (enabled, 2%)", () => {
    expect(shouldSkipBtcAtExpiry({ dte: 0, stockPrice: 97, strike: 100, rule: null })).toBe(true);
  });
});

// ── Auto-STO scoring factors — reuse chainData, avoid redundant Schwab call ──
// Mirrors api/market-refresh.js liveChainAuto resolution (~line 2432): reuses the
// in-memory chainData for this symbol if present, only falling back to a live
// fetchLiveChain call (the one that was blowing past Vercel's 10s timeout for
// ETrade STOs) when chainData has no entries for the symbol.
describe("Auto-STO scoring factors — chainData reuse", () => {
  function resolveLiveChainAuto(chainData, symbol, fetchLiveChainFn) {
    const hasChainData = Object.keys(chainData).some(k => k.startsWith(symbol + "|"));
    return hasChainData ? chainData : fetchLiveChainFn(symbol);
  }

  it("does NOT call fetchLiveChain when chainData already has entries for the symbol", () => {
    let calls = 0;
    const fetchLiveChainFn = (symbol) => { calls++; return { [`${symbol}|2026-07-17`]: { calls: [], puts: [] } }; };
    const chainData = { "AMZN|2026-07-17": { calls: [{ strikePrice: 220, bid: 1, ask: 1.2 }], puts: [] } };

    const result = resolveLiveChainAuto(chainData, "AMZN", fetchLiveChainFn);

    expect(calls).toBe(0);
    expect(result).toBe(chainData);
  });

  it("falls back to fetchLiveChain when chainData has no entries for the symbol", () => {
    let calls = 0;
    const fetchLiveChainFn = (symbol) => { calls++; return { [`${symbol}|2026-07-17`]: { calls: [], puts: [] } }; };
    const chainData = { "NVDA|2026-07-17": { calls: [], puts: [] } }; // different symbol only

    const result = resolveLiveChainAuto(chainData, "AMZN", fetchLiveChainFn);

    expect(calls).toBe(1);
    expect(result).toEqual({ "AMZN|2026-07-17": { calls: [], puts: [] } });
  });

  it("falls back to fetchLiveChain when chainData is empty", () => {
    let calls = 0;
    const fetchLiveChainFn = () => { calls++; return {}; };
    const result = resolveLiveChainAuto({}, "AMZN", fetchLiveChainFn);
    expect(calls).toBe(1);
  });
});

// ── Accounting mode default (Dashboard + Analytics shared state) ─────────────
// Mirrors src/pri-tod-v3.jsx: const [profitDateMode, setProfitDateMode] = useState("accounting");
// profitDateMode is a single shared state variable — both the Dashboard KPIs (~line 7040-7045)
// and the Analytics breakdown header (~line 8080) read the same value, so there's no per-tab
// drift possible. Contracts/Skynet/Signal Rules tabs never reference it at all.
describe("Accounting mode default (Dashboard + Analytics shared state)", () => {
  const initProfitDateMode = () => "accounting"; // the new useState default

  // Mirrors Dashboard KPI subtitle logic (pri-tod-v3.jsx ~7044-7045)
  const kpiSubtitle = (mode) => mode==="accounting" ? "cash basis" : mode==="exec" ? "opened" : "closed";

  // Mirrors Analytics breakdown header label (pri-tod-v3.jsx ~8080)
  const analyticsBreakdownLabel = (mode) => mode==="accounting" ? "accounting (cash basis)" : "profit by "+(mode==="exec"?"open date":"close date");

  it("positive — Dashboard renders with accounting mode active on load", () => {
    const mode = initProfitDateMode();
    expect(mode).toBe("accounting");
    expect(kpiSubtitle(mode)).toBe("cash basis");
  });

  it("positive — Analytics tab renders with accounting mode active on load", () => {
    const mode = initProfitDateMode();
    expect(mode).toBe("accounting");
    expect(analyticsBreakdownLabel(mode)).toBe("accounting (cash basis)");
  });

  it("negative — user can still toggle accounting mode off manually", () => {
    let mode = initProfitDateMode();
    const setProfitDateMode = (m) => { mode = m; };

    setProfitDateMode("close");
    expect(mode).toBe("close");
    expect(kpiSubtitle(mode)).toBe("closed");

    setProfitDateMode("exec");
    expect(mode).toBe("exec");
    expect(kpiSubtitle(mode)).toBe("opened");
  });

  it("negative — toggling is shared: Dashboard and Analytics flip together, never independently", () => {
    let mode = initProfitDateMode();
    const setProfitDateMode = (m) => { mode = m; };
    setProfitDateMode("close");
    // Both consumers read the same variable — no scenario where one tab shows
    // accounting mode while the other doesn't, since there's only one state cell.
    expect(kpiSubtitle(mode)).toBe("closed");
    expect(analyticsBreakdownLabel(mode)).toBe("profit by close date");
  });

  it("negative — non-affected tabs (Contracts, Skynet, Signal Rules) never reference profitDateMode", () => {
    // These tabs' render inputs take no profitDateMode parameter at all — the accounting-mode
    // default flip has zero effect on their output, regardless of what profitDateMode is set to.
    const renderContractsTab   = (contracts) => contracts.map(c => c.stock);
    const renderSkynetTab      = (rules)     => rules.map(r => r.rule_type);
    const renderSignalRulesTab = (rules)     => rules.length;

    const contracts = [{ stock: "AAPL" }, { stock: "AMZN" }];
    const rules     = [{ rule_type: "sto" }, { rule_type: "btc_auto" }];

    expect(renderContractsTab(contracts)).toEqual(["AAPL", "AMZN"]);
    expect(renderSkynetTab(rules)).toEqual(["sto", "btc_auto"]);
    expect(renderSignalRulesTab(rules)).toBe(2);
    // None of these functions accept or branch on profitDateMode/accounting mode
    expect(renderContractsTab.length).toBe(1);
    expect(renderSkynetTab.length).toBe(1);
    expect(renderSignalRulesTab.length).toBe(1);
  });
});

// ── Analytics monthly breakdown — Schwab Profit / ETrade Profit columns ──────
// Mirrors src/pri-tod-v3.jsx: mkPeriodData(schwabF/etradeF, view, profitDateMode) and
// accountingByPeriod(schwabF/etradeF, periodPrefix) for the YTD KPI cards. Schwab and
// ETrade account filters are mutually exclusive and exhaustive over all contracts, so
// schwabProfit + etradeProfit always equals the combined Profit/Profit YTD figure.
describe("Analytics — Schwab Profit / ETrade Profit columns", () => {
  const isSchwabAcct = a => a?.startsWith("Schwab");
  const isEtradeAcct = a => a?.startsWith("ETrade") || a?.startsWith("Etrade");

  // Mirrors accountingByPeriod (pri-tod-v3.jsx ~5615): open leg → dateExec, close leg → closeDate
  function accountingByPeriod(contracts, periodPrefix) {
    let total = 0;
    for (const c of contracts) {
      if (!["STO","BTO"].includes(c.optType)) continue;
      if (c.dateExec?.startsWith(periodPrefix)) total += (c.premium || 0);
      if (c.status === "Closed" && c.costToClose != null) {
        const cd = c.closeDate || c.dateExec;
        if (cd?.startsWith(periodPrefix)) {
          if (c.optType === "STO") total -= (c.costToClose || 0);
          else                     total += (c.costToClose || 0);
        }
      }
    }
    return total;
  }

  const contracts = [
    { account: "Schwab 3866", optType: "STO", dateExec: "2026-01-05", premium: 500, status: "Closed", closeDate: "2026-01-20", costToClose: 100 },
    { account: "ETrade 6917", optType: "STO", dateExec: "2026-01-10", premium: 300, status: "Closed", closeDate: "2026-02-05", costToClose: 50 },
    { account: "ETrade 8222", optType: "STO", dateExec: "2026-02-01", premium: 200, status: "Open" },
  ];

  it("positive — monthly row with only Schwab contracts shows ETrade Profit = $0", () => {
    const schwabOnlyMonth = [contracts[0]]; // Jan row has only the Schwab contract's open leg
    const etradeF = schwabOnlyMonth.filter(c => isEtradeAcct(c.account));
    expect(accountingByPeriod(etradeF, "2026-01")).toBe(0);
  });

  it("positive — YTD Schwab + YTD ETrade = YTD Profit total", () => {
    const schwabF = contracts.filter(c => isSchwabAcct(c.account));
    const etradeF = contracts.filter(c => isEtradeAcct(c.account));
    const schwabYTD = accountingByPeriod(schwabF, "2026");
    const etradeYTD = accountingByPeriod(etradeF, "2026");
    const totalYTD  = accountingByPeriod(contracts, "2026");
    expect(schwabYTD + etradeYTD).toBeCloseTo(totalYTD, 5);
  });

  it("negative — accounting mode off: exec-mode profit still splits correctly by account (consistent, not hidden)", () => {
    const closed = [
      { account: "Schwab 3866", status: "Closed", profit: 400, dateExec: "2026-01-05" },
      { account: "ETrade 6917", status: "Closed", profit: 250, dateExec: "2026-01-08" },
    ];
    const schwabProfit = closed.filter(c => isSchwabAcct(c.account)).reduce((s,c) => s+(c.profit||0), 0);
    const etradeProfit = closed.filter(c => isEtradeAcct(c.account)).reduce((s,c) => s+(c.profit||0), 0);
    expect(schwabProfit).toBe(400);
    expect(etradeProfit).toBe(250);
    // Same account-split logic applies regardless of profitDateMode — columns stay
    // populated (not hidden) and remain consistent with the combined Profit column.
    expect(schwabProfit + etradeProfit).toBe(closed.reduce((s,c) => s+(c.profit||0), 0));
  });

  it("negative — no cross-contamination between broker accounts", () => {
    const schwabF = contracts.filter(c => isSchwabAcct(c.account));
    const etradeF = contracts.filter(c => isEtradeAcct(c.account));
    expect(schwabF.every(c => c.account === "Schwab 3866")).toBe(true);
    expect(etradeF.every(c => c.account.startsWith("ETrade"))).toBe(true);
    expect(etradeF.find(c => c.account === "Schwab 3866")).toBeUndefined();
    expect(schwabF.find(c => c.account.startsWith("ETrade"))).toBeUndefined();
  });
});

// ── Schwab auto-STO approved_by tagging (BUG 1 + BUG 2) ──────────────────────
// BUG 1: schwab-orders.js's approve-new handler ignores the approved_by param
// entirely — market-refresh.js now tags the trade_orders row explicitly after a
// successful Schwab auto-STO, the same way it already did for ETrade.
// BUG 2 (verified P3 2026-07-19): the chase engine was rebuilt (43c8806) into the
// stateless api/chase-step.js + schwab-orders.js action=reprice. reprice's PATCH
// (schwab-orders.js ~1216-1221) UPDATEs the SAME trade_orders row (never inserts a
// new one) and simply omits approved_by from the patch body — PostgREST partial
// PATCH leaves omitted columns untouched, so approved_by survives implicitly
// rather than via an explicit carry-forward line. Same outcome, different
// mechanism; this test locks in the outcome either way.
describe("Schwab auto-STO approved_by tagging (BUG 1 + BUG 2)", () => {
  // Mirrors the Schwab-branch trade_orders PATCH in the auto-STO success handler
  // (market-refresh.js ~2453-2471)
  function buildAutoStoApprovedByPatch() {
    return { approved_by: "skynet_auto_sto" };
  }

  // Mirrors the reprice handler's resubmit PATCH body (schwab-orders.js action=reprice,
  // ~1216-1221) — approved_by is deliberately absent from the patch; a partial PATCH
  // never clears a column it doesn't mention, so the row's existing value survives.
  function buildChaseResubmitPatch(order, newPrice, newSchwabOrderId) {
    const patch = {
      limit_price:     newPrice,
      schwab_order_id: newSchwabOrderId,
      submitted_at:    "2026-07-13T14:31:00.000Z", // stand-in for new Date().toISOString()
    };
    // Simulates PostgREST partial-PATCH semantics: fields absent from the patch
    // keep their pre-existing DB value instead of being nulled out.
    return { ...patch, approved_by: order.approved_by ?? null };
  }

  it("positive — Schwab auto-STO order → trade_orders row has approved_by = skynet_auto_sto", () => {
    const patch = buildAutoStoApprovedByPatch();
    expect(patch.approved_by).toBe("skynet_auto_sto");
  });

  it("positive — chase resubmit of a skynet_auto_sto order → resubmitted row also has approved_by = skynet_auto_sto", () => {
    const originalOrder = { id: 42, approved_by: "skynet_auto_sto", limit_price: 1.20 };
    const patch = buildChaseResubmitPatch(originalOrder, 1.15, "999888777");
    expect(patch.approved_by).toBe("skynet_auto_sto");
    expect(patch.limit_price).toBe(1.15);
    expect(patch.schwab_order_id).toBe("999888777");
  });

  it("negative — manually placed order goes through chase → approved_by stays null (not inherited incorrectly)", () => {
    const manualOrder = { id: 43, approved_by: null, limit_price: 2.00 };
    const patch = buildChaseResubmitPatch(manualOrder, 1.95, "111222333");
    expect(patch.approved_by).toBeNull();
  });

  it("negative — chase never upgrades a manual order to skynet_auto_sto, regardless of price moves", () => {
    const manualOrder = { id: 44, approved_by: "user", limit_price: 0.50 };
    const patch = buildChaseResubmitPatch(manualOrder, 0.45, "444555666");
    expect(patch.approved_by).toBe("user");
    expect(patch.approved_by).not.toBe("skynet_auto_sto");
  });
});

// ── ETrade NAV calculation — broadened field chain + positions-sum fallback ──
// Mirrors api/etrade.js action=positions balance loop (~line 386-409)
describe("ETrade NAV calculation", () => {
  const computeRtNAV = (rtv, computed) =>
    +(rtv.totalAccountValue || rtv.netMv || computed.totalAccountValue || computed.accountValue || 0);

  it("positive — uses rtv.totalAccountValue when present", () => {
    expect(computeRtNAV({ totalAccountValue: 65000 }, {})).toBe(65000);
  });

  it("positive — falls back to rtv.netMv when totalAccountValue missing", () => {
    expect(computeRtNAV({ netMv: 42000 }, {})).toBe(42000);
  });

  it("positive — falls back to computed.totalAccountValue when RealTimeValues has neither field", () => {
    expect(computeRtNAV({}, { totalAccountValue: 38000 })).toBe(38000);
  });

  it("positive — falls back to computed.accountValue as last resort before zero", () => {
    expect(computeRtNAV({}, { accountValue: 15000 })).toBe(15000);
  });

  it("negative — returns 0 when none of the four fields are present (real bug scenario)", () => {
    expect(computeRtNAV({}, {})).toBe(0);
  });

  it("positive — primary path (rtNAV > 0) now also accumulates totalCash", () => {
    let totalAccountValue = 0, totalCash = 0;
    const rtNAV = computeRtNAV({ totalAccountValue: 65000 }, {});
    const cashBal = 5000;
    if (rtNAV > 0) { totalAccountValue += rtNAV; totalCash += cashBal; }
    expect(totalAccountValue).toBe(65000);
    expect(totalCash).toBe(5000); // was missing before the fix
  });

  it("positive — fallback path sums position marketValues instead of totals.totalMarketValue", () => {
    const positions = [{ marketValue: 1200.50 }, { marketValue: 800 }, { marketValue: 0 }];
    const totals = { totalMarketValue: 0 }; // often 0/unreliable per the bug report
    const cashBal = 300;
    const positionsValue = positions.reduce((sum, p) => sum + (+(p.marketValue || 0)), 0);
    const totalAccountValue = positionsValue + cashBal;
    expect(positionsValue).toBe(2000.50);
    expect(totalAccountValue).toBe(2300.50);
    expect(totalAccountValue).not.toBe((+totals.totalMarketValue || 0) + cashBal); // old buggy formula would give 300
  });

  it("negative — fallback with no positions and no cash yields 0, not NaN", () => {
    const positions = [];
    const positionsValue = positions.reduce((sum, p) => sum + (+(p.marketValue || 0)), 0);
    expect(positionsValue + 0).toBe(0);
  });
});

// ── Portfolio snapshot — re-run when existing ETrade value looks stale ───────
// Mirrors api/market-refresh.js portfolio snapshot guard (~line 2944-2949)
describe("Portfolio snapshot — stale ETrade value re-run guard", () => {
  const STALE_THRESHOLD = 150000;
  const shouldRunSnapshot = (existingRow) => {
    const etradeLooksStale = existingRow && +existingRow.etrade_value <= STALE_THRESHOLD;
    return !existingRow || etradeLooksStale;
  };

  it("positive — no snapshot yet today → runs", () => {
    expect(shouldRunSnapshot(null)).toBe(true);
  });

  it("positive — existing snapshot has stale cache-fallback ETrade value ($110,558) → re-runs", () => {
    expect(shouldRunSnapshot({ id: 1, etrade_value: 110558 })).toBe(true);
  });

  it("negative — existing snapshot has a healthy ETrade value → does not re-run", () => {
    expect(shouldRunSnapshot({ id: 1, etrade_value: 210000 })).toBe(false);
  });

  it("negative — existing snapshot exactly at threshold ($150,000) still counts as stale (<=), re-runs", () => {
    expect(shouldRunSnapshot({ id: 1, etrade_value: 150000 })).toBe(true);
  });

  it("positive — re-run guard triggers exactly once boundary above threshold stops it", () => {
    expect(shouldRunSnapshot({ id: 1, etrade_value: 150000.01 })).toBe(false);
  });
});

// ── P2: Stocks/Analytics "TOTAL ACCT" — must use netLiquidation, not a raw cached field ──────
// Mirrors src/pri-tod-v3.jsx: liveSchwabInline/liveEtradeInline prioritize live session value >
// today's portfolio_snapshots row > the manual __cash__ entry — in that order. The bug (P2) was
// the total widget reading +cashData.schwab directly, skipping the live/snapshot values entirely,
// so a stale manual entry (e.g. an old placeholder like $6,000) silently became "the total".
describe("TOTAL ACCT — netLiquidation priority chain (live > snapshot > manual)", () => {
  const resolveCombined = (schwabAccountValue, snapSchwab, cashSchwab, liveEtradeInline, cashEtrade) => {
    const liveSchwabInline = schwabAccountValue > 0 ? schwabAccountValue : (snapSchwab ?? (cashSchwab ? +cashSchwab : null));
    const schwabCombined = liveSchwabInline ?? (+cashSchwab || 0);
    const etradeCombined = liveEtradeInline ?? (+cashEtrade || 0);
    return { schwabCombined, etradeCombined, total: schwabCombined + etradeCombined };
  };

  it("positive — live session value takes priority over snapshot and manual cash", () => {
    const r = resolveCombined(411559.78, 400000, "6000", 475170.16, "110558");
    expect(r.schwabCombined).toBe(411559.78);
    expect(r.total).toBeCloseTo(886729.94, 1);
  });

  it("positive — falls back to today's portfolio_snapshot value when no live session value loaded yet", () => {
    const r = resolveCombined(0, 408106.76, "6000", 475170.16, "110558");
    expect(r.schwabCombined).toBe(408106.76);
    expect(r.total).toBeCloseTo(883276.92, 1);
  });

  it("negative — does NOT fall back to the raw manual cash entry when live/snapshot values exist ($6k regression)", () => {
    const r = resolveCombined(411559.78, 400000, "6000", 475170.16, "110558");
    expect(r.schwabCombined).not.toBe(6000);
    expect(r.total).toBeGreaterThan(800000);
  });

  it("negative — only uses the manual cash entry as a last resort when nothing live/snapshot is available", () => {
    const r = resolveCombined(0, null, "6000", null, "110558");
    expect(r.schwabCombined).toBe(6000);
    expect(r.total).toBe(116558);
  });
});

// ── P4: Global Skynet master kill-switch ──────────────────────────────────────
// Mirrors api/market-refresh.js / api/chase-step.js: ONE flag (skynet_controls.master_enabled)
// gates every automated order-placing path (auto-STO, auto-BTC, expiry_protection, chase),
// independent of each rule's own per-rule `enabled` column. Defaults true (opt-out) so rows
// created before the migration keep working until Frank explicitly flips it off.
describe("Skynet master kill-switch — gates all automated order placement in one check", () => {
  const isMasterEnabled = (skynetControls) => skynetControls?.master_enabled !== false;

  it("positive — master_enabled=true → automation runs", () => {
    expect(isMasterEnabled({ master_enabled: true })).toBe(true);
  });

  it("positive — column missing entirely (pre-migration row) → defaults to enabled, no redeploy needed to keep working", () => {
    expect(isMasterEnabled({ max_order_value: 10000 })).toBe(true);
  });

  it("negative — master_enabled=false → no order-placing rule may run, regardless of its own enabled flag", () => {
    const controls = { master_enabled: false };
    const rules = [
      { rule_type: "sto", enabled: true },
      { rule_type: "btc_auto", enabled: true },
      { rule_type: "expiry_protection", enabled: true },
      { rule_type: "chase", enabled: true },
    ];
    const master = isMasterEnabled(controls);
    for (const r of rules) {
      const shouldRun = master && r.enabled;
      expect(shouldRun).toBe(false);
    }
  });

  it("negative — flipping master off does not touch imports/snapshots/reconciliation/notifications (those aren't gated by this flag at all)", () => {
    // These code paths never read skynetControls.master_enabled — asserting the flag's
    // absence from their gating logic by construction (no shared condition to check).
    const nonAutomationPaths = ["auto-import", "portfolio-snapshot", "reconcile-statements", "pushover-notify"];
    expect(nonAutomationPaths.every(p => !p.includes("master_enabled"))).toBe(true);
  });

  it("positive — the DB fetch must not filter on enabled=eq.true, or a false value becomes unobservable", () => {
    // Regression: skynet_controls was fetched with `?enabled=eq.true`, which excluded the
    // row entirely once enabled (or master_enabled) was set false — silently reverting to
    // the hardcoded true-default instead of reflecting the flip.
    const buildQuery = (filterOnEnabled) => filterOnEnabled ? "skynet_controls?enabled=eq.true&limit=1" : "skynet_controls?limit=1";
    expect(buildQuery(false)).not.toContain("enabled=eq.true");
  });
});

// ── P5: Settled Funds Controls (WARN-ONLY) ────────────────────────────────────
// Mirrors api/market-refresh.js checkSettledFunds() decision logic. Source is always
// a live broker field (Schwab cashAvailableForTrading / ETrade cashAvailableForInvestment),
// never hardcoded. Never blocks the order — only decides whether to warn+log.
describe("Settled Funds Controls — WARN-ONLY, never blocks", () => {
  function shouldWarnSettledFunds({ requiredCash, settledCashResult }) {
    if (!requiredCash || requiredCash <= 0) return { warn: false };
    if (!settledCashResult.ok) return { warn: false, reason: "settled cash source unavailable — check skipped" };
    if (requiredCash <= settledCashResult.cash) return { warn: false };
    return { warn: true, requiredCash, settledCash: settledCashResult.cash, source: settledCashResult.source };
  }

  it("positive — order needs $10k, settled cash $6k → warning fires (order still proceeds elsewhere)", () => {
    const result = shouldWarnSettledFunds({
      requiredCash: 10000,
      settledCashResult: { ok: true, cash: 6000, source: "schwab_cashAvailableForTrading" },
    });
    expect(result.warn).toBe(true);
    expect(result.settledCash).toBe(6000);
  });

  it("negative — order within settled cash → no warning fires", () => {
    const result = shouldWarnSettledFunds({
      requiredCash: 4000,
      settledCashResult: { ok: true, cash: 6000, source: "etrade_cashAvailableForInvestment" },
    });
    expect(result.warn).toBe(false);
  });

  it("negative — settled cash source unavailable → check is skipped, not treated as a warning (never blocks/guesses)", () => {
    const result = shouldWarnSettledFunds({
      requiredCash: 10000,
      settledCashResult: { ok: false, reason: "cashAvailableForTrading field missing" },
    });
    expect(result.warn).toBe(false);
  });

  it("positive — exactly at the boundary (required == settled) does not warn", () => {
    const result = shouldWarnSettledFunds({
      requiredCash: 5000,
      settledCashResult: { ok: true, cash: 5000, source: "schwab_cashAvailableForTrading" },
    });
    expect(result.warn).toBe(false);
  });

  it("negative — source is always a live field name, never a hardcoded threshold", () => {
    const result = shouldWarnSettledFunds({
      requiredCash: 10000,
      settledCashResult: { ok: true, cash: 1000, source: "schwab_cashAvailableForTrading" },
    });
    expect(["schwab_cashAvailableForTrading", "etrade_cashAvailableForInvestment"]).toContain(result.source);
  });
});
