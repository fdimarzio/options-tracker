// tests/leap-protection-ui.test.js
// Surfaces the protect_leaps_ltcg signal_rule in the UI (Skynet rules tab +
// contracts view badge) — display only, no trading-logic change. computeOrigDte/
// isLeapOrigDte are imported directly from src/lib/leapGuard.js (the client mirror
// of api/_lib/leapGuard.js, same >365-DTE threshold the btc_auto scanner enforces
// server-side); the thin "is this contract protected" wrapper is mirrored locally,
// matching this repo's convention for logic embedded in pri-tod-v3.jsx (see
// tests/utils.test.js's "Expiry Today scenario classification (UI)" block).
// Run: npx vitest run tests/leap-protection-ui.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { computeOrigDte, isLeapOrigDte } from "../src/lib/leapGuard.js";

const appSrc  = fs.readFileSync(path.resolve("src/pri-tod-v3.jsx"), "utf8");
const bibleSrc = fs.readFileSync(path.resolve("Trading Options Dashboard - TOD/TOD-App-Bible.md"), "utf8");

// Mirrors isLeapProtectedContract() in src/pri-tod-v3.jsx — built from the real
// imported computeOrigDte/isLeapOrigDte so the DTE math itself can't drift.
function isLeapProtectedContract(c) {
  if (!c || c.status !== "Open") return false;
  return isLeapOrigDte(computeOrigDte(c.entryDte, c.expires, c.dateExec));
}

describe("computeOrigDte (client)", () => {
  it("uses entryDte when present", () => {
    expect(computeOrigDte(400, "irrelevant", "irrelevant")).toBe(400);
  });
  it("falls back to expires - dateExec when entryDte is null", () => {
    expect(computeOrigDte(null, "2026-08-08", "2026-08-01")).toBe(7);
  });
  it("edge — returns null when expires/dateExec are missing and entryDte is null", () => {
    expect(computeOrigDte(null, null, null)).toBeNull();
  });
});

describe("isLeapOrigDte", () => {
  it("positive — 400 DTE is a LEAP", () => expect(isLeapOrigDte(400)).toBe(true));
  it("negative — 7 DTE (a normal weekly) is not a LEAP", () => expect(isLeapOrigDte(7)).toBe(false));
  it("boundary — exactly 365 is NOT a LEAP (threshold is strictly > 365, matches the backend guard)", () => {
    expect(isLeapOrigDte(365)).toBe(false);
  });
  it("boundary — 366 is a LEAP", () => expect(isLeapOrigDte(366)).toBe(true));
  it("edge — null origDte is never a LEAP", () => expect(isLeapOrigDte(null)).toBe(false));
});

describe("isLeapProtectedContract — contracts view badge", () => {
  it("positive — an open contract with orig DTE>365 (entryDte) shows the protected/LTCG indicator", () => {
    const c = { status: "Open", entryDte: 400, expires: "2027-01-01", dateExec: "2026-01-01" };
    expect(isLeapProtectedContract(c)).toBe(true);
  });

  it("positive — an open contract with orig DTE>365 via the expires-dateExec fallback (no entryDte yet)", () => {
    const c = { status: "Open", entryDte: null, expires: "2027-06-01", dateExec: "2026-01-01" };
    expect(isLeapProtectedContract(c)).toBe(true);
  });

  it("negative — a normal weekly (orig DTE=7) shows nothing", () => {
    const c = { status: "Open", entryDte: 7, expires: "2026-08-08", dateExec: "2026-08-01" };
    expect(isLeapProtectedContract(c)).toBe(false);
  });

  it("negative — a Closed contract is never flagged, even with orig DTE>365 (badge is for open positions)", () => {
    const c = { status: "Closed", entryDte: 400, expires: "2027-01-01", dateExec: "2026-01-01" };
    expect(isLeapProtectedContract(c)).toBe(false);
  });

  it("edge — missing contract data doesn't throw", () => {
    expect(isLeapProtectedContract(null)).toBe(false);
    expect(isLeapProtectedContract({ status: "Open" })).toBe(false);
  });
});

describe("src/pri-tod-v3.jsx — Skynet rules tab wiring", () => {
  it("protect_leaps_ltcg has a distinct label and color, not falling back to the raw rule_type string", () => {
    expect(appSrc).toContain('protect_leaps_ltcg: "LEAPS Protection"');
    expect(appSrc).toContain('protect_leaps_ltcg: "#c792ea"');
  });

  it("shows the plain-language description for the rule", () => {
    expect(appSrc).toContain("LEAPs (opened &gt;365 DTE) are never auto-closed by Skynet's BTC scanners");
  });

  it("the contracts table shows a 🔒 LTCG badge driven by isLeapProtectedContract", () => {
    expect(appSrc).toContain("isLeapProtectedContract(c)&&<span");
    expect(appSrc).toContain("🔒 LTCG");
  });

  it("entryDte is mapped from the DB row so the badge has real data to work with", () => {
    expect(appSrc).toContain("entryDte:            row.entry_dte != null ? +row.entry_dte : null,");
  });
});

describe("TOD-App-Bible.md — product doc entry", () => {
  it("documents the LEAPS LTCG protection rule", () => {
    expect(bibleSrc).toContain("LEAPS LTCG protection");
    expect(bibleSrc).toContain("protect_leaps_ltcg");
  });
});
