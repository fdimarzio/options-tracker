// tests/smoke.spec.js
// Playwright end-to-end smoke tests for PRI Options Tracker
// Run: npx playwright test
// Requires: PLAYWRIGHT_BASE_URL and PLAYWRIGHT_PIN env vars

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "https://options-tracker-five.vercel.app";
const PIN      = process.env.PLAYWRIGHT_PIN || "";

async function login(page) {
  await page.goto(BASE_URL);
  // Step 1: user selection screen — click the first user button
  await page.waitForSelector("text=SELECT USER", { timeout: 15000 });
  await page.click("button:has-text('Enter PIN to continue')");
  // Step 2: PIN keypad — enter digits
  await page.waitForSelector("text=Enter 4-digit PIN", { timeout: 10000 });
  for (const digit of PIN.split("")) {
    await page.click(`button:has-text("${digit}")`);
  }
  // Wait for app to load — the bottom nav ribbon always shows after login
  await page.waitForSelector("button:has-text('📋')", { timeout: 15000 });
}

// ── Auth ─────────────────────────────────────────────────────────────────────
test("login with correct PIN works", async ({ page }) => {
  await login(page);
  // App loaded — bottom nav visible
  await expect(page.locator("button:has-text('📋')").first()).toBeVisible();
});

test("wrong PIN shows error", async ({ page }) => {
  await page.goto(BASE_URL);
  await page.waitForSelector("text=SELECT USER", { timeout: 15000 });
  await page.click("button:has-text('Enter PIN to continue')");
  await page.waitForSelector("text=Enter 4-digit PIN", { timeout: 10000 });
  for (const digit of "0000") {
    await page.click(`button:has-text("${digit}")`);
  }
  await expect(page.locator("text=Wrong PIN").or(page.locator("text=Incorrect"))).toBeVisible({ timeout: 5000 });
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
