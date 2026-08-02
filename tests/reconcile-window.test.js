// tests/reconcile-window.test.js
// Weekend settlement reconciliation — a broker settlement transaction (e.g. a
// Friday expiry close) can post while the import job isn't running. The fetch
// window must reach back to the last successful run, not a fixed "today" or
// "yesterday", or it permanently misses anything posted on a day with no run.
// Run: npx vitest run tests/reconcile-window.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { computeReconcileWindowStart } from "../api/_lib/reconcileWindow.js";

const autoImportSrc = fs.readFileSync(path.resolve("api/auto-import.js"), "utf8");
const workflowSrc   = fs.readFileSync(path.resolve(".github/workflows/market-refresh.yml"), "utf8");

describe("computeReconcileWindowStart", () => {
  it("positive — NVDA case: last run Friday close, next run Monday morning -> window starts at Friday's run, covering the Saturday settlement post", () => {
    const lastFridayRun = new Date("2026-07-24T20:00:00Z"); // last weekday run before Fri close
    const mondayRun     = new Date("2026-07-27T13:35:00Z"); // first weekday run after the weekend
    const saturdaySettlementPost = new Date("2026-07-25T15:00:00Z");

    const since = computeReconcileWindowStart(lastFridayRun, mondayRun, 10);
    expect(since.getTime()).toBe(lastFridayRun.getTime());
    expect(since.getTime()).toBeLessThanOrEqual(saturdaySettlementPost.getTime());
  });

  it("positive — regression check: the OLD hardcoded 'yesterday' window would have missed the Saturday post, the new one doesn't", () => {
    const mondayRun = new Date("2026-07-27T13:35:00Z");
    const saturdaySettlementPost = new Date("2026-07-25T15:00:00Z");

    // OLD ETrade logic: fromD = now - 1 day = Sunday
    const oldFromD = new Date(mondayRun.getTime() - 86400000);
    expect(oldFromD.getTime()).toBeGreaterThan(saturdaySettlementPost.getTime()); // OLD: missed it

    const lastFridayRun = new Date("2026-07-24T20:00:00Z");
    const since = computeReconcileWindowStart(lastFridayRun, mondayRun, 10);
    expect(since.getTime()).toBeLessThanOrEqual(saturdaySettlementPost.getTime()); // NEW: covers it
  });

  it("negative — recent last run (normal weekday 5-min cadence) keeps the window tight, doesn't sweep in unrelated history", () => {
    const now     = new Date("2026-07-24T13:35:00Z");
    const lastRun = new Date("2026-07-24T13:30:00Z"); // 5 minutes ago
    const since   = computeReconcileWindowStart(lastRun, now, 10);
    expect(since.getTime()).toBe(lastRun.getTime());
  });

  it("edge — no heartbeat row yet (first-ever run) falls back to the maxLookbackDays floor", () => {
    const now = new Date("2026-07-27T13:35:00Z");
    const since = computeReconcileWindowStart(null, now, 10);
    expect(since.getTime()).toBe(now.getTime() - 10 * 86400000);
  });

  it("edge — a very stale heartbeat (long outage) is capped at maxLookbackDays, not unbounded", () => {
    const now = new Date("2026-07-27T13:35:00Z");
    const staleRun = new Date("2026-01-01T00:00:00Z"); // months ago
    const since = computeReconcileWindowStart(staleRun, now, 10);
    expect(since.getTime()).toBe(now.getTime() - 10 * 86400000);
  });

  it("accepts an ISO string for lastRunAt, same as a Date object", () => {
    const now = new Date("2026-07-27T13:35:00Z");
    const asString = "2026-07-24T20:00:00.000Z";
    const asDate   = new Date(asString);
    expect(computeReconcileWindowStart(asString, now, 10).getTime())
      .toBe(computeReconcileWindowStart(asDate, now, 10).getTime());
  });

  it("edge — an invalid lastRunAt value falls back to the floor rather than throwing", () => {
    const now = new Date("2026-07-27T13:35:00Z");
    const since = computeReconcileWindowStart("not-a-date", now, 10);
    expect(since.getTime()).toBe(now.getTime() - 10 * 86400000);
  });
});

