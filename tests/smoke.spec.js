// tests/smoke.spec.js
// Playwright end-to-end smoke tests for PRI Options Tracker (run against a deployed URL)
// Run: npx playwright test tests/smoke.spec.js
//
// Sign-in is passwordless (email link / code), so it cannot be scripted. Sign in ONCE by hand,
// then save the session and point the tests at it:
//   npx playwright codegen --save-storage=.auth/state.json https://options-tracker-five.vercel.app
//   PLAYWRIGHT_STORAGE_STATE=.auth/state.json npx playwright test tests/smoke.spec.js
// (.auth/ holds a live session token — it is git-ignored; never commit it.)
// Mock-backed auth tests that need no real account live in tests/e2e/auth.e2e.spec.js.

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "https://options-tracker-five.vercel.app";
const STATE    = process.env.PLAYWRIGHT_STORAGE_STATE || "";

if (STATE) test.use({ storageState: STATE });

async function login(page) {
  test.skip(!STATE, "set PLAYWRIGHT_STORAGE_STATE to a saved signed-in session (see header)");
  await page.goto(BASE_URL);
  // Wait for app to load — the bottom nav ribbon always shows after login
  await page.waitForSelector("button:has-text('📋')", { timeout: 15000 });
}

// ── Auth ─────────────────────────────────────────────────────────────────────
test("saved session loads the app", async ({ page }) => {
  await login(page);
  await expect(page.locator("button:has-text('📋')").first()).toBeVisible();
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test("shows sign-in and no dashboard", async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible({ timeout: 15000 });
    await expect(page.locator("button:has-text('📋')")).toHaveCount(0);
  });
});

// ── Dashboard ────────────────────────────────────────────────────────────────
test("dashboard loads with data", async ({ page }) => {
  await login(page);
  await page.waitForTimeout(2000);
  // App is loaded and has content — check page has meaningful text
  const body = await page.locator("body").textContent();
  expect(body.length).toBeGreaterThan(500);
});

// ── Contracts Tab ─────────────────────────────────────────────────────────────
test("contracts tab navigates successfully", async ({ page }) => {
  await login(page);
  // Click contracts nav button (📋)
  await page.click("button:has-text('📋')");
  await page.waitForTimeout(2000);
  // Page should have contract data
  const body = await page.locator("body").textContent();
  expect(body).toMatch(/STO|BTO|BTC|STC|Call|Put/);
});

// ── App doesn't crash ─────────────────────────────────────────────────────────
test("no JS errors on load", async ({ page }) => {
  const errors = [];
  page.on("pageerror", err => errors.push(err.message));
  await login(page);
  await page.waitForTimeout(3000);
  const criticalErrors = errors.filter(e =>
    !e.includes("ResizeObserver") &&
    !e.includes("Non-Error promise rejection")
  );
  expect(criticalErrors).toHaveLength(0);
});

// ── Mobile ribbon ─────────────────────────────────────────────────────────────
test("mobile bottom ribbon is visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  // Bottom nav should be visible on mobile
  await expect(page.locator("button:has-text('📋')").first()).toBeVisible();
});
