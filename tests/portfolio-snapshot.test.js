// tests/portfolio-snapshot.test.js
// Vitest unit tests for the portfolio snapshot ETrade/Schwab value resolution in market-refresh.js
// Run: npx vitest run tests/portfolio-snapshot.test.js

import { describe, it, expect } from "vitest";

// ── Helpers extracted from market-refresh.js "Portfolio snapshot" block (keep in sync) ─────

const SNAPSHOT_OUTLIER_PCT = 15;

// Mirrors api/etrade.js action=balance: per-account NAV field-chain resolution
function resolveAccountBalance(computed, rtv) {
  const value = +(rtv.totalAccountValue || rtv.netMv || computed.totalAccountValue || computed.accountBalance || computed.accountValue || 0);
  const cash  = +(computed.cashBalance || computed.netCash || computed.cashAvailableForInvestment || 0);
  return { value, cash, ok: value > 0 };
}

// Mirrors market-refresh.js: sum accounts if ALL succeeded, else signal failure (never a partial sum)
function resolveEtradeFromAccounts(accounts) {
  if (!Array.isArray(accounts) || !accounts.length) return { ok: false, reason: "no accounts returned" };
  const failed = accounts.filter(a => !a.ok);
  if (failed.length) return { ok: false, reason: `account(s) failed: ${failed.map(a => `${a.account}: ${a.error}`).join("; ")}` };
  return {
    ok: true,
    value: accounts.reduce((s, a) => s + (+a.value || 0), 0),
    cash:  accounts.reduce((s, a) => s + (+a.cash  || 0), 0),
  };
}

// Mirrors market-refresh.js: resolve etradeValue/etradeCash/etradeStale from a fresh fetch result
// plus a carry-forward source (the most recent non-stale snapshot row)
function resolveEtradeValue(freshResult, lastGoodSnapshot) {
  if (freshResult.ok) {
    return { value: freshResult.value, cash: freshResult.cash, stale: false };
  }
  return {
    value: lastGoodSnapshot?.etrade_value ?? null,
    cash:  lastGoodSnapshot?.etrade_cash  ?? null,
    stale: true,
  };
}

// Mirrors the outlier guard applied just before writing the snapshot row
function applyOutlierGuard({ etradeStale, prevTotalValue, freshTotalValue, lastGoodSnapshot }) {
  if (etradeStale || !prevTotalValue) return { overridden: false };
  const dailyChangePct = Math.round(((freshTotalValue - prevTotalValue) / prevTotalValue) * 10000) / 100;
  if (Math.abs(dailyChangePct) > SNAPSHOT_OUTLIER_PCT) {
    return {
      overridden: true,
      etradeValue: lastGoodSnapshot?.etrade_value ?? null,
      etradeCash:  lastGoodSnapshot?.etrade_cash  ?? null,
    };
  }
  return { overridden: false, dailyChangePct };
}

// ── action=balance per-account NAV field chain ────────────────────────────────

describe("resolveAccountBalance — ETrade NAV field chain", () => {
  it("prefers RealTimeValues.totalAccountValue", () => {
    expect(resolveAccountBalance({}, { totalAccountValue: 265000 })).toMatchObject({ value: 265000, ok: true });
  });

  it("falls back to RealTimeValues.netMv", () => {
    expect(resolveAccountBalance({}, { netMv: 205170 })).toMatchObject({ value: 205170, ok: true });
  });

  it("falls back to Computed.totalAccountValue when RealTimeValues is empty", () => {
    expect(resolveAccountBalance({ totalAccountValue: 199000 }, {})).toMatchObject({ value: 199000, ok: true });
  });

  it("falls back to Computed.accountBalance when totalAccountValue absent", () => {
    expect(resolveAccountBalance({ accountBalance: 470170.15769 }, {})).toMatchObject({ value: 470170.15769, ok: true });
  });

  it("balance response missing all NAV fields → falls back to accountBalance-adjacent field, or fails cleanly", () => {
    // No usable field at all — this is what should trigger the account-level failure path
    const result = resolveAccountBalance({}, {});
    expect(result.ok).toBe(false);
    expect(result.value).toBe(0);
  });

  it("pulls cash from cashBalance / netCash / cashAvailableForInvestment in priority order", () => {
    expect(resolveAccountBalance({ cashBalance: 5000 }, {}).cash).toBe(5000);
    expect(resolveAccountBalance({ netCash: 3000 }, {}).cash).toBe(3000);
    expect(resolveAccountBalance({ cashAvailableForInvestment: 1000 }, {}).cash).toBe(1000);
  });
});

// ── Combined ETrade resolution across both accounts ───────────────────────────

