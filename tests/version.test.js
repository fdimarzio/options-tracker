// tests/version.test.js
// Semantic versioning wiring — package.json's version should be a valid semver,
// public/version.json should carry it (consistency at commit time; regenerated
// fresh at build time by scripts/stamp-version.js), and the build script should
// still write both the deploy-detection timestamp (`v`) and the semver
// (`version`) without changing the existing `v` field's meaning.
// Run: npx vitest run tests/version.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const pkg          = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
const versionJson   = JSON.parse(fs.readFileSync(path.resolve("public/version.json"), "utf8"));
const stampScriptSrc = fs.readFileSync(path.resolve("scripts/stamp-version.js"), "utf8");

describe("package.json version", () => {
  it("positive — is a valid semver string", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("negative — is not the placeholder 0.0.0", () => {
    expect(pkg.version).not.toBe("0.0.0");
  });
});

describe("public/version.json", () => {
  it("positive — carries the app semver, in sync with package.json at commit time", () => {
    expect(versionJson.version).toBe(pkg.version);
  });
  it("negative — the existing deploy-detection field `v` is untouched by this change (still present, still a string)", () => {
    expect(typeof versionJson.v).toBe("string");
    expect(versionJson.v.length).toBeGreaterThan(0);
  });
});

describe("scripts/stamp-version.js — build-time regeneration", () => {
  it("writes both v (unchanged deploy-detection timestamp) and version (from package.json)", () => {
    expect(stampScriptSrc).toContain("v: Date.now().toString()");
    expect(stampScriptSrc).toContain("version: pkg.version");
  });
  it("reads the version from package.json rather than hardcoding it", () => {
    expect(stampScriptSrc).toContain('readFileSync(resolve(__dirname, "../package.json"');
  });
});
