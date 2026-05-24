// tests/smoke.spec.js
// Playwright end-to-end smoke tests for PRI Options Tracker
// Run: npx playwright test
// Requires: PLAYWRIGHT_BASE_URL and PLAYWRIGHT_PIN env vars

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "https://options-tracker-five.vercel.app";
const PIN      = process.env.PLAYWRIGHT_PIN || "";

async function login(page) {
  await page.goto(BASE_URL);
  await page.waitForSelector("text=Enter PIN", { timeout: 10000 });
  for (const digit of PIN.split("")) {
    await page.click(`button:has-text("${digit}")`);
  }
  await page.waitForSelector("text=CONTRACTS", { timeout: 10000 });
}

// ── Auth ─────────────────────────────────────────────────────────────────────
test("login with correct PIN works", async ({ page }) => {
  await login(page);
  await expect(page.locator("text=CONTRACTS")).toBeVisible();
});

test("wrong PIN shows error", async ({ page }) => {
  await page.goto(BASE_URL);
  await page.waitForSelector("text=Enter PIN");
  // Click wrong digits
  for (const digit of "0000") {
    await page.click(`button:has-text("${digit}")`);
  }
  await expect(page.locator("text=Incorrect")).toBeVisible({ timeout: 5000 });
});

// ── Dashboard ────────────────────────────────────────────────────────────────
test("dashboard KPI cards render", async ({ page }) => {
  await login(page);
  // Check total profit is not $0.00
  const profitText = await page.locator("text=TOTAL PROFIT").locator("..").textContent();
  expect(profitText).not.toContain("$0.00");
  // Check open contracts count is visible
  await expect(page.locator("text=OPEN CONTRACTS")).toBeVisible();
});

// ── Contracts Tab ─────────────────────────────────────────────────────────────
test("contracts table loads with rows", async ({ page }) => {
  await login(page);
  await page.click("text=CONTRACTS");
  await page.waitForTimeout(2000);
  const rows = page.locator("tbody tr");
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
});

test("Schwab contract close button shows API form not manual", async ({ page }) => {
  await login(page);
  await page.click("text=CONTRACTS");
  await page.waitForTimeout(2000);
  // Find first Schwab open contract close button
  const schwabRow = page.locator("tr").filter({ hasText: "Schwab 3866" }).filter({ hasText: "Open" }).first();
  await schwabRow.locator("button:has-text('CLOSE')").click();
  // Should see "Place Order" not just "Record manually"
  await expect(page.locator("text=Place Order")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("text=CLOSE CONTRACT")).toBeVisible();
});

// ── Analytics Tab ─────────────────────────────────────────────────────────────
test("analytics tab renders Schwab and ETrade stats", async ({ page }) => {
  await login(page);
  await page.click("text=ANALYTICS");
  await page.waitForTimeout(2000);
  // Schwab stats should not be $0
  const schwabSection = page.locator("text=SCHWAB").locator("..");
  await expect(schwabSection).toBeVisible();
  const schwabText = await schwabSection.textContent();
  expect(schwabText).not.toMatch(/PREMIUM\s+\$0\.00/);
  // ETrade stats visible
  await expect(page.locator("text=ETRADE")).toBeVisible();
});

// ── Signal Log Tab ────────────────────────────────────────────────────────────
test("signal log tab loads without white screen", async ({ page }) => {
  await login(page);
  // Open burger menu
  await page.click("button[aria-label='menu'], button:has-text('☰'), button:has-text('≡')");
  await page.click("text=Signal Log");
  await page.waitForTimeout(2000);
  // Should NOT be a white screen — check for filter buttons
  await expect(page.locator("text=ALL")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("text=STO")).toBeVisible();
  // Should show rows count
  await expect(page.locator("text=rows")).toBeVisible();
});

test("signal log filters work", async ({ page }) => {
  await login(page);
  await page.click("button[aria-label='menu'], button:has-text('☰'), button:has-text('≡')");
  await page.click("text=Signal Log");
  await page.waitForTimeout(2000);
  // Click STO filter
  await page.click("button:has-text('STO')");
  await page.waitForTimeout(500);
  // Click ANOMALY filter
  await page.click("button:has-text('ANOMALY')");
  await page.waitForTimeout(500);
  // Back to ALL
  await page.click("button:has-text('ALL')");
  await expect(page.locator("text=rows")).toBeVisible();
});

// ── Signal Rules Modal ────────────────────────────────────────────────────────
test("signal rules modal opens without crash", async ({ page }) => {
  await login(page);
  await page.click("button[aria-label='menu'], button:has-text('☰'), button:has-text('≡')");
  await page.click("text=Signal Rules");
  await page.waitForTimeout(2000);
  await expect(page.locator("text=SIGNAL RULES")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("text=TOTAL FIRED")).toBeVisible();
});

// ── Plan Tab deep-link ────────────────────────────────────────────────────────
test("plan tab deep-link opens correct ticker", async ({ page }) => {
  // Simulate a Pushover deep-link for AAPL
  await page.goto(`${BASE_URL}/?action=plan&ticker=AAPL`);
  // Login if needed
  if (await page.locator("text=Enter PIN").isVisible()) {
    for (const digit of PIN.split("")) {
      await page.click(`button:has-text("${digit}")`);
    }
  }
  await page.waitForTimeout(3000);
  await expect(page.locator("text=PLAN — AAPL")).toBeVisible({ timeout: 8000 });
});

// ── Mobile ribbon ─────────────────────────────────────────────────────────────
test("mobile bottom ribbon is visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.locator("text=CONTRACTS")).toBeVisible();
  await expect(page.locator("text=PLAN")).toBeVisible();
  await expect(page.locator("text=ANALYTICS")).toBeVisible();
});
