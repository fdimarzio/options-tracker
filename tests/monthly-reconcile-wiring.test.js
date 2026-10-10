// tests/monthly-reconcile-wiring.test.js
// Wiring + safety guards for the monthly reconciliation runner
// (scripts/monthly-reconcile.js) and its workflow. The runner's I/O (Supabase,
// pdf-parse, Pushover) isn't exercised here — the engine logic is covered in
// tests/reconcile-engine.test.js. These tests pin the pure helpers and assert,
// against the source text, the safety and coverage properties that matter:
// identify-only (no transaction mutation), both brokers, all types, quiet-when-
// clean, history + heartbeat. (Same source-assertion approach as
// tests/reconcile-window.test.js.)
// Run: npx vitest run tests/monthly-reconcile-wiring.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { previousMonth, monthBounds, discoverStatementDirs, contractToCanonical } from "../scripts/monthly-reconcile.js";

const src = fs.readFileSync(path.resolve("scripts/monthly-reconcile.js"), "utf8");
const workflow = fs.readFileSync(path.resolve(".github/workflows/monthly-reconcile.yml"), "utf8");

describe("pure helpers", () => {
  it("previousMonth returns the prior calendar month as YYYY-MM", () => {
    expect(previousMonth(new Date("2026-10-06T12:00:00Z"))).toBe("2026-09");
    expect(previousMonth(new Date("2026-01-15T12:00:00Z"))).toBe("2025-12"); // year rollover
  });

  it("monthBounds returns [first-of-month, first-of-next-month)", () => {
    expect(monthBounds("2026-09")).toEqual({ start: "2026-09-01", end: "2026-10-01" });
    expect(monthBounds("2026-12")).toEqual({ start: "2026-12-01", end: "2027-01-01" }); // year rollover
  });

  it("discoverStatementDirs finds Schwab AND every ETrade account folder", () => {
    const fakeFs = {
      existsSync: () => true,
      readdirSync: () => [
        { name: "schwab", isDirectory: () => true },
        { name: "etrade-8222", isDirectory: () => true },
        { name: "etrade-6917", isDirectory: () => true },
        { name: "reconciliation-report.txt", isDirectory: () => false },
      ],
    };
    const dirs = discoverStatementDirs("/statements", fakeFs);
    expect(dirs.map((d) => d.account)).toEqual(["etrade-6917", "etrade-8222", "schwab"]);
    expect(dirs.find((d) => d.account === "etrade-8222").broker).toBe("ETrade");
    expect(dirs.find((d) => d.account === "schwab").broker).toBe("Schwab");
  });

  it("contractToCanonical maps an option contract row to a canonical txn", () => {
    const c = contractToCanonical({ stock: "JPM", opt_type: "STO", date_exec: "2026-05-01", premium: "360.66", account: "Schwab 1" });
    expect(c).toMatchObject({ broker: "Schwab", symbol: "JPM", type: "OPTION_STO", date: "2026-05-01" });
  });
});

describe("safety — identify-only, never mutates transaction history", () => {
  it("performs NO update/delete/patch on transactions or contracts", () => {
    // Strip comments so the safety prose ("no UPDATE/DELETE") can't satisfy or
    // trip these assertions — only actual code is checked.
    const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    // No mutating HTTP verbs anywhere (only POST, for its own bookkeeping rows).
    expect(code).not.toMatch(/method:\s*["'](PATCH|DELETE|PUT)["']/);
    // No SQL mutation of the transaction stores.
    expect(code).not.toMatch(/\bUPDATE\s+(contracts|stock_transactions)\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("only inserts/upserts into its own bookkeeping tables", () => {
    expect(src).toContain('sbInsert("reconciliation_runs"');
    expect(src).toContain('sbUpsert("col_prefs"');
    expect(src).toContain('"ecosystem_heartbeat"');
    // never writes the transaction stores
    expect(src).not.toMatch(/sb(Insert|Upsert)\(\s*["'](contracts|stock_transactions)["']/);
  });

  it("never touches broker credentials/tokens or places trades", () => {
    expect(src).not.toMatch(/schwab-auth|etrade\?action=|place.?order|auto.?trade|refresh.?token/i);
  });
});

describe("coverage — both brokers, all transaction types", () => {
  it("reconciles against app records from BOTH stock_transactions and contracts", () => {
    expect(src).toContain("stock_transactions?select=");
    expect(src).toContain("contracts?select=");
    expect(src).toContain("contractToCanonical");
  });

  it("iterates discovered broker dirs (Schwab + ETrade accounts), not a single hardcoded one", () => {
    expect(src).toContain("discoverStatementDirs()");
    expect(src).toMatch(/for \(const \{ account, broker, dir \} of dirs\)/);
  });

  it("surfaces a coverage gap instead of a false clean when a statement can't be parsed", () => {
    expect(src).toContain("coverageGaps");
    expect(src).toMatch(/0 recognized transactions/);
  });
});

describe("alerting — quiet when clean, speak up on change", () => {
  it("only alerts when something needs attention AND changed since last run", () => {
    expect(src).toContain("summarizeForAlert");
    expect(src).toContain("diffReconciliations");
    expect(src).toMatch(/const shouldAlert =/);
    expect(src).toContain("staying quiet");
  });

  it("writes a reconciliation_runs history row and a heartbeat every run", () => {
    expect(src).toContain('sbInsert("reconciliation_runs"');
    expect(src).toContain("heartbeat(");
    expect(src).toContain('agent_name: AGENT');
  });
});

describe(".github/workflows/monthly-reconcile.yml", () => {
  it("is scheduled monthly and runs the node script (no deploy step)", () => {
    expect(workflow).toMatch(/cron:\s*['"]20 13 2 \* \*['"]/);
    expect(workflow).toContain("node scripts/monthly-reconcile.js");
    expect(workflow).not.toMatch(/vercel|deploy/i);
  });

  it("passes the Supabase + Pushover env the script reads", () => {
    expect(workflow).toContain("SUPABASE_SERVICE_KEY");
    expect(workflow).toContain("PUSHOVER_API_TOKEN");
    expect(workflow).toContain("PUSHOVER_USER_KEY");
  });
});
