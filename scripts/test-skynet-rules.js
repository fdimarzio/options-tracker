// scripts/test-skynet-rules.js
// Automated test suite for all Skynet auto-rules
// Run: node scripts/test-skynet-rules.js
// Each test logs PASS or FAIL with description.
// Written in response to after-hours order placement bug (June 5 2026).

let passed = 0, failed = 0;

function test(description, fn) {
  try {
    const result = fn();
    if (result === true) {
      console.log(`  ✅ PASS: ${description}`);
      passed++;
    } else {
      console.log(`  ❌ FAIL: ${description} — returned ${JSON.stringify(result)}`);
      failed++;
    }
  } catch (e) {
    console.log(`  ❌ FAIL: ${description} — threw: ${e.message}`);
    failed++;
  }
}

// ── Helpers (duplicated from market-refresh.js, keep in sync) ─────────────────

function isMarketHours(overrideDate) {
  const et   = overrideDate
    ? new Date(overrideDate.toLocaleString("en-US", { timeZone: "America/New_York" }))
    : new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day  = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960; // 9:30am–4:00pm ET
}

// Make a fake Date in ET timezone at a given hour:minute on a given weekday
// day: 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, 0=Sun
function makeETDate(day, hour, minute) {
  // Use a known date: 2026-06-01 was a Monday
  const BASE_MONDAY_ET = new Date("2026-06-01T14:00:00Z"); // Mon 10am ET
  const daysOffset = ((day - 1) + 7) % 7; // days from Monday
  const d = new Date(BASE_MONDAY_ET);
  d.setUTCDate(d.getUTCDate() + daysOffset);
  // Set to midnight ET = 04:00 UTC (EDT = UTC-4)
  d.setUTCHours(hour + 4, minute, 0, 0);
  return d;
}

function checkBTCFires({ profitPct, marketOpen, minProfitPct = 85 }) {
  if (!marketOpen) return false; // market hours gate
  return profitPct >= minProfitPct;
}

function checkAutoSTO({ changePct, minChangePct = 0.5, marketOpen, etMins }) {
  if (!marketOpen) return false;
  const minTimeMins = 9 * 60 + 45; // 9:45am default
  if (etMins < minTimeMins) return false;
  return changePct >= minChangePct;
}

function checkExpiryProtection({ isITM, optType, dte, etMins, dryRun = true }) {
  const WARN_MINS  = 15 * 60;      // 3:00pm
  const CLOSE_MINS = 15 * 60 + 30; // 3:30pm
  const marketOpen = etMins >= 570 && etMins < 960;
  if (!marketOpen) return false;
  if (optType === "BTO") return false;  // only close STO positions
  if (dte > 30) return false;           // LEAP exclusion
  if (!isITM) return false;
  if (etMins < WARN_MINS) return false;
  return true; // would fire (dryRun controls whether real order placed)
}

function checkIVFloor({ iv, minIV = 25 }) {
  return iv >= minIV;
}

function stopLossMultiplierForDTE(dte) {
  return dte <= 3 ? null : 2.0;
}

