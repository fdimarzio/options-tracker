// tests/leap-guard.test.js
// LEAPS long-term-cap-gains protection — a contract opened with > 365 DTE must
// never be auto-BTC'd on a routine profit-threshold hit, even once its remaining
// DTE has dropped well below 365. DB-gated via the protect_leaps_ltcg signal_rules
// row (default enabled, default live/non-dry-run).
// Run: npx vitest run tests/leap-guard.test.js

import { describe, it, expect } from "vitest";
import { computeOrigDte, shouldBlockForLeapProtection } from "../api/_lib/leapGuard.js";

describe("computeOrigDte", () => {
  it("uses entry_dte when present", () => {
    expect(computeOrigDte(400, "2099-01-01", "2098-01-01")).toBe(400);
  });

  it("edge — entry_dte null falls back to expires - date_exec", () => {
    // 2026-08-01 -> 2026-08-08 is 7 days
    expect(computeOrigDte(null, "2026-08-08", "2026-08-01")).toBe(7);
  });

  it("edge — entry_dte undefined also falls back", () => {
    expect(computeOrigDte(undefined, "2027-08-01", "2026-08-01")).toBe(365);
  });
});

describe("shouldBlockForLeapProtection", () => {
  it("positive — CAT LEAP opened at 400 DTE, now 150 DTE, rule enabled+live -> blocked", () => {
    const origDte = computeOrigDte(400, "irrelevant", "irrelevant"); // entry_dte wins regardless of current DTE
    const result = shouldBlockForLeapProtection({ origDte, ruleEnabled: true, dryRun: false });
    expect(result.isLeap).toBe(true);
    expect(result.blocked).toBe(true);
  });

  it("positive (normal) — weekly opened at 7 DTE hits threshold -> not a LEAP, closes as today", () => {
    const result = shouldBlockForLeapProtection({ origDte: 7, ruleEnabled: true, dryRun: false });
    expect(result.isLeap).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it("negative — rule disabled -> behaves as before (not blocked) even for a LEAP", () => {
    const result = shouldBlockForLeapProtection({ origDte: 400, ruleEnabled: false, dryRun: false });
    expect(result.isLeap).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("negative — rule in dry_run -> behaves as before (not blocked) even for a LEAP", () => {
    const result = shouldBlockForLeapProtection({ origDte: 400, ruleEnabled: true, dryRun: true });
    expect(result.isLeap).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("boundary — exactly 365 DTE IS a LEAP (threshold is >= 365)", () => {
    const result = shouldBlockForLeapProtection({ origDte: 365, ruleEnabled: true, dryRun: false });
    expect(result.isLeap).toBe(true);
    expect(result.blocked).toBe(true);
  });

  it("boundary — 364 DTE is NOT a LEAP", () => {
    const result = shouldBlockForLeapProtection({ origDte: 364, ruleEnabled: true, dryRun: false });
    expect(result.isLeap).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it("boundary — 366 DTE is a LEAP", () => {
    const result = shouldBlockForLeapProtection({ origDte: 366, ruleEnabled: true, dryRun: false });
    expect(result.isLeap).toBe(true);
  });

  it("defaults to protecting (enabled=true, dry_run=false) when rule flags are omitted — fail safe, not fail open", () => {
    const result = shouldBlockForLeapProtection({ origDte: 400 });
    expect(result.blocked).toBe(true);
  });
});
