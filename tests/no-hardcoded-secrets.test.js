// tests/no-hardcoded-secrets.test.js
// Guards against the shared CRON_SECRET (once hard-coded in the browser bundle and in
// docs, in a public repo) reappearing. See docs/SECRET_ROTATION.md.
// The literal is assembled from pieces so this file does not itself contain it.
// Run: npx vitest run tests/no-hardcoded-secrets.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const OLD_SECRET = ["CronSecret", "2026", "!"].join("");
const ROOT = path.resolve(".");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".vercel", "playwright-report", "test-results"]);
const TEXT_EXT = new Set([".js", ".jsx", ".mjs", ".md", ".yml", ".yaml", ".json", ".sql", ".html", ".txt", ".env", ".example"]);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (TEXT_EXT.has(path.extname(ent.name))) out.push(full);
  }
  return out;
}

const files = walk(ROOT);

describe("hard-coded secret guard", () => {
  it("scans a meaningful number of files (guard against a broken walker passing vacuously)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("negative — the old CRON_SECRET literal appears nowhere in the repository", () => {
    const offenders = files.filter(f => fs.readFileSync(f, "utf8").includes(OLD_SECRET)).map(f => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("negative — browser code (src/) never builds a request with a secret= literal or x-cron-secret header", () => {
    const srcFiles = files.filter(f => path.relative(ROOT, f).startsWith("src" + path.sep));
    expect(srcFiles.length).toBeGreaterThan(5);
    const offenders = [];
    for (const f of srcFiles) {
      const text = fs.readFileSync(f, "utf8");
      if (/[?&]secret=[^$`'"\s&{]/.test(text) || /x-cron-secret/i.test(text) || /CRON_SECRET/.test(text)) {
        offenders.push(path.relative(ROOT, f));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("positive — server auth reads the secret from the environment, never a literal", () => {
    const auth = fs.readFileSync(path.resolve("api/_lib/auth.js"), "utf8");
    expect(auth).toContain("env.CRON_SECRET");
    expect(auth).not.toMatch(/CRON_SECRET\s*=\s*["'`]/);
  });
});
