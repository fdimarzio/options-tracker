// src/lib/annualizedReturn.js
// Withdrawal/deposit-aware YTD portfolio return + the options strategy's contribution,
// annualized. Pure and side-effect-free so it can be unit-tested and shared by the
// Dashboard and Analytics views (keep the two call sites in pri-tod-v3.jsx in sync).
//
// WHY THIS EXISTS
// A naive YTD return — (end - start) / start — is misleading the moment money moves in or
// out of the account. If you withdraw $50k, the ending balance drops and the account looks
// like it lost money when it didn't. If you deposit $50k, the ending balance jumps and the
// account looks like it gained money it didn't earn. This computes a cash-flow-aware return
// (modified Dietz) so withdrawals and deposits are treated as capital movements, not
// performance, and annualizes the year-to-date figure.
//
// INPUTS (all plain data — no React, no Supabase):
//   monthTotals:  { "YYYY-MM": number|null }
//                 End-of-month total portfolio value (all tracked accounts combined), or
//                 null for a month that isn't fully tracked yet.
//   cashFlows:    { "YYYY-MM": { deposit?: number, withdrawal?: number } }
//                 External cash moved IN (deposit, +) or OUT (withdrawal, -) during that
//                 month. Both are stored as positive magnitudes here. Withdrawals are the
//                 "money removed" that must NOT be read as an investment loss.
//   optionsProfitYTD: number
//                 Realized options P&L for the year — what the options strategy generated.
//   asOf:         Date  "now" (defaults to new Date()).
//
// OUTPUT: a transparent breakdown (see buildResult below). When the data needed for an
// honest number is missing, `ok:false` and `gaps` explain why — the caller should surface
// the gap rather than render a misleading percentage.

const MS_PER_DAY = 86400000;
const round2 = (n) => (n == null || !isFinite(n) ? n : Math.round(n * 100) / 100);
const round4 = (n) => (n == null || !isFinite(n) ? n : Math.round(n * 10000) / 10000);

