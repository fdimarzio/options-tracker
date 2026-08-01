// src/lib/pnl.js
// Shared close-P&L math for client-side close/edit flows (ImportPage, dashboard edit form).
//
// openPremium is the ORIGINAL signed premium of the opening leg (negative for BTO/debit,
// positive for STO/credit). costToClose is always a positive magnitude (what it cost to
// buy back a short, or the proceeds received selling a long).
export function computeClosePnl(openOptType, openPremium, costToClose) {
  const isLong = openOptType === "BTO";
  const premium = +openPremium || 0;
  const ctc     = +costToClose || 0;
  const profit  = isLong ? premium + ctc : premium - ctc;
  const profitPct = premium !== 0 ? Math.round((profit / Math.abs(premium)) * 10000) / 10000 : null;
  return { profit: Math.round(profit * 100) / 100, profitPct };
}