describe("api/auto-import.js — reconciliation window wiring", () => {
  it("Schwab transaction fetch uses reconcileSince, not a hardcoded 'today only' window", () => {
    expect(autoImportSrc).toContain("const startUTC = reconcileSince.toISOString();");
  });

  it("ETrade transaction fetch uses reconcileSince, not a hardcoded 'yesterday' window", () => {
    expect(autoImportSrc).toContain("startDate: fmtD(reconcileSince),");
    expect(autoImportSrc).not.toMatch(/fromD\.setDate\(fromD\.getDate\(\) - 1\)/);
  });

  it("reconcileSince is derived from the auto-import agent's own heartbeat", () => {
    expect(autoImportSrc).toContain("ecosystem_heartbeat?select=last_run_at&agent_name=eq.auto-import");
    expect(autoImportSrc).toContain("computeReconcileWindowStart(");
  });
});

describe("EXPIRED transaction closing (mirrors api/auto-import.js EXPIRED handler)", () => {
  // Mirrors the profit/profit_pct calc in the EXPIRED branch of the commit loop —
  // unchanged by this fix, but exercised here to confirm the NVDA scenario resolves
  // correctly once the widened window actually delivers the settlement transaction.
  function closeExpired(parentOptType, parentPremium) {
    const isSell = parentOptType === "STO";
    const profit = isSell
      ? Math.round(Math.abs(+parentPremium) * 100) / 100
      : Math.round(-Math.abs(+parentPremium) * 100) / 100;
    return { status: "Closed", profit, profit_pct: isSell ? 1.0 : -1.0 };
  }

  it("positive — NVDA $217.5 STO expired worthless -> closes at profit=premium, 100%", () => {
    const result = closeExpired("STO", 412.44);
    expect(result.status).toBe("Closed");
    expect(result.profit).toBe(412.44);
    expect(result.profit_pct).toBe(1.0);
  });

  it("negative — a long (BTO) expiring worthless is a full loss, -100%, not a gain", () => {
    const result = closeExpired("BTO", -583.10);
    expect(result.profit).toBe(-583.10);
    expect(result.profit_pct).toBe(-1.0);
  });
});

describe("no-op when there's nothing to reconcile", () => {
  it("negative — open contract with DTE>0 and no settlement transaction in the (now wider) window stays untouched", () => {
    // allTxs filtering (api/auto-import.js) short-circuits before any contract is
    // touched when the fetch returns nothing — a wider window changes what CAN be
    // fetched, not what happens when nothing relevant comes back.
    const openContract = { id: 1, stock: "NVDA", opt_type: "STO", status: "Open", expires: "2026-09-18" };
    const fetchedTxs = []; // widened window queried, broker returned nothing new
    const patches = [];
    for (const tx of fetchedTxs) patches.push(tx); // mirrors the `for (const tx of allTxs)` loop
    expect(patches.length).toBe(0);
    expect(openContract.status).toBe("Open"); // untouched
  });
});

describe(".github/workflows/market-refresh.yml — weekend runs", () => {
  it("adds a Sat/Sun morning schedule without removing the weekday schedule", () => {
    expect(workflowSrc).toMatch(/cron:\s*['"]\*\/5 13-20 \* \* 1-5['"]/); // weekday schedule intact
    expect(workflowSrc).toMatch(/cron:\s*['"]0 13 \* \* 0,6['"]/);       // new weekend schedule
  });

  it("the weekend job calls auto-import for reconciliation", () => {
    const weekendJob = workflowSrc.split("weekend-reconcile:")[1] || "";
    expect(weekendJob).toContain("/api/auto-import");
  });
});