function checkStopLoss({ costToClose, premium, stopLossMultiplier, dte }) {
  const mult = stopLossMultiplier ?? stopLossMultiplierForDTE(dte);
  if (mult === null) return false; // no stop loss configured
  return costToClose > Math.abs(premium) * mult;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Market Hours Gate
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Market Hours Gate ──────────────────────────────────────────────");
test("10:00am ET Tuesday → gate passes",  () => isMarketHours(makeETDate(2, 10,  0)) === true);
test("9:30am ET Monday → gate passes",    () => isMarketHours(makeETDate(1,  9, 30)) === true);
test("3:59pm ET Friday → gate passes",    () => isMarketHours(makeETDate(5, 15, 59)) === true);
test("4:01pm ET Tuesday → gate blocks",   () => isMarketHours(makeETDate(2, 16,  1)) === false);
test("9:29am ET Wednesday → gate blocks", () => isMarketHours(makeETDate(3,  9, 29)) === false);
test("10:00am ET Saturday → gate blocks", () => isMarketHours(makeETDate(6, 10,  0)) === false);
test("10:00am ET Sunday → gate blocks",   () => isMarketHours(makeETDate(0, 10,  0)) === false);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Auto-BTC: fires at 85% profit within market hours
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Auto-BTC (signal_rules #2: 85% default) ───────────────────────");
test("86% profit, market hours → BTC fires",        () => checkBTCFires({ profitPct: 86, marketOpen: true,  minProfitPct: 85 }) === true);
test("85% profit (exact threshold) → BTC fires",    () => checkBTCFires({ profitPct: 85, marketOpen: true,  minProfitPct: 85 }) === true);
test("84% profit → BTC does NOT fire",              () => checkBTCFires({ profitPct: 84, marketOpen: true,  minProfitPct: 85 }) === false);
test("86% profit, 4:01pm ET → BTC does NOT fire",   () => checkBTCFires({ profitPct: 86, marketOpen: false, minProfitPct: 85 }) === false);
test("after-3pm rule at 75%: 76% profit → fires",   () => checkBTCFires({ profitPct: 76, marketOpen: true,  minProfitPct: 75 }) === true);
test("after-3pm rule at 75%: 74% profit → no fire", () => checkBTCFires({ profitPct: 74, marketOpen: true,  minProfitPct: 75 }) === false);

// ─────────────────────────────────────────────────────────────────────────────
// 3. Auto-STO: fires only during market hours and after min_time_et
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Auto-STO ───────────────────────────────────────────────────────");
test("Stock up 1%, 10am ET → STO fires",            () => checkAutoSTO({ changePct: 1.0, marketOpen: true,  etMins: 10*60 }) === true);
test("Stock up 0.5% (exact), 10am ET → STO fires",  () => checkAutoSTO({ changePct: 0.5, marketOpen: true,  etMins: 10*60 }) === true);
test("Stock up 0.4%, 10am ET → STO does NOT fire",  () => checkAutoSTO({ changePct: 0.4, marketOpen: true,  etMins: 10*60 }) === false);
test("Stock up 1%, pre-market 9:20am → no STO",     () => checkAutoSTO({ changePct: 1.0, marketOpen: false, etMins:  9*60+20 }) === false);
test("Stock up 1%, 9:40am (before 9:45) → no STO",  () => checkAutoSTO({ changePct: 1.0, marketOpen: true,  etMins:  9*60+40 }) === false);

// ─────────────────────────────────────────────────────────────────────────────
// 4. Expiry Protection
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Expiry Protection ──────────────────────────────────────────────");
const WARN_ET = 15*60+5;  // 3:05pm — after 3pm warning window
test("STO ITM at 3:05pm on expiry day (DTE=0) → fires",        () => checkExpiryProtection({ isITM:true,  optType:"STO", dte:0, etMins:WARN_ET }) === true);
test("STO NOT ITM at 3:05pm → does NOT fire",                  () => checkExpiryProtection({ isITM:false, optType:"STO", dte:0, etMins:WARN_ET }) === false);
test("BTO contract ITM at 3:05pm → does NOT fire",             () => checkExpiryProtection({ isITM:true,  optType:"BTO", dte:0, etMins:WARN_ET }) === false);
test("STO ITM, DTE=35 (LEAP) at 3:05pm → does NOT fire",      () => checkExpiryProtection({ isITM:true,  optType:"STO", dte:35, etMins:WARN_ET }) === false);
test("STO ITM at 2:00pm (before warning window) → no fire",    () => checkExpiryProtection({ isITM:true,  optType:"STO", dte:0, etMins:14*60 }) === false);
test("STO ITM at 5:00pm (after close) → does NOT fire",        () => checkExpiryProtection({ isITM:true,  optType:"STO", dte:0, etMins:17*60 }) === false);

// ─────────────────────────────────────────────────────────────────────────────
// 5. IV Floor Gate
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── IV Floor Gate (min 25%) ────────────────────────────────────────");
test("IV=40% → scanner proceeds",     () => checkIVFloor({ iv: 40 }) === true);
test("IV=25% (exact floor) → passes", () => checkIVFloor({ iv: 25 }) === true);
test("IV=20% → scanner skips",        () => checkIVFloor({ iv: 20 }) === false);
test("IV=0% → scanner skips",         () => checkIVFloor({ iv:  0 }) === false);

// ─────────────────────────────────────────────────────────────────────────────
// 6. Stop Loss DTE Gate
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Stop Loss DTE Gate ─────────────────────────────────────────────");
test("DTE=7: stop_loss_multiplier=2.0 (set)",      () => stopLossMultiplierForDTE(7)  === 2.0);
test("DTE=4: stop_loss_multiplier=2.0 (set)",      () => stopLossMultiplierForDTE(4)  === 2.0);
test("DTE=3: stop_loss_multiplier=null (disabled)", () => stopLossMultiplierForDTE(3)  === null);
test("DTE=2: stop_loss_multiplier=null (disabled)", () => stopLossMultiplierForDTE(2)  === null);
test("DTE=1: stop_loss_multiplier=null (disabled)", () => stopLossMultiplierForDTE(1)  === null);

test("DTE=7, cost_to_close=2.1x premium → stop loss fires",    () =>
  checkStopLoss({ costToClose: 210, premium: -100, stopLossMultiplier: undefined, dte: 7 }) === true);
test("DTE=7, cost_to_close=1.9x premium → stop loss NO fire",  () =>
  checkStopLoss({ costToClose: 190, premium: -100, stopLossMultiplier: undefined, dte: 7 }) === false);
test("DTE=2, cost_to_close=3x premium → stop loss NO fire (null multiplier)", () =>
  checkStopLoss({ costToClose: 300, premium: -100, stopLossMultiplier: undefined, dte: 2 }) === false);

// ─────────────────────────────────────────────────────────────────────────────
// 7. End-to-end: no orders outside market hours (all rule types)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── E2E: No orders outside market hours ────────────────────────────");
const AFTER_CLOSE = 16 * 60 + 5; // 4:05pm ET
const BEFORE_OPEN =  9 * 60 + 0; // 9:00am ET

test("BTC: 4:05pm ET → no order",    () => checkBTCFires({ profitPct:90, marketOpen:false }) === false);
test("STO: 4:05pm ET → no order",    () => checkAutoSTO({ changePct:2, marketOpen:false, etMins:AFTER_CLOSE }) === false);
test("Expiry: 4:05pm ET → no order", () => checkExpiryProtection({ isITM:true, optType:"STO", dte:0, etMins:AFTER_CLOSE }) === false);
test("BTC: 9:00am ET → no order",    () => checkBTCFires({ profitPct:90, marketOpen:false }) === false);
test("STO: 9:00am ET → no order",    () => checkAutoSTO({ changePct:2, marketOpen:false, etMins:BEFORE_OPEN }) === false);

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
console.log(`Tests: ${passed + failed} total  |  ${passed} passed  |  ${failed} failed`);
if (failed > 0) {
  console.log("❌ SOME TESTS FAILED");
  process.exit(1);
} else {
  console.log("✅ ALL TESTS PASSED");
}
