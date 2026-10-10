// tests/reconcile-engine.test.js
// Unit tests for the broker- and transaction-type-agnostic reconciliation core
// (api/_lib/reconcileEngine.js) behind the monthly reconciliation job.
// Run: npx vitest run tests/reconcile-engine.test.js

import { describe, it, expect } from "vitest";
import {
  normalizeBroker,
  normalizeAmountCents,
  normalizeDate,
  canonicalType,
  normalizeTxn,
  reconcile,
  diffReconciliations,
  summarizeForAlert,
  extractStatementTxns,
} from "../api/_lib/reconcileEngine.js";

describe("normalizers", () => {
  it("normalizeBroker recognizes Schwab and ETrade from account strings", () => {
    expect(normalizeBroker("Schwab ...3866")).toBe("Schwab");
    expect(normalizeBroker("ETrade 8222")).toBe("ETrade");
    expect(normalizeBroker("etrade-6917")).toBe("ETrade");
    expect(normalizeBroker("E*TRADE")).toBe("ETrade");
    expect(normalizeBroker("")).toBe("Unknown");
  });

  it("normalizeAmountCents is exact integer cents, strips $ and commas", () => {
    expect(normalizeAmountCents("213.50")).toBe(21350);
    expect(normalizeAmountCents("$1,819.05")).toBe(181905);
    expect(normalizeAmountCents(-209.66)).toBe(-20966);
    expect(normalizeAmountCents(null)).toBeNull();
    expect(normalizeAmountCents("n/a")).toBeNull();
  });

  it("normalizeDate handles ISO, MM/DD/YYYY, and Date", () => {
    expect(normalizeDate("2026-06-05T14:30:00Z")).toBe("2026-06-05");
    expect(normalizeDate("06/05/2026")).toBe("2026-06-05");
    expect(normalizeDate(new Date("2026-06-05T00:00:00Z"))).toBe("2026-06-05");
    expect(normalizeDate(null)).toBeNull();
  });

  it("canonicalType maps broker/app synonyms across ALL transaction types", () => {
    expect(canonicalType("Bought")).toBe("BUY");
    expect(canonicalType("Sold")).toBe("SELL");
    expect(canonicalType("Dividend")).toBe("DIVIDEND");
    expect(canonicalType("INTEREST")).toBe("INTEREST");
    expect(canonicalType("Wire")).toBe("DEPOSIT");
    expect(canonicalType("Withdrawal")).toBe("WITHDRAWAL");
    expect(canonicalType("Journal")).toBe("JOURNAL");
    expect(canonicalType("TAX_WITHHOLDING")).toBe("TAX_WITHHOLDING");
    expect(canonicalType("STO")).toBe("OPTION_STO");
    expect(canonicalType("BTC")).toBe("OPTION_BTC");
    expect(canonicalType("Expired")).toBe("OPTION_EXPIRED");
    expect(canonicalType("Assigned")).toBe("ASSIGNMENT");
    expect(canonicalType("something weird")).toBe("OTHER");
  });

  it("normalizeTxn reads both stock_transactions and contracts field shapes", () => {
    const stock = normalizeTxn({ symbol: "AAPL", transaction_type: "BUY", trade_date: "2026-06-05T00:00:00Z", net_amount: -213.5, account: "Schwab 1", schwab_transaction_id: 3661 });
    expect(stock).toMatchObject({ broker: "Schwab", symbol: "AAPL", type: "BUY", date: "2026-06-05", amountCents: -21350, brokerTxnId: "3661" });

    const contract = normalizeTxn({ stock: "JPM", opt_type: "STO", date_exec: "2026-05-01", premium: "360.66", account: "ETrade 8222" });
    expect(contract).toMatchObject({ broker: "ETrade", symbol: "JPM", type: "OPTION_STO", date: "2026-05-01", amountCents: 36066 });
  });
});

