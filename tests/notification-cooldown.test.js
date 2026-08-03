// tests/notification-cooldown.test.js
// Unified per-(contract-or-symbol, alert-type) notification cooldown for
// CLOSE_NOW / itm_warning / sto_suggestion — these were firing on every 5-min
// refresh for the same ticker/contract. Run: npx vitest run tests/notification-cooldown.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  resolveCooldownMinutes, isWithinCooldown, buildNotificationDedupKey, makeNotificationLogLookupKey,
} from "../api/_lib/notificationCooldown.js";

const marketRefreshSrc = fs.readFileSync(path.resolve("api/market-refresh.js"), "utf8");
const sqlSrc           = fs.readFileSync(path.resolve("sql/notification_cooldown.sql"), "utf8");

describe("resolveCooldownMinutes", () => {
  it("positive — reads cooldown_minutes from the signal_rules row", () => {
    expect(resolveCooldownMinutes({ cooldown_minutes: 45 })).toBe(45);
  });
  it("negative — defaults to 60 when the row exists but cooldown_minutes is null", () => {
    expect(resolveCooldownMinutes({ cooldown_minutes: null })).toBe(60);
  });
  it("edge — defaults to 60 when the row doesn't exist yet", () => {
    expect(resolveCooldownMinutes(null)).toBe(60);
  });
  it("edge — a custom default can be passed through", () => {
    expect(resolveCooldownMinutes(null, 30)).toBe(30);
  });
});

describe("isWithinCooldown", () => {
  it("positive — 30 minutes since last send, 60-min cooldown -> still suppressed", () => {
    const now = new Date("2026-08-02T14:30:00Z");
    const lastSentAt = new Date("2026-08-02T14:00:00Z").toISOString();
    expect(isWithinCooldown(lastSentAt, 60, now)).toBe(true);
  });
  it("edge — exactly 60 minutes since last send -> no longer within cooldown", () => {
    const now = new Date("2026-08-02T15:00:00Z");
    const lastSentAt = new Date("2026-08-02T14:00:00Z").toISOString();
    expect(isWithinCooldown(lastSentAt, 60, now)).toBe(false);
  });
  it("edge — 61 minutes since last send -> window elapsed, fires again", () => {
    const now = new Date("2026-08-02T15:01:00Z");
    const lastSentAt = new Date("2026-08-02T14:00:00Z").toISOString();
    expect(isWithinCooldown(lastSentAt, 60, now)).toBe(false);
  });
  it("negative — never sent before (no lastSentAt) is never suppressed", () => {
    expect(isWithinCooldown(null, 60)).toBe(false);
    expect(isWithinCooldown(undefined, 60)).toBe(false);
  });
  it("edge — an invalid lastSentAt value is treated as never sent, not suppressed", () => {
    expect(isWithinCooldown("not-a-date", 60)).toBe(false);
  });
  it("accepts a Date instance as well as an ISO string", () => {
    const now = new Date("2026-08-02T14:30:00Z");
    const lastSentAt = new Date("2026-08-02T14:00:00Z");
    expect(isWithinCooldown(lastSentAt, 60, now)).toBe(true);
  });
});

describe("buildNotificationDedupKey", () => {
  it("contract-scoped alerts key on the contract id", () => {
    expect(buildNotificationDedupKey({ contractId: 42 })).toBe("42");
  });
  it("symbol-scoped alerts (sto_suggestion) key on symbol+account", () => {
    expect(buildNotificationDedupKey({ symbol: "amzn", account: "Schwab 3866" })).toBe("AMZN|Schwab 3866");
  });
  it("same symbol in two different accounts produces different keys", () => {
    const a = buildNotificationDedupKey({ symbol: "AMZN", account: "Schwab 3866" });
    const b = buildNotificationDedupKey({ symbol: "AMZN", account: "ETrade 6917" });
    expect(a).not.toBe(b);
  });
});

describe("makeNotificationLogLookupKey", () => {
  it("combines dedup key and alert type", () => {
    expect(makeNotificationLogLookupKey("42", "close_now")).toBe("42|close_now");
  });
  it("the same contract with a different alert type produces a different lookup key", () => {
    const a = makeNotificationLogLookupKey("42", "close_now");
    const b = makeNotificationLogLookupKey("42", "itm_warning");
    expect(a).not.toBe(b);
  });
});

