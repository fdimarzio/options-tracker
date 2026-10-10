// tests/etrade-oauth-callback.test.js
// Validates the OAuth callback redirect change and auth logging wiring.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const etradeSrc = readFileSync(resolve(__dirname, "../api/etrade.js"), "utf-8");
const watchdogSrc = readFileSync(resolve(__dirname, "../scripts/watchdog.js"), "utf-8");
const ddlSrc = readFileSync(resolve(__dirname, "../sql/etrade_auth_log.sql"), "utf-8");

describe("ETrade OAuth callback redirect", () => {
  it("uses a real callback URL instead of oob", () => {
    // The oauth_callback should point to the app's callback endpoint
    expect(etradeSrc).toContain('oauth_callback:         callbackUrl');
    expect(etradeSrc).toContain("const callbackUrl = `${APP_URL}/api/etrade?action=callback`");
    // Should NOT contain the old oob callback
    expect(etradeSrc).not.toContain('oauth_callback:         "oob"');
  });

  it("still has a manual fallback paste form", () => {
    // The auth page should have a fallback for manual verifier entry
    expect(etradeSrc).toContain("Manual fallback");
    expect(etradeSrc).toContain('name="oauth_verifier"');
    expect(etradeSrc).toContain("Paste verifier code here");
  });

  it("tells the user about automatic redirect", () => {
    expect(etradeSrc).toContain("redirected back here automatically");
  });

  it("callback handler reads oauth_verifier from query params (works for both redirect and manual)", () => {
    // The existing callback handler already reads from req.query, so it handles
    // both ETrade redirect (?action=callback&oauth_verifier=X) and the manual form
    expect(etradeSrc).toContain("oauth_verifier: oauthVerifier");
    expect(etradeSrc).toContain("req.query");
  });
});

describe("ETrade auth logging", () => {
  it("logs auth_start on successful request token", () => {
    expect(etradeSrc).toContain('action: "auth_start"');
    expect(etradeSrc).toContain('success: true');
  });

  it("logs callback success with token expiry", () => {
    // Should log on successful access token exchange
    const callbackSuccessPattern = /action:\s*"callback".*success:\s*true.*tokenExpiry/s;
    expect(etradeSrc).toMatch(callbackSuccessPattern);
  });

  it("logs callback failures", () => {
    // Two failure paths: exchange failure and no-access-token
    const failureMatches = etradeSrc.match(/action:\s*"callback",\s*success:\s*false/g);
    expect(failureMatches).not.toBeNull();
    expect(failureMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("logs renew success and failure", () => {
    const renewSuccess = etradeSrc.match(/action:\s*"renew",\s*success:\s*true/g);
    const renewFailure = etradeSrc.match(/action:\s*"renew",\s*success:\s*false/g);
    expect(renewSuccess).not.toBeNull();
    // Two failure paths: expired (previous day) and renew API failure
    expect(renewFailure).not.toBeNull();
    expect(renewFailure.length).toBeGreaterThanOrEqual(2);
  });

  it("logAuthAttempt function writes to etrade_auth_log table", () => {
    expect(etradeSrc).toContain("etrade_auth_log");
    expect(etradeSrc).toContain("async function logAuthAttempt");
    expect(etradeSrc).toContain("error_reason");
    expect(etradeSrc).toContain("token_expiry");
  });
});

describe("ETrade auth log DDL", () => {
  it("creates the etrade_auth_log table with required columns", () => {
    expect(ddlSrc).toContain("CREATE TABLE IF NOT EXISTS etrade_auth_log");
    expect(ddlSrc).toContain("action");
    expect(ddlSrc).toContain("success");
    expect(ddlSrc).toContain("error_reason");
    expect(ddlSrc).toContain("token_expiry");
    expect(ddlSrc).toContain("created_at");
  });

  it("has indexes for watchdog queries", () => {
    expect(ddlSrc).toContain("idx_etrade_auth_log_created");
    expect(ddlSrc).toContain("idx_etrade_auth_log_success");
  });

  it("enables RLS with service_role insert and anon read", () => {
    expect(ddlSrc).toContain("ENABLE ROW LEVEL SECURITY");
    expect(ddlSrc).toContain("service_key_insert");
    expect(ddlSrc).toContain("anon_select");
  });
});

describe("Watchdog ETrade auth health check", () => {
  it("has an etrade-auth-health check in the CHECKS array", () => {
    expect(watchdogSrc).toContain("etrade-auth-health");
    expect(watchdogSrc).toContain("etradeAuthHealthy");
  });

  it("etradeAuthHealthy queries the auth log for recent success", () => {
    expect(watchdogSrc).toContain("etrade_auth_log");
    expect(watchdogSrc).toContain("success=eq.true");
    expect(watchdogSrc).toContain("action=in.(callback,renew)");
  });

  it("gracefully handles missing auth_log table", () => {
    // Should not crash watchdog if DDL hasn't been applied yet
    expect(watchdogSrc).toContain('detail: "auth_log table not yet created"');
  });

  it("is marked as critical severity", () => {
    expect(watchdogSrc).toContain('"auth: etrade-auth-health"');
    // Find the line and verify sev
    const checkLine = watchdogSrc.split("\n").find(l => l.includes("etrade-auth-health"));
    expect(checkLine).toContain('"critical"');
  });
});