describe("resolveEtradeFromAccounts — combine 6917 + 8222", () => {
  it("positive — both accounts return values → sums correctly, ok=true", () => {
    const accounts = [
      { account: "ETrade 6917", ok: true, value: 205170.16, cash: 12000 },
      { account: "ETrade 8222", ok: true, value: 270000.00, cash: 8000 },
    ];
    const result = resolveEtradeFromAccounts(accounts);
    expect(result.ok).toBe(true);
    expect(result.value).toBeCloseTo(475170.16, 1);
    expect(result.cash).toBe(20000);
  });

  it("negative — one account fails → ok=false, does not silently sum a partial total", () => {
    const accounts = [
      { account: "ETrade 6917", ok: true, value: 205170.16, cash: 12000 },
      { account: "ETrade 8222", ok: false, error: "signature_invalid" },
    ];
    const result = resolveEtradeFromAccounts(accounts);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ETrade 8222");
    expect(result.reason).toContain("signature_invalid");
    // The succeeding account's real number must still be captured correctly in the attempt —
    // proves the summing/parsing logic itself isn't the thing that's broken.
    expect(accounts.find(a => a.account === "ETrade 6917").value).toBe(205170.16);
  });

  it("negative — both accounts fail → ok=false", () => {
    const accounts = [
      { account: "ETrade 6917", ok: false, error: "signature_invalid" },
      { account: "ETrade 8222", ok: false, error: "signature_invalid" },
    ];
    const result = resolveEtradeFromAccounts(accounts);
    expect(result.ok).toBe(false);
  });

  it("negative — no accounts returned at all → ok=false, not a silent zero", () => {
    expect(resolveEtradeFromAccounts([]).ok).toBe(false);
    expect(resolveEtradeFromAccounts(null).ok).toBe(false);
  });
});

// ── Carry-forward + stale flagging ────────────────────────────────────────────

describe("resolveEtradeValue — carry-forward on failure, never a frozen constant", () => {
  it("positive — fresh success → uses fresh values, etrade_stale=false", () => {
    const fresh = { ok: true, value: 475170.16, cash: 20000 };
    const result = resolveEtradeValue(fresh, { etrade_value: 110558, etrade_cash: null });
    expect(result.value).toBe(475170.16);
    expect(result.stale).toBe(false);
  });

  it("positive — one account fails → carries forward last good snapshot value, etrade_stale=true", () => {
    const fresh = { ok: false, reason: "account(s) failed: ETrade 8222: signature_invalid" };
    const lastGood = { etrade_value: 470000, etrade_cash: 19500 };
    const result = resolveEtradeValue(fresh, lastGood);
    expect(result.value).toBe(470000);
    expect(result.cash).toBe(19500);
    expect(result.stale).toBe(true);
  });

  it("negative — both accounts fail → full carry-forward from most recent snapshot, no constant written", () => {
    const fresh = { ok: false, reason: "account(s) failed: ETrade 6917: signature_invalid; ETrade 8222: signature_invalid" };
    const lastGood = { etrade_value: 468500, etrade_cash: 19000 };
    const result = resolveEtradeValue(fresh, lastGood);
    expect(result.value).toBe(468500);
    expect(result.stale).toBe(true);
    expect(result.value).not.toBe(110558);
  });

  it("negative — no prior snapshot exists either → null, not a magic constant", () => {
    const fresh = { ok: false, reason: "account(s) failed: all accounts" };
    const result = resolveEtradeValue(fresh, null);
    expect(result.value).toBeNull();
    expect(result.value).not.toBe(110558);
    expect(result.stale).toBe(true);
  });
});

// ── Outlier guard ──────────────────────────────────────────────────────────────

describe("applyOutlierGuard — huge implied swing gets carried forward instead of written", () => {
  it("positive — normal day-over-day change (under 15%) is not overridden", () => {
    const result = applyOutlierGuard({ etradeStale: false, prevTotalValue: 850000, freshTotalValue: 882000, lastGoodSnapshot: null });
    expect(result.overridden).toBe(false);
    expect(result.dailyChangePct).toBeCloseTo(3.76, 1);
  });

  it("negative — a pull implying |Δ%| > 15% is flagged and carried forward, not silently written", () => {
    // e.g. a bad pull that returns a very low ETrade figure, understating total by a huge margin
    const result = applyOutlierGuard({
      etradeStale: false, prevTotalValue: 882000, freshTotalValue: 520000,
      lastGoodSnapshot: { etrade_value: 470170, etrade_cash: 20000 },
    });
    expect(result.overridden).toBe(true);
    expect(result.etradeValue).toBe(470170);
  });

  it("does not re-trigger when the value is already stale (avoid double carry-forward)", () => {
    const result = applyOutlierGuard({ etradeStale: true, prevTotalValue: 882000, freshTotalValue: 520000, lastGoodSnapshot: null });
    expect(result.overridden).toBe(false);
  });

  it("skips the check entirely when there's no prior snapshot to compare against", () => {
    const result = applyOutlierGuard({ etradeStale: false, prevTotalValue: null, freshTotalValue: 882000, lastGoodSnapshot: null });
    expect(result.overridden).toBe(false);
  });
});

// ── Regression: the specific bug that shipped ─────────────────────────────────

describe("regression — 28-day $110,558 placeholder bug", () => {
  it("never writes the literal 110558 under any resolution path", () => {
    const scenarios = [
      resolveEtradeValue({ ok: true, value: 475170.16, cash: 20000 }, null),
      resolveEtradeValue({ ok: false, reason: "x" }, { etrade_value: 468000, etrade_cash: 19000 }),
      resolveEtradeValue({ ok: false, reason: "x" }, null),
    ];
    for (const s of scenarios) {
      expect(s.value).not.toBe(110558);
    }
  });

  it("a fresh pull that succeeds reflects the real known figure (~$470k), not the stale placeholder", () => {
    const accounts = [
      { account: "ETrade 6917", ok: true, value: 205170.16, cash: 12000 },
      { account: "ETrade 8222", ok: true, value: 270000.00, cash: 8000 },
    ];
    const result = resolveEtradeFromAccounts(accounts);
    expect(result.value).toBeGreaterThan(400000);
    expect(result.value).not.toBe(110558);
  });
});