// ── End-to-end simulation of the actual decision sequence in market-refresh.js ──
describe("end-to-end: unified cooldown decision", () => {
  function shouldFire(log, dedupKey, alertType, cooldownMinutes, now) {
    return !isWithinCooldown(log[makeNotificationLogLookupKey(dedupKey, alertType)], cooldownMinutes, now);
  }

  it("positive — same CLOSE_NOW for a contract twice within the hour -> one push", () => {
    const log = {};
    const key = buildNotificationDedupKey({ contractId: 100 });
    const t0 = new Date("2026-08-02T14:00:00Z");
    const t1 = new Date("2026-08-02T14:30:00Z"); // 30 min later, same 5-min-refresh cadence over time

    expect(shouldFire(log, key, "close_now", 60, t0)).toBe(true); // first fire
    log[makeNotificationLogLookupKey(key, "close_now")] = t0.toISOString();

    expect(shouldFire(log, key, "close_now", 60, t1)).toBe(false); // suppressed — only one push
  });

  it("negative — a different contract with the same alert type still fires", () => {
    const log = {};
    const keyA = buildNotificationDedupKey({ contractId: 100 });
    const keyB = buildNotificationDedupKey({ contractId: 200 });
    const t0 = new Date("2026-08-02T14:00:00Z");
    log[makeNotificationLogLookupKey(keyA, "close_now")] = t0.toISOString();

    expect(shouldFire(log, keyA, "close_now", 60, new Date("2026-08-02T14:15:00Z"))).toBe(false); // A still cooling down
    expect(shouldFire(log, keyB, "close_now", 60, new Date("2026-08-02T14:15:00Z"))).toBe(true);  // B is independent
  });

  it("negative — a different alert type on the same contract still fires", () => {
    const log = {};
    const key = buildNotificationDedupKey({ contractId: 100 });
    const t0 = new Date("2026-08-02T14:00:00Z");
    log[makeNotificationLogLookupKey(key, "close_now")] = t0.toISOString();

    expect(shouldFire(log, key, "close_now", 60, new Date("2026-08-02T14:15:00Z"))).toBe(false);   // close_now cooling down
    expect(shouldFire(log, key, "itm_warning", 60, new Date("2026-08-02T14:15:00Z"))).toBe(true);  // itm_warning independent
  });

  it("edge — window elapsed (61 min later) -> fires again", () => {
    const log = {};
    const key = buildNotificationDedupKey({ contractId: 100 });
    const t0 = new Date("2026-08-02T14:00:00Z");
    log[makeNotificationLogLookupKey(key, "close_now")] = t0.toISOString();

    expect(shouldFire(log, key, "close_now", 60, new Date("2026-08-02T15:01:00Z"))).toBe(true);
  });

  it("sto_suggestion for the same symbol+account twice within the hour -> one push", () => {
    const log = {};
    const key = buildNotificationDedupKey({ symbol: "AMZN", account: "Schwab 3866" });
    const t0 = new Date("2026-08-02T14:00:00Z");

    expect(shouldFire(log, key, "sto_suggestion", 60, t0)).toBe(true);
    log[makeNotificationLogLookupKey(key, "sto_suggestion")] = t0.toISOString();
    expect(shouldFire(log, key, "sto_suggestion", 60, new Date("2026-08-02T14:20:00Z"))).toBe(false);
  });

  it("sto_suggestion for a different symbol still fires independently", () => {
    const log = {};
    const keyA = buildNotificationDedupKey({ symbol: "AMZN", account: "Schwab 3866" });
    const keyB = buildNotificationDedupKey({ symbol: "NVDA", account: "Schwab 3866" });
    log[makeNotificationLogLookupKey(keyA, "sto_suggestion")] = new Date("2026-08-02T14:00:00Z").toISOString();

    expect(shouldFire(log, keyA, "sto_suggestion", 60, new Date("2026-08-02T14:10:00Z"))).toBe(false);
    expect(shouldFire(log, keyB, "sto_suggestion", 60, new Date("2026-08-02T14:10:00Z"))).toBe(true);
  });
});

describe("api/market-refresh.js — wiring", () => {
  it("CLOSE_NOW and itm_warning are checked against the cooldown independently, not the old CLOSE_NOW_COOLDOWN/shouldNotify path", () => {
    expect(marketRefreshSrc).toContain('const cooldownAlertType = signal.level === "CLOSE_NOW" ? "close_now" : signal.level === "ITM_WARNING" ? "itm_warning" : null;');
    expect(marketRefreshSrc).not.toContain("CLOSE_NOW_COOLDOWN");
  });

  it("sto_suggestion no longer uses the old day-based col_prefs dedup", () => {
    expect(marketRefreshSrc).not.toContain("Dedupe: one push per symbol+account per day");
    expect(marketRefreshSrc).not.toContain("suggKey");
  });

  it("notification_log writes use on_conflict=dedup_key,alert_type (idempotent upsert, per the Prompt 2 lesson)", () => {
    expect(marketRefreshSrc).toContain("notification_log?on_conflict=dedup_key,alert_type");
    expect(marketRefreshSrc).toContain("resolution=merge-duplicates");
  });

  it("does NOT write CLOSE_NOW/itm_warning suppression state onto contracts.last_exit_alert_at (would cross-contaminate the exit-plan mechanism)", () => {
    const cooldownSection = marketRefreshSrc.split("// ── Notification cooldown")[1]?.split("// ── Exit plan checks")[0] || "";
    // The section's own explanatory comment names the column (to say why it's NOT
    // reused) — check for actual code usage (a property read/write), not bare prose.
    expect(cooldownSection).not.toContain("contract.last_exit_alert_at");
    expect(cooldownSection).not.toContain("last_exit_alert_at:");
  });

  it("the exit-plan (stop_loss/time_stop/delta_stop) mechanism is untouched — still its own once-per-day check on last_exit_alert_at", () => {
    expect(marketRefreshSrc).toContain("const lastAlertDate = contract.last_exit_alert_at?.slice(0, 10);");
    expect(marketRefreshSrc).toContain("if (lastAlertDate === todayStr) continue;");
  });
});

describe("sql/notification_cooldown.sql", () => {
  it("creates notification_log with a unique constraint on (dedup_key, alert_type)", () => {
    expect(sqlSrc).toContain("UNIQUE (dedup_key, alert_type)");
  });
  it("adds cooldown_minutes to signal_rules and seeds the notification_cooldown row at 60", () => {
    expect(sqlSrc).toContain("ADD COLUMN IF NOT EXISTS cooldown_minutes");
    expect(sqlSrc).toMatch(/'notification_cooldown',[^\n]*60/);
  });
});