describe("reconcile — core matching", () => {
  const app = [
    { symbol: "AAPL", transaction_type: "BUY", trade_date: "2026-06-05", net_amount: -213.5 },
    { symbol: "JPM", transaction_type: "DIVIDEND", trade_date: "2026-06-10", net_amount: 12.34 },
  ];

  it("clean when app and broker fully agree", () => {
    const broker = [
      { symbol: "AAPL", transaction_type: "Bought", date: "06/05/2026", net_amount: -213.5 },
      { symbol: "JPM", transaction_type: "Dividend", date: "06/10/2026", net_amount: 12.34 },
    ];
    const r = reconcile({ appTxns: app, brokerTxns: broker });
    expect(r.summary.clean).toBe(true);
    expect(r.summary.matched).toBe(2);
    expect(r.discrepancyRefs).toEqual([]);
  });

  it("flags a transaction on the statement but missing from the app", () => {
    const broker = [
      { symbol: "AAPL", transaction_type: "Bought", date: "06/05/2026", net_amount: -213.5 },
      { symbol: "JPM", transaction_type: "Dividend", date: "06/10/2026", net_amount: 12.34 },
      { symbol: "NVDA", transaction_type: "Sold", date: "06/11/2026", net_amount: 3904.74 },
    ];
    const r = reconcile({ appTxns: app, brokerTxns: broker });
    expect(r.summary.clean).toBe(false);
    expect(r.summary.missingFromApp).toBe(1);
    expect(r.missingFromApp[0].symbol).toBe("NVDA");
  });

  it("flags a transaction in the app but not on the statement", () => {
    const broker = [{ symbol: "AAPL", transaction_type: "Bought", date: "06/05/2026", net_amount: -213.5 }];
    const r = reconcile({ appTxns: app, brokerTxns: broker });
    expect(r.summary.missingFromBroker).toBe(1);
    expect(r.missingFromBroker[0].symbol).toBe("JPM");
  });

  it("flags an amount mismatch (same event, premium/net differs beyond tolerance)", () => {
    const broker = [
      { symbol: "AAPL", transaction_type: "Bought", date: "06/05/2026", net_amount: -999.99 },
      { symbol: "JPM", transaction_type: "Dividend", date: "06/10/2026", net_amount: 12.34 },
    ];
    const r = reconcile({ appTxns: app, brokerTxns: broker });
    expect(r.summary.amountMismatches).toBe(1);
    expect(r.amountMismatches[0].diffCents).toBe(Math.abs(-21350 - -99999));
  });

  it("amountToleranceCents absorbs sub-penny/rounding differences as a match", () => {
    const appT = [{ symbol: "AAPL", transaction_type: "BUY", trade_date: "2026-06-05", net_amount: -213.5 }];
    const broker = [{ symbol: "AAPL", transaction_type: "Bought", date: "06/05/2026", net_amount: -213.51 }];
    expect(reconcile({ appTxns: appT, brokerTxns: broker, amountToleranceCents: 0 }).summary.amountMismatches).toBe(1);
    expect(reconcile({ appTxns: appT, brokerTxns: broker, amountToleranceCents: 1 }).summary.matched).toBe(1);
  });

  it("pairs duplicates 1:1 (two identical same-day trades) rather than collapsing them", () => {
    const appT = [
      { symbol: "TSLA", transaction_type: "SELL", trade_date: "2026-06-05", net_amount: 100 },
      { symbol: "TSLA", transaction_type: "SELL", trade_date: "2026-06-05", net_amount: 100 },
    ];
    const broker = [{ symbol: "TSLA", transaction_type: "Sold", date: "06/05/2026", net_amount: 100 }];
    const r = reconcile({ appTxns: appT, brokerTxns: broker });
    expect(r.summary.matched).toBe(1);
    expect(r.summary.missingFromBroker).toBe(1); // the un-paired second app row
  });

  it("matches on broker transaction id even when other fields drift", () => {
    const appT = [{ symbol: "AAPL", transaction_type: "BUY", trade_date: "2026-06-05", net_amount: -213.5, schwab_transaction_id: "3661" }];
    const broker = [{ symbol: "AAPL", transaction_type: "Bought", date: "06/06/2026", net_amount: -214.0, schwab_transaction_id: "3661" }];
    const r = reconcile({ appTxns: appT, brokerTxns: broker });
    expect(r.summary.matched).toBe(1);
    expect(r.matched[0].via).toBe("broker_txn_id");
  });

  it("reconciles option legs (contracts) the same way as equity", () => {
    const appT = [{ stock: "JPM", opt_type: "STO", date_exec: "2026-05-01", premium: "360.66", account: "Schwab 1" }];
    const broker = [{ symbol: "JPM", transaction_type: "STO", date: "05/01/2026", net_amount: 360.66, broker: "Schwab" }];
    const r = reconcile({ appTxns: appT, brokerTxns: broker });
    expect(r.summary.clean).toBe(true);
  });
});

