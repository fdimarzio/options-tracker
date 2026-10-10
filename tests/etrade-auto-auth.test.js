// tests/etrade-auto-auth.test.js
// Validates the auto-auth script structure and workflow wiring.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const scriptSrc = readFileSync(resolve(__dirname, "../scripts/etrade-auto-auth.mjs"), "utf-8");
const workflowPath = resolve(__dirname, "../.github/workflows/etrade-auto-auth.yml");
const workflowSrc = readFileSync(workflowPath, "utf-8");

describe("ETrade auto-auth script", () => {
  it("requires ETRADE_WEB_USERNAME and ETRADE_WEB_PASSWORD", () => {
    expect(scriptSrc).toContain("ETRADE_WEB_USERNAME");
    expect(scriptSrc).toContain("ETRADE_WEB_PASSWORD");
    expect(scriptSrc).toContain("Missing ETRADE_WEB_USERNAME or ETRADE_WEB_PASSWORD");
  });

  it("hits the app auth endpoint to get authorize URL", () => {
    expect(scriptSrc).toContain("action=auth");
    expect(scriptSrc).toContain("etrade\\.com");
  });

  it("uses Playwright chromium", () => {
    expect(scriptSrc).toContain('from "playwright"');
    expect(scriptSrc).toContain("chromium.launch");
  });

  it("handles ETrade login flow", () => {
    expect(scriptSrc).toContain("ETRADE_USERNAME");
    expect(scriptSrc).toContain("ETRADE_PASSWORD");
    expect(scriptSrc).toContain("fill(ETRADE_USERNAME)");
    expect(scriptSrc).toContain("fill(ETRADE_PASSWORD)");
  });

  it("clicks Accept button", () => {
    expect(scriptSrc).toContain("Accept");
    expect(scriptSrc).toContain("Authorize");
    expect(scriptSrc).toContain("acceptBtn");
  });

  it("reads the verifier code with multiple fallback patterns", () => {
    expect(scriptSrc).toContain("verifier");
    // Should have at least 3 patterns to find the code
    expect(scriptSrc).toContain("Pattern 1");
    expect(scriptSrc).toContain("Pattern 2");
    expect(scriptSrc).toContain("Pattern 3");
  });

  it("submits verifier to callback endpoint", () => {
    expect(scriptSrc).toContain("action=callback");
    expect(scriptSrc).toContain("oauth_verifier");
  });

  it("writes ecosystem heartbeat on success and failure", () => {
    expect(scriptSrc).toContain("ecosystem_heartbeat");
    expect(scriptSrc).toContain("etrade-auto-auth");
    expect(scriptSrc).toContain('"ok"');
    expect(scriptSrc).toContain('"error"');
  });

  it("takes screenshots for debugging", () => {
    expect(scriptSrc).toContain("screenshot");
    expect(scriptSrc).toContain("SCREENSHOT_DIR");
  });

  it("detects security questions / 2FA and fails gracefully", () => {
    expect(scriptSrc).toContain("security");
    expect(scriptSrc).toContain("manual intervention required");
  });

  it("supports --headed flag for debugging", () => {
    expect(scriptSrc).toContain("--headed");
    expect(scriptSrc).toContain("HEADED");
  });
});

describe("ETrade auto-auth workflow", () => {
  it("workflow file exists", () => {
    expect(existsSync(workflowPath)).toBe(true);
  });

  it("runs on weekday schedule", () => {
    expect(workflowSrc).toContain("schedule");
    expect(workflowSrc).toContain("1-5");
  });

  it("supports manual trigger", () => {
    expect(workflowSrc).toContain("workflow_dispatch");
  });

  it("installs Playwright", () => {
    expect(workflowSrc).toContain("playwright install chromium");
  });

  it("passes required secrets as env vars", () => {
    expect(workflowSrc).toContain("ETRADE_WEB_USERNAME");
    expect(workflowSrc).toContain("ETRADE_WEB_PASSWORD");
    expect(workflowSrc).toContain("SUPABASE_URL");
    expect(workflowSrc).toContain("SUPABASE_SERVICE_KEY");
  });

  it("uploads screenshots on failure", () => {
    expect(workflowSrc).toContain("upload-artifact");
    expect(workflowSrc).toContain("screenshots");
    expect(workflowSrc).toContain("if: failure()");
  });

  it("sends Pushover notification on failure", () => {
    expect(workflowSrc).toContain("PUSHOVER_API_TOKEN");
    expect(workflowSrc).toContain("Auto-Auth Failed");
  });
});