// Last calendar day of a "YYYY-MM" month, as a UTC Date (used to date a month-end snapshot).
function monthEndDate(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  // day 0 of the next month === last day of this month
  return new Date(Date.UTC(y, m, 0));
}
// First calendar day of a year ("value entering the year"), as a UTC Date.
function yearStartDate(year) {
  return new Date(Date.UTC(year, 0, 1));
}
function daysBetween(a, b) {
  return (b.getTime() - a.getTime()) / MS_PER_DAY;
}
function monthKeysInRange(year) {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

// Compounded annualization of a period return r over `days`. Returns null when it isn't
// meaningful (non-positive growth factor, or a zero-length window).
function annualize(r, days) {
  if (r == null || days == null || days <= 0) return null;
  const growth = 1 + r;
  if (growth <= 0) return null; // can't raise a non-positive base to a fractional power
  return Math.pow(growth, 365 / days) - 1;
}

export function computeAnnualizedReturn({
  monthTotals = {},
  cashFlows = {},
  optionsProfitYTD = 0,
  asOf = new Date(),
} = {}) {
  const gaps = [];
  const year = asOf.getUTCFullYear();
  const prevDecKey = `${year - 1}-12`;
  const asOfMonthKey = `${asOf.getUTCFullYear()}-${String(asOf.getUTCMonth() + 1).padStart(2, "0")}`;

  const buildResult = (extra) => ({
    ok: false,
    year,
    startValue: null,
    startDate: null,
    startMonth: null,
    startFromYearOpen: false,
    endValue: null,
    endDate: null,
    endMonth: null,
    deposits: 0,
    withdrawals: 0,
    netCashFlow: 0,
    weightedCashFlow: 0,
    capitalBase: null,
    gain: null,
    ytdReturn: null,
    annualizedReturn: null,
    optionsProfitYTD: round2(+optionsProfitYTD || 0),
    optionsReturnYTD: null,
    optionsAnnualized: null,
    daysElapsed: null,
    gaps,
    ...extra,
  });

  // ── Starting value: the balance entering the year. Prefer prior December's month-end
  // (a true year-opening balance); otherwise fall back to the earliest in-year month-end
  // and note that the window doesn't start at Jan 1. ───────────────────────────────────
  let startValue = null;
  let startDate = null;
  let startMonth = null;
  let startFromYearOpen = false;
  if (monthTotals[prevDecKey] != null) {
    startValue = +monthTotals[prevDecKey];
    startDate = yearStartDate(year); // value as of Jan 1
    startMonth = prevDecKey;
    startFromYearOpen = true;
  } else {
    for (const mk of monthKeysInRange(year)) {
      if (mk === asOfMonthKey) break; // don't anchor the start to the still-open current month
      if (monthTotals[mk] != null) {
        startValue = +monthTotals[mk];
        startDate = monthEndDate(mk);
        startMonth = mk;
        break;
      }
    }
    if (startValue != null) {
      gaps.push(
        `No year-opening balance (Dec ${year - 1}) recorded — return is measured from ${startMonth}, so it understates the full year.`
      );
    }
  }
  if (startValue == null) {
    gaps.push(
      `No portfolio balance recorded for ${year} yet — enter month-end balances to compute a year-to-date return.`
    );
    return buildResult();
  }

  // ── Ending value: current month's live total if present, else the latest in-year
  // month-end at or before now that is tracked. ─────────────────────────────────────────
  let endValue = null;
  let endDate = null;
  let endMonth = null;
  if (monthTotals[asOfMonthKey] != null) {
    endValue = +monthTotals[asOfMonthKey];
    endDate = asOf;
    endMonth = asOfMonthKey;
  } else {
    for (const mk of [...monthKeysInRange(year)].reverse()) {
      if (mk > asOfMonthKey) continue;
      if (mk === startMonth) break;
      if (monthTotals[mk] != null) {
        endValue = +monthTotals[mk];
        endDate = monthEndDate(mk);
        endMonth = mk;
        break;
      }
    }
  }
  if (endValue == null) {
    gaps.push(
      `Only one balance point recorded for ${year} — need a later balance to measure a return.`
    );
    return buildResult({ startValue: round2(startValue), startDate, startMonth, startFromYearOpen });
  }

  const daysElapsed = daysBetween(startDate, endDate);
  if (daysElapsed <= 0) {
    gaps.push("Start and end dates are not in order — cannot compute a return.");
    return buildResult({
      startValue: round2(startValue),
      startDate,
      startMonth,
      startFromYearOpen,
      endValue: round2(endValue),
      endDate,
      endMonth,
    });
  }

  // ── Cash flows strictly after the start date, up to and including the end month.
  // Each flow is dated at its month-end and time-weighted (modified Dietz): a flow that
  // arrived late in the window contributed capital for only part of the period. ─────────
  let deposits = 0;
  let withdrawals = 0;
  let weightedCashFlow = 0;
  let recordedFlowMonths = 0;
  for (const mk of monthKeysInRange(year)) {
    if (mk < startMonth || (startFromYearOpen === false && mk === startMonth)) continue;
    if (mk > endMonth) continue;
    const cf = cashFlows[mk] || {};
    const dep = +cf.deposit || 0;
    const wd = +cf.withdrawal || 0;
    if (dep === 0 && wd === 0) continue;
    recordedFlowMonths += 1;
    const flowDate = monthEndDate(mk);
    // Clamp the weight to [0,1]; a flow at or after the end date gets weight 0.
    const w = Math.max(0, Math.min(1, daysBetween(flowDate, endDate) / daysElapsed));
    deposits += dep;
    withdrawals += wd;
    const net = dep - wd; // deposit adds capital, withdrawal removes it
    weightedCashFlow += w * net;
  }

  const netCashFlow = deposits - withdrawals;
  const capitalBase = startValue + weightedCashFlow;
  // Gain strips external cash movements out of the end-vs-start change.
  const gain = endValue - startValue - netCashFlow;

  if (capitalBase <= 0) {
    gaps.push("Capital base is zero or negative after cash flows — return is not meaningful.");
    return buildResult({
      startValue: round2(startValue),
      startDate,
      startMonth,
      startFromYearOpen,
      endValue: round2(endValue),
      endDate,
      endMonth,
      deposits: round2(deposits),
      withdrawals: round2(withdrawals),
      netCashFlow: round2(netCashFlow),
      weightedCashFlow: round2(weightedCashFlow),
      capitalBase: round2(capitalBase),
      gain: round2(gain),
      daysElapsed: Math.round(daysElapsed),
    });
  }

  const ytdReturn = gain / capitalBase;
  const annualizedReturn = annualize(ytdReturn, daysElapsed);
  // Options contribution: realized options P&L as a share of the same capital base that
  // produced it ("relative to portfolio capital"), then annualized the same way.
  const optionsProfit = +optionsProfitYTD || 0;
  const optionsReturnYTD = optionsProfit / capitalBase;
  const optionsAnnualized = annualize(optionsReturnYTD, daysElapsed);

  if (annualizedReturn == null) {
    gaps.push("Loss exceeds the capital base — an annualized figure would be misleading, so it's withheld.");
  }
  if (recordedFlowMonths === 0) {
    gaps.push("No deposits or withdrawals recorded this year — if any happened, enter them so the return isn't skewed.");
  }

  return {
    ok: true,
    year,
    startValue: round2(startValue),
    startDate,
    startMonth,
    startFromYearOpen,
    endValue: round2(endValue),
    endDate,
    endMonth,
    deposits: round2(deposits),
    withdrawals: round2(withdrawals),
    netCashFlow: round2(netCashFlow),
    weightedCashFlow: round2(weightedCashFlow),
    capitalBase: round2(capitalBase),
    gain: round2(gain),
    ytdReturn: round4(ytdReturn),
    annualizedReturn: round4(annualizedReturn),
    optionsProfitYTD: round2(optionsProfit),
    optionsReturnYTD: round4(optionsReturnYTD),
    optionsAnnualized: round4(optionsAnnualized),
    daysElapsed: Math.round(daysElapsed),
    gaps,
  };
}

export default computeAnnualizedReturn;
