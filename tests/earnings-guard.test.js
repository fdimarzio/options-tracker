// tests/earnings-guard.test.js
// Earnings-date awareness — block/down-rank any STO candidate whose expiry falls
// on/after the underlying's next earnings date (AMZN was sold across earnings and
// took a large loss). Covers the pure guard function plus source-level wiring
// checks for both Skynet STO scanners in api/market-refresh.js.
// Run: npx vitest run tests/earnings-guard.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { isExpiryBlockedByEarnings } from "../api/_lib/earningsGuard.js";

const marketRefreshSrc = fs.readFileSync(path.resolve("api/market-refresh.js"), "utf8");
const sqlSrc           = fs.readFileSync(path.resolve("sql/earnings_dates.sql"), "utf8");
const scriptSrc        = fs.readFileSync(path.resolve("scripts/earnings-refresh.js"), "utf8");
const workflowSrc      = fs.readFileSync(path.resolve(".github/workflows/earnings-refresh.yml"), "utf8");

describe("isExpiryBlockedByEarnings", () => {
  it("positive — AMZN weekly expiring 2 days after earnings is blocked", () => {
    const { blocked, reason } = isExpiryBlockedByEarnings("2026-08-10", "2026-08-08", 0);
    expect(blocked).toBe(true);
    expect(reason).toBe("earnings_before_expiry");
  });

  it("negative — expiry before earnings is allowed", () => {
    const { blocked } = isExpiryBlockedByEarnings("2026-08-05", "2026-08-08", 0);
    expect(blocked).toBe(false);
  });

  it("edge — symbol missing from earnings_dates (nextEarnings null) is not blocked, flagged for a warning", () => {
    const { blocked, reason } = isExpiryBlockedByEarnings("2026-08-10", null, 0);
    expect(blocked).toBe(false);
    expect(reason).toBe("no_earnings_data");
  });

  it("boundary — expiry exactly ON earnings date is blocked (on/after, not just after)", () => {
    const { blocked } = isExpiryBlockedByEarnings("2026-08-08", "2026-08-08", 0);
    expect(blocked).toBe(true);
  });

  it("respects a configurable buffer — avoid_earnings_days pushes the cutoff earlier", () => {
    // Earnings 2026-08-08, 3-day buffer -> cutoff 2026-08-05. Expiry 2026-08-06 now blocked.
    expect(isExpiryBlockedByEarnings("2026-08-06", "2026-08-08", 3).blocked).toBe(true);
    // Expiry 2026-08-04 is still before the buffered cutoff -> allowed.
    expect(isExpiryBlockedByEarnings("2026-08-04", "2026-08-08", 3).blocked).toBe(false);
  });

  it("default buffer is 0 when omitted", () => {
    expect(isExpiryBlockedByEarnings("2026-08-08", "2026-08-08").blocked).toBe(true);
  });
});

describe("api/market-refresh.js — earnings guard wiring", () => {
  it("both STO scanners gate the earnings check behind avoidEarningsEnabled", () => {
    const occurrences = marketRefreshSrc.match(/if \(avoidEarningsEnabled\)/g) || [];
    expect(occurrences.length).toBe(2); // STO Rules Scanner + Auto-STO Scanner
  });

  it("both scanners call isExpiryBlockedByEarnings with the buffer", () => {
    const occurrences = marketRefreshSrc.match(/isExpiryBlockedByEarnings\(chainExpiry, nextEarningsBySymbol\[symbol\], avoidEarningsBufferDays\)/g) || [];
    expect(occurrences.length).toBe(2);
  });

  it("the avoid_earnings signal_rules fetch is NOT filtered by enabled=eq.true (would make disabled invisible)", () => {
    expect(marketRefreshSrc).toContain("rest/v1/signal_rules?rule_type=eq.avoid_earnings&limit=1");
    expect(marketRefreshSrc).not.toContain("rest/v1/signal_rules?rule_type=eq.avoid_earnings&enabled=eq.true");
  });

  it("avoidEarningsEnabled fails OPEN (false) when the rule row doesn't exist yet", () => {
    expect(marketRefreshSrc).toContain('avoidEarningsRule ? avoidEarningsRule.enabled === true : false');
  });

  it("earnings-blocked candidates are logged, not silently dropped, in both scanners", () => {
    expect(marketRefreshSrc).toContain("earnings suppressed:");
    expect(marketRefreshSrc).toContain("auto-STO skipped — earnings");
  });
});

describe("sql/earnings_dates.sql", () => {
  it("creates earnings_dates with symbol as primary key", () => {
    expect(sqlSrc).toMatch(/symbol\s+text PRIMARY KEY/);
    expect(sqlSrc).toContain("next_earnings");
    expect(sqlSrc).toContain("prev_earnings");
  });

  it("adds avoid_earnings_days to signal_rules and defaults the rule to disabled (new filter, opt-in rollout)", () => {
    expect(sqlSrc).toContain("ADD COLUMN IF NOT EXISTS avoid_earnings_days");
    expect(sqlSrc).toMatch(/'avoid_earnings',\s*'[^']*',\s*false/);
  });
});

describe("scripts/earnings-refresh.js", () => {
  it("upserts on_conflict=symbol (idempotent, per the Prompt 2 lesson)", () => {
    expect(scriptSrc).toContain("earnings_dates?on_conflict=symbol");
    expect(scriptSrc).toContain("resolution=merge-duplicates");
  });

  it("does not reuse the LLM-generated ticker_catalysts flow for gating logic", () => {
    expect(scriptSrc).not.toContain('mode: "catalyst_fetch"');
    expect(scriptSrc).not.toContain("rest/v1/ticker_catalysts");
  });
});

describe(".github/workflows/earnings-refresh.yml", () => {
  it("runs nightly before market open and can be triggered manually", () => {
    expect(workflowSrc).toMatch(/cron:\s*['"]0 10 \* \* \*['"]/);
    expect(workflowSrc).toContain("workflow_dispatch");
  });
});