describe("diffReconciliations — only alert on change", () => {
  it("detects new and resolved discrepancies", () => {
    const prev = ["MISSING_FROM_APP|2026-06-11 SELL NVDA $3904.74"];
    const curr = ["MISSING_FROM_APP|2026-06-12 SELL TSLA $100.00"];
    const d = diffReconciliations(prev, curr);
    expect(d.changed).toBe(true);
    expect(d.newDiscrepancies).toEqual(["MISSING_FROM_APP|2026-06-12 SELL TSLA $100.00"]);
    expect(d.resolved).toEqual(["MISSING_FROM_APP|2026-06-11 SELL NVDA $3904.74"]);
  });

  it("no change when the same discrepancy persists (suppresses repeat alerts)", () => {
    const refs = ["AMOUNT|2026-06-05 BUY AAPL $-213.50|vs|2026-06-05 BUY AAPL $-999.99"];
    const d = diffReconciliations(refs, refs);
    expect(d.changed).toBe(false);
    expect(d.newDiscrepancies).toEqual([]);
  });
});

describe("summarizeForAlert — quiet when clean", () => {
  it("needsAttention=false and a clean title when all scopes reconcile", () => {
    const scopes = [{ label: "Schwab (schwab)", summary: { clean: true, missingFromApp: 0, missingFromBroker: 0, amountMismatches: 0 } }];
    const a = summarizeForAlert(scopes, { newDiscrepancies: [], resolved: [] });
    expect(a.needsAttention).toBe(false);
    expect(a.title).toMatch(/clean/i);
  });

  it("needsAttention=true and itemizes the dirty scope", () => {
    const scopes = [
      { label: "Schwab (schwab)", summary: { clean: true, missingFromApp: 0, missingFromBroker: 0, amountMismatches: 0 } },
      { label: "ETrade (etrade-8222)", summary: { clean: false, missingFromApp: 2, missingFromBroker: 1, amountMismatches: 0 } },
    ];
    const a = summarizeForAlert(scopes, { newDiscrepancies: ["x"], resolved: [] });
    expect(a.needsAttention).toBe(true);
    expect(a.isNew).toBe(true);
    expect(a.message).toContain("ETrade (etrade-8222)");
    expect(a.message).not.toContain("Schwab (schwab)"); // clean scope not listed
  });
});

describe("extractStatementTxns — generalized multi-type statement parsing", () => {
  it("extracts buy/sell/dividend/interest/withdrawal lines and tags recognized types", () => {
    const text = [
      "06/05/2026  Bought  AAPL  100  $213.50  -$21,350.00",
      "06/10/2026  Dividend  JPM  $12.34",
      "06/15/2026  Interest  $4.01",
      "06/20/2026  Withdrawal  -$500.00",
      "Some non-transaction footer line",
    ].join("\n");
    const { txns, recognizedTypes } = extractStatementTxns(text, { broker: "Schwab", month: "2026-06" });
    expect(txns).toHaveLength(4);
    expect(recognizedTypes.BUY).toBe(1);
    expect(recognizedTypes.DIVIDEND).toBe(1);
    expect(txns.find((t) => t.transaction_type === "BUY").symbol).toBe("AAPL");
  });

  it("filters to the requested month", () => {
    const text = ["06/05/2026  Bought  AAPL  $213.50", "07/05/2026  Bought  AAPL  $214.00"].join("\n");
    const { txns } = extractStatementTxns(text, { broker: "Schwab", month: "2026-06" });
    expect(txns).toHaveLength(1);
    expect(txns[0].date).toBe("2026-06-05");
  });

  it("surfaces date-leading lines it cannot classify as `unparsed` (coverage-gap signal)", () => {
    const text = ["06/05/2026  Frobnicate  WAT  $1.00"].join("\n");
    const { txns, unparsed } = extractStatementTxns(text, { broker: "Schwab", month: "2026-06" });
    expect(txns).toHaveLength(0);
    expect(unparsed).toHaveLength(1);
  });
});
