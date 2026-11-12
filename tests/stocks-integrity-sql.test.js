// tests/stocks-integrity-sql.test.js
// STRUCTURAL guards over the delivered SQL in sql/stocks_integrity/. These SQL files are
// written for Frank to apply manually; they were NOT executed by the author (no Postgres
// engine available, live DB deliberately untouched), so these tests only pin the safety
// properties that can be checked as text. They are not a substitute for running the
// migration and its verification queries.
// Run: npx vitest run tests/stocks-integrity-sql.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const read = (f) => fs.readFileSync(path.resolve("sql/stocks_integrity", f), "utf8");
const stripComments = (s) => s.replace(/--[^\n]*/g, "");

describe("001_audit_col_prefs.sql", () => {
  const sql = read("001_audit_col_prefs.sql");
  const code = stripComments(sql);

  it("is clearly marked as not applied", () => {
    expect(sql).toMatch(/STATUS: NOT APPLIED/);
  });

  it("captures timestamp, JWT role, ticker, changed fields, and old/new values", () => {
    for (const col of ["changed_at", "jwt_role", "jwt_sub", "ticker", "changed_fields", "old_values", "new_values"]) {
      expect(code).toContain(col);
    }
  });

  it("watches autoSto, earningsDate, iv and the share fields", () => {
    expect(code).toMatch(/watched\s+constant text\[\] := array\['autoSto','earningsDate','iv','shares','sharesByAcct','sharesSchwab','sharesEtrade'\]/);
  });

  it("negative — broker token rows and high-churn caches are NOT in the audit allow-list", () => {
    const allow = code.match(/config_ids\s+constant text\[\] := array\[([^\]]*)\]/)[1];
    for (const forbidden of ["schwab_tokens", "etrade_tokens", "last_chain_refresh", "last_market_refresh", "notifications_sent"]) {
      expect(allow).not.toContain(forbidden);
    }
    // and the function early-returns for anything not allow-listed
    expect(code).toMatch(/not \(v_id = any \(config_ids\)\) then\s+return null;/);
  });

  it("reads the caller's JWT from both the modern and legacy PostgREST settings", () => {
    expect(code).toContain("request.jwt.claims");
    expect(code).toContain("request.jwt.claim.role");
  });

  it("the trigger function is SECURITY DEFINER with a pinned search_path and is not callable by clients", () => {
    expect(code).toMatch(/security definer\s+set search_path = public, pg_temp/);
    expect(code).toMatch(/revoke all on function public\.col_prefs_audit_fn\(\) from public, anon, authenticated/);
  });

  it("the audit table is RLS-protected: no client write grants, admin-only read", () => {
    expect(code).toContain("alter table public.col_prefs_audit enable row level security");
    expect(code).toMatch(/revoke all on public\.col_prefs_audit from public, anon, authenticated/);
    expect(code).toMatch(/grant select on public\.col_prefs_audit to authenticated/);
    expect(code).not.toMatch(/grant (insert|update|delete|all)[^;]*col_prefs_audit to (anon|authenticated)/);
    expect(code).toMatch(/using \(public\.app_role\(\) = 'admin'\)/);
  });

  it("detects whole-blob shrink (tickers removed) so a stale overwrite is visible", () => {
    expect(code).toContain("'__ticker_count__'");
    expect(code).toContain("'blob_shrank'");
  });

  it("never references NEW in a DELETE branch or OLD in an INSERT branch", () => {
    const head = code.slice(code.indexOf("if TG_OP = 'DELETE'"), code.indexOf("if v_id is distinct"));
    expect(head).toMatch(/if TG_OP = 'DELETE' then\s+v_id := OLD\.id;\s+old_c := OLD\.cols;\s+new_c := null;/);
    expect(head).toMatch(/elsif TG_OP = 'INSERT' then\s+v_id := NEW\.id;\s+old_c := null;\s+new_c := NEW\.cols;/);
  });

  it("FAIL-SAFE — an error inside the trigger is downgraded to a WARNING and can never abort the caller's col_prefs write", () => {
    // col_prefs also holds broker tokens and the market-refresh output; a trigger bug must not block them.
    const body = code.slice(code.indexOf("create or replace function public.col_prefs_audit_fn()"), code.indexOf("revoke all on function public.col_prefs_audit_fn()"));
    expect(body).toMatch(/exception when others then\s+raise warning 'col_prefs_audit_fn: audit skipped, caller write unaffected/);
    // the handler wraps the whole body: it opens before the first statement and the function still returns null after it
    expect(body.indexOf("exception when others then\n  raise warning")).toBeGreaterThan(body.indexOf("if TG_OP = 'DELETE' then"));
    expect(body).toMatch(/end;\s+return null;\s+end;\s+\$\$;/);
  });

  it("is idempotent to re-run (create if not exists / create or replace / drop trigger if exists)", () => {
    expect(code).toContain("create table if not exists public.col_prefs_audit");
    expect(code).toContain("create or replace function public.col_prefs_audit_fn()");
    expect(code).toContain("drop trigger if exists col_prefs_audit_trg");
  });

  it("is an AFTER row trigger on insert/update/delete of col_prefs", () => {
    expect(code).toMatch(/create trigger col_prefs_audit_trg\s+after insert or update or delete on public\.col_prefs\s+for each row/);
  });

  it("negative — contains no destructive statement against existing data", () => {
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bupdate\s+public\.col_prefs\b/i);
  });
});

describe("001_rollback_audit_col_prefs.sql", () => {
  const code = stripComments(read("001_rollback_audit_col_prefs.sql"));
  it("drops exactly the trigger, function and table it created", () => {
    expect(code).toContain("drop trigger  if exists col_prefs_audit_trg on public.col_prefs");
    expect(code).toContain("drop function if exists public.col_prefs_audit_fn()");
    expect(code).toContain("drop table    if exists public.col_prefs_audit");
    // and nothing else: in particular it must never drop col_prefs itself
    expect(code.match(/drop table[^;]*;/g)).toEqual(["drop table    if exists public.col_prefs_audit;"]);
  });
});

describe("queries_audit.sql", () => {
  const sql = read("queries_audit.sql");
  it("is read-only (select only) and includes the autoSto-history and token-sanity queries", () => {
    const code = stripComments(sql);
    expect(code).not.toMatch(/\b(insert|update|delete|drop|alter|truncate|create)\b/i);
    expect(sql).toContain("'autoSto' = any (changed_fields)");
    expect(sql).toContain("token_rows_audited");
  });
});
