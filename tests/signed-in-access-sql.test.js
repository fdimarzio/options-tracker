// tests/signed-in-access-sql.test.js
// Structural guards over sql/auth/001c (applied to production 2026-11-27 after a rolled-back dry run).
// These check the safety properties as text; the behavioral proof was the dry run against the real DB.
// Run: npx vitest run tests/signed-in-access-sql.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const code = (f) => fs.readFileSync(path.resolve("sql/auth", f), "utf8").replace(/--[^\n]*/g, "");

describe("001c_signed_in_access.sql", () => {
  const sql = code("001c_signed_in_access.sql");

  it("positive — creates read (allow-listed) and write (admin/trader) policies for the authenticated role", () => {
    expect(sql).toContain("create policy signed_in_read on public.%I for select to authenticated using ((select public.is_app_user()))");
    expect(sql).toContain("create policy signed_in_write on public.%I for all to authenticated using ((select public.app_role()) in (''admin'',''trader''))");
  });

  it("performance — every role check is wrapped in (select ...) so it runs once per query, not per row", () => {
    const calls = sql.match(/public\.(is_app_user|app_role)\(\)/g) || [];
    const wrapped = sql.match(/\(select public\.(is_app_user|app_role)\(\)\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    expect(wrapped.length).toBe(calls.length);
  });

  it("negative — additive only: drops, revokes and alters nothing, and grants nothing to anon", () => {
    expect(sql).not.toMatch(/\b(drop|revoke|alter|delete|truncate|grant)\b/i);
    expect(sql).not.toMatch(/to anon/i);
  });

  it("only targets RLS tables that had no policy for signed-in users", () => {
    expect(sql).toContain("c.relrowsecurity");
    expect(sql).toContain("p.roles::text like '%authenticated%' or p.roles::text like '%public%'");
  });
});

describe("001c_rollback_signed_in_access.sql", () => {
  const sql = code("001c_rollback_signed_in_access.sql");
  it("drops only the two policies 001c created, selected by name", () => {
    expect(sql).toContain("policyname in ('signed_in_read', 'signed_in_write')");
    expect(sql).not.toMatch(/drop table|disable row level security|app_read|app_write/i);
  });
});
