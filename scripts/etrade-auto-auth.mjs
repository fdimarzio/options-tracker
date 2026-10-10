#!/usr/bin/env node
// scripts/etrade-auto-auth.mjs
// Automates the daily ETrade OAuth authorization flow using Playwright.
//
// Flow:
//   1. Hit the app's auth endpoint to get a request token (stored in Supabase)
//   2. Open ETrade authorize page in a headless browser
//   3. Log in with ETrade credentials if prompted
//   4. Accept the authorization
//   5. Read the verifier code from the page
//   6. Submit the verifier to the app's callback endpoint
//
// Required env vars:
//   ETRADE_WEB_USERNAME   — ETrade web login username
//   ETRADE_WEB_PASSWORD   — ETrade web login password
//   APP_URL               — e.g. https://options-tracker-five.vercel.app
//   CRON_SECRET           — (optional) cron auth secret
//
// Usage:
//   node scripts/etrade-auto-auth.mjs
//   node scripts/etrade-auto-auth.mjs --headed    # visible browser for debugging

import { chromium } from "@playwright/test";

const APP_URL         = process.env.APP_URL || "https://options-tracker-five.vercel.app";
const ETRADE_USERNAME = process.env.ETRADE_WEB_USERNAME;
const ETRADE_PASSWORD = process.env.ETRADE_WEB_PASSWORD;
const CRON_SECRET     = process.env.CRON_SECRET || "";
const HEADED          = process.argv.includes("--headed");
const SCREENSHOT_DIR  = process.env.SCREENSHOT_DIR || "/tmp";

