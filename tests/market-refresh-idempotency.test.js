// tests/market-refresh-idempotency.test.js
// Guards the fix for repeated Market Refresh failures caused by non-idempotent
// PostgREST upserts: `Prefer: resolution=merge-duplicates` alone targets the
// table's PRIMARY KEY for the ON CONFLICT clause, not an arbitrary unique
// constraint — without an explicit `on_conflict=<cols>` query param naming
// the real constraint, every re-run 409s instead of updating the row.
// Run: npx vitest run tests/market-refresh-idempotency.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const marketRefreshSrc = fs.readFileSync(path.resolve("api/market-refresh.js"), "utf8");
const autoImportSrc    = fs.readFileSync(path.resolve("api/auto-import.js"), "utf8");

// Mirrors the check used below — a POST to `table` is only idempotent under
// PostgREST's merge-duplicates resolution if the URL names the real unique
// constraint via on_conflict. Scans each `fetch(` call site's own block (up
// to the closing `});`) rather than matching bare table-name substrings, so
// unrelated GET reads against the same table aren't picked up.
function upsertUrlsFor(src, table) {
  const blocks = src.split(/(?=fetch\()/g).filter(b => b.includes(`rest/v1/${table}`));
  const writeBlocks = blocks.filter(b => /method:\s*["']POST["']/.test(b.slice(0, 400)));
  return writeBlocks.map(b => b.match(new RegExp(`rest/v1/${table}[^\`]*`))[0]);
}

describe("iv_history upsert is idempotent on (symbol, date)", () => {
  it("positive — the iv_history POST URL declares on_conflict=symbol,date", () => {
    const urls = upsertUrlsFor(marketRefreshSrc, "iv_history");
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toContain("on_conflict=symbol,date");
  });

  it("negative — a URL missing on_conflict would be caught by this check", () => {
    const brokenUrl = "rest/v1/iv_history`";
    expect(brokenUrl).not.toContain("on_conflict=symbol,date");
  });
});

describe("ecosystem_heartbeat upsert is idempotent on (agent_name)", () => {
  it("positive — every ecosystem_heartbeat POST in market-refresh.js declares on_conflict=agent_name", () => {
    const urls = upsertUrlsFor(marketRefreshSrc, "ecosystem_heartbeat");
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toContain("on_conflict=agent_name");
  });

  it("positive — every ecosystem_heartbeat POST in auto-import.js declares on_conflict=agent_name", () => {
    const urls = upsertUrlsFor(autoImportSrc, "ecosystem_heartbeat");
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toContain("on_conflict=agent_name");
  });

  it("negative — a URL missing on_conflict would be caught by this check", () => {
    const brokenUrl = "rest/v1/ecosystem_heartbeat`";
    expect(brokenUrl).not.toContain("on_conflict=agent_name");
  });
});

describe("Market Refresh GitHub Actions — single workflow, no duplicate race", () => {
  const workflowsDir = path.resolve(".github/workflows");
  const files = fs.readdirSync(workflowsDir).filter(f => f.endsWith(".yml") || f.endsWith(".yaml"));

  it("positive — exactly one workflow triggers /api/market-refresh on the */5 cron", () => {
    const matches = files.filter(f => {
      const content = fs.readFileSync(path.join(workflowsDir, f), "utf8");
      return /cron:\s*['"]\*\/5 13-20 \* \* 1-5['"]/.test(content) && content.includes("/api/market-refresh");
    });
    expect(matches).toEqual(["market-refresh.yml"]);
  });

  it("negative — the old duplicate market-refresh-workflow.yml no longer exists", () => {
    expect(files).not.toContain("market-refresh-workflow.yml");
  });
});