if (!ETRADE_USERNAME || !ETRADE_PASSWORD) {
  console.error("[auto-auth] Missing ETRADE_WEB_USERNAME or ETRADE_WEB_PASSWORD");
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function screenshot(page, name) {
  try {
    await page.screenshot({ path: `${SCREENSHOT_DIR}/etrade-auto-auth-${name}.png`, fullPage: true });
  } catch { /* best-effort */ }
}

async function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[auto-auth ${ts}] ${msg}`);
}

// ── Step 1: Get request token + authorize URL ────────────────────────────────

async function getAuthorizeUrl() {
  log("Step 1: Requesting auth token...");
  const url = `${APP_URL}/api/etrade?action=auth`;
  const r = await fetch(url);
  const html = await r.text();

  if (!r.ok) {
    throw new Error(`Auth endpoint returned ${r.status}: ${html.slice(0, 200)}`);
  }

  // Parse the authorize URL from the HTML response
  const match = html.match(/href="(https:\/\/us\.etrade\.com\/e\/t\/etws\/authorize\?[^"]+)"/);
  if (!match) {
    throw new Error(`Could not find authorize URL in response: ${html.slice(0, 300)}`);
  }

  log(`  Authorize URL: ${match[1].slice(0, 80)}...`);
  return match[1];
}

// ── Step 2–5: Browser automation ─────────────────────────────────────────────

async function automateETradeAuth(authorizeUrl) {
  log("Step 2: Launching browser...");

  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-http2",
    ],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const page = await context.newPage();

  try {
    // Navigate to ETrade authorize page
    log("Step 3: Navigating to ETrade authorize page...");
    await page.goto(authorizeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await screenshot(page, "01-authorize-page");

    // Check if we need to log in
    const needsLogin = await page.locator('input[name="USER"], input#USER, input[type="text"][name*="user" i]').first().isVisible({ timeout: 3000 }).catch(() => false);

    if (needsLogin) {
      log("Step 3a: Login required — entering credentials...");

      // Find and fill username
      const userInput = page.locator('input[name="USER"], input#USER, input[type="text"][name*="user" i]').first();
      await userInput.fill(ETRADE_USERNAME);

      // Find and fill password
      const passInput = page.locator('input[name="PASSWORD"], input#PASSWORD, input[type="password"]').first();
      await passInput.fill(ETRADE_PASSWORD);

      await screenshot(page, "02-credentials-filled");

      // Click login/submit button
      const loginBtn = page.locator('button[type="submit"], input[type="submit"], #logon_button, button:has-text("Log On"), button:has-text("Sign In"), a:has-text("Log On")').first();
      await loginBtn.click();

      // Wait for navigation after login
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
      await screenshot(page, "03-after-login");

      // Check for security question / 2FA
      const hasSecurityQuestion = await page.locator('text=/security/i, text=/challenge/i, text=/verify/i').first().isVisible({ timeout: 3000 }).catch(() => false);
      if (hasSecurityQuestion) {
        await screenshot(page, "03a-security-challenge");
        throw new Error("Security question or 2FA challenge detected — manual intervention required");
      }
    } else {
      log("  Already logged in or no login form detected");
    }

    // Look for the Accept/Authorize button
    log("Step 4: Looking for Accept button...");
    // ETrade's authorize page has an "Accept" or "Authorize" button
    const acceptBtn = page.locator(
      'input[value="Accept"], input[value="Authorize"], ' +
      'button:has-text("Accept"), button:has-text("Authorize"), ' +
      'input[type="submit"][value*="Accept" i], input[type="submit"][value*="Authorize" i], ' +
      'a:has-text("Accept"), a:has-text("Authorize")'
    ).first();

    const acceptVisible = await acceptBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (!acceptVisible) {
      await screenshot(page, "04-no-accept-button");
      const bodyText = await page.locator("body").innerText().catch(() => "");
      throw new Error(`Accept button not found. Page text: ${bodyText.slice(0, 300)}`);
    }

    await acceptBtn.click();
    log("  Clicked Accept");

    // Wait for the verifier code page
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
    await screenshot(page, "05-verifier-page");

    // Read the verifier code — ETrade shows it on the page after accepting
    log("Step 5: Reading verifier code...");
    const bodyText = await page.locator("body").innerText();

    // The verifier is typically a short alphanumeric code displayed prominently
    // Try multiple patterns to find it
    let verifier = null;

    // Pattern 1: Look for an input field with the verifier
    const codeInput = page.locator('input[type="text"][readonly], input#verifier, input[name*="verifier" i]').first();
    if (await codeInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      verifier = await codeInput.inputValue();
    }

    // Pattern 2: Look for a code-like string on the page (typically 5-8 alphanumeric chars)
    if (!verifier) {
      // ETrade typically shows the code in a prominent element
      const codeEl = page.locator('code, .verifier, #verifier, [class*="code"], strong, b, span.token').first();
      if (await codeEl.isVisible({ timeout: 2000 }).catch(() => false)) {
        verifier = (await codeEl.innerText()).trim();
      }
    }

    // Pattern 3: Regex scan the page text
    if (!verifier) {
      // ETrade verifier codes are typically alphanumeric, ~5-8 chars
      const codeMatch = bodyText.match(/(?:code|verifier|token)[:\s]*([A-Z0-9]{4,10})/i)
        || bodyText.match(/\b([A-Z0-9]{5,8})\b/);
      if (codeMatch) {
        verifier = codeMatch[1];
      }
    }

    if (!verifier) {
      await screenshot(page, "05-no-verifier");
      throw new Error(`Could not find verifier code on page. Text: ${bodyText.slice(0, 500)}`);
    }

    log(`  Verifier code: ${verifier}`);
    return verifier;

  } finally {
    await browser.close();
  }
}

// ── Step 6: Submit verifier to callback ──────────────────────────────────────

async function submitVerifier(verifier) {
  log("Step 6: Submitting verifier to callback...");
  const url = `${APP_URL}/api/etrade?action=callback&oauth_verifier=${encodeURIComponent(verifier)}`;
  const r = await fetch(url);
  const text = await r.text();

  if (!r.ok) {
    throw new Error(`Callback failed (${r.status}): ${text.slice(0, 300)}`);
  }

  // Check for success indicators in the response
  if (text.includes("Access token saved") || text.includes("success") || r.ok) {
    log("  Token exchange successful!");
    return true;
  }

  throw new Error(`Unexpected callback response: ${text.slice(0, 300)}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log("=== ETrade Auto-Auth Starting ===");
  const startTime = Date.now();

  try {
    const authorizeUrl = await getAuthorizeUrl();
    const verifier = await automateETradeAuth(authorizeUrl);
    await submitVerifier(verifier);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`=== ETrade Auto-Auth Complete (${elapsed}s) ===`);
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`=== ETrade Auto-Auth FAILED (${elapsed}s): ${err.message} ===`);

    // Write heartbeat as failed
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/ecosystem_heartbeat?on_conflict=agent_name`, {
          method: "POST",
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates,return=minimal",
          },
          body: JSON.stringify({
            agent_name: "etrade-auto-auth",
            last_run_at: new Date().toISOString(),
            status: "error",
            notes: String(err.message).slice(0, 200),
            updated_at: new Date().toISOString(),
          }),
        });
      } catch { /* best-effort */ }
    }

    process.exit(1);
  }

  // Write heartbeat as ok
  if (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL) {
    const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    if (SUPABASE_KEY) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/ecosystem_heartbeat?on_conflict=agent_name`, {
          method: "POST",
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates,return=minimal",
          },
          body: JSON.stringify({
            agent_name: "etrade-auto-auth",
            last_run_at: new Date().toISOString(),
            status: "ok",
            notes: "auto-auth completed successfully",
            updated_at: new Date().toISOString(),
          }),
        });
      } catch { /* best-effort */ }
    }
  }
}

main();
