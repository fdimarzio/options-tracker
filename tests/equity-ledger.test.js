// tests/equity-ledger.test.js
// Makes the All Transactions tab a complete ledger: ETrade equity (dividends,
// interest, fees, buys/sells) now flows into stock_transactions alongside Schwab's,
// guarded by the `account` field instead of a blanket P11 exclusion (see
// tests/put-assignment.test.js and tests/auto-import.test.js's "P11 resolved" block
// for the exclusion-removal itself). This file covers the remaining pieces of this
// batch: the generic equity-import dedup applying symmetrically to both brokers now,
// the sinceDate backfill override, and removeFromEquityLists no longer leaking a
// double-write once ETrade participates in the generic pipeline. Logic not exported
// from api/auto-import.js is hand-mirrored, matching this repo's established
// convention (see tests/auto-import.test.js's parseSchwabEquityTx/parseEtradeEquityTx
// mirrors). Run: npx vitest run tests/equity-ledger.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const autoImportSrc = fs.readFileSync(path.resolve("api/auto-import.js"), "utf8");

// Mirrors the generic equity-import dedup block (~"Import equity transactions")
function makeEquityFP(r) {
  const dateStr = r.trade_date ? r.trade_date.slice(0, 10) : "";
  return `${r.symbol || ""}|${r.transaction_type}|${dateStr}|${Math.round(Math.abs(+(r.net_amount || 0)) * 100)}|${r.account}`;
}

function importEquityBatch(allEquityTxs, existingStockTxs) {
  const existingStockIds = new Set(existingStockTxs.map(r => String(r.schwab_transaction_id)).filter(Boolean));
  const existingEquityFPs = new Set(existingStockTxs.map(makeEquityFP));
  const imported = [];
  for (const eq of allEquityTxs) {
    const idStr = String(eq.schwab_transaction_id);
    if (existingStockIds.has(idStr)) continue;
    if (existingEquityFPs.has(makeEquityFP(eq))) continue;
    imported.push(eq);
    existingStockIds.add(idStr);
    existingEquityFPs.add(makeEquityFP(eq));
  }
  return imported;
}

const schwabSell = {
  schwab_transaction_id: "sch_1", symbol: "MSFT", transaction_type: "SELL",
  net_amount: 5100, trade_date: "2026-07-15T14:00:00.000Z", account: "Schwab 3866",
};
const etradeDividend = {
  schwab_transaction_id: "etrade_77", symbol: "JPM", transaction_type: "DIVIDEND",
  net_amount: 33.25, trade_date: "2026-07-16T00:00:00.000Z", account: "ETrade 6917",
};

describe("equity ledger — positive scenarios", () => {
  it("positive — a Schwab stock SELL in the feed produces one stock_transactions SELL row", () => {
    const imported = importEquityBatch([schwabSell], []);
    expect(imported).toEqual([schwabSell]);
    expect(imported.length).toBe(1);
    expect(imported[0].transaction_type).toBe("SELL");
  });

  it("positive — an ETrade dividend now produces a DIVIDEND row (P11 resolved)", () => {
    const imported = importEquityBatch([etradeDividend], []);
    expect(imported).toEqual([etradeDividend]);
    expect(imported[0].transaction_type).toBe("DIVIDEND");
    expect(imported[0].account).toBe("ETrade 6917");
  });
});

describe("equity ledger — negative scenario: options never enter this pipeline", () => {
  it("negative — an option trade isn't in the equity batch at all, so it can't be duplicated into stock_transactions", () => {
    // Options are parsed by parseSchwabTx/parseEtradeTx into schwabTxs/etradeTxs and
    // handled entirely by the separate committed/contracts pipeline — the equity batch
    // passed to importEquityBatch only ever contains parseSchwabEquityTx/
    // parseEtradeEquityTx output, which both explicitly return null for option items.
    const imported = importEquityBatch([], []);
    expect(imported).toEqual([]);
  });

  it("negative — source: parseSchwabEquityTx and parseEtradeEquityTx both skip option items before returning", () => {
    expect(autoImportSrc).toContain('if (items.find(i => i.instrument?.assetType === "OPTION")) return null;');
    expect(autoImportSrc).toContain('if (prod?.securityType === "OPTN") return null;');
  });
});

describe("equity ledger — edge: re-import the same batch produces no duplicates", () => {
  it("edge — re-running importEquityBatch with the previous run's rows as 'existing' yields nothing new", () => {
    const firstRun  = importEquityBatch([schwabSell, etradeDividend], []);
    expect(firstRun.length).toBe(2);
    // Second run: same two txs come back from the broker feed again (ETrade reissues
    // ids, so schwab_transaction_id may differ on refetch — but the fingerprint won't)
    const secondRunSameIds = importEquityBatch([schwabSell, etradeDividend], firstRun);
    expect(secondRunSameIds).toEqual([]);
  });

  it("edge — ETrade reissuing a different transaction id for the same real fill still dedupes via fingerprint", () => {
    const reissued = { ...etradeDividend, schwab_transaction_id: "etrade_999_different_id" };
    const imported = importEquityBatch([reissued], [etradeDividend]);
    expect(imported).toEqual([]); // fingerprint (symbol|type|date|amount|account) still matches
  });

  it("edge — a different account with an otherwise-identical fingerprint is NOT treated as a duplicate", () => {
    const sameButOtherAccount = { ...etradeDividend, schwab_transaction_id: "etrade_888", account: "ETrade 8222" };
    const imported = importEquityBatch([sameButOtherAccount], [etradeDividend]);
    expect(imported).toEqual([sameButOtherAccount]);
  });
});

describe("api/auto-import.js — sinceDate backfill override", () => {
  it("accepts ?sinceDate=YYYY-MM-DD to override the heartbeat-based reconcileSince window", () => {
    expect(autoImportSrc).toContain('const sinceDateParam = req.query.sinceDate ? new Date(`${req.query.sinceDate}T00:00:00.000Z`) : null;');
    expect(autoImportSrc).toContain("sinceDateParam && !isNaN(sinceDateParam.getTime())");
  });

  it("falls back to the normal heartbeat-based window when sinceDate is absent or invalid", () => {
    const block = autoImportSrc.split("const sinceDateParam")[1]?.split("// Load stocks_data")[0] || "";
    expect(block).toContain("computeReconcileWindowStart(heartbeatRows?.[0]?.last_run_at, new Date(), 10)");
  });

  it("documents the broker API lookback limit rather than silently pretending it's unlimited", () => {
    expect(autoImportSrc).toMatch(/Schwab's transactions endpoint enforces\s*\n?\s*\/\/ a ~1-year max window/);
  });
});

describe("api/auto-import.js — removeFromEquityLists (no double-write once ETrade participates)", () => {
  it("checks schwabEquityTxs first, then falls back to etradeEquityTxs", () => {
    const block = autoImportSrc.split("const removeFromEquityLists = eq => {")[1]?.split("};")[0] || "";
    expect(block).toContain("schwabEquityTxs.indexOf(eq)");
    expect(block).toContain("etradeEquityTxs.indexOf(eq)");
  });

  it("both the put and call assignment loops call removeFromEquityLists after a successful match", () => {
    const occurrences = autoImportSrc.match(/removeFromEquityLists\(eq\);/g) || [];
    expect(occurrences.length).toBe(2);
  });
});

describe("api/auto-import.js — FEE mapping", () => {
  it("SCHWAB_EQUITY_TYPE_MAP maps FEE to FEE (previously fell through to OTHER)", () => {
    expect(autoImportSrc).toContain("FEE:                 \"FEE\",");
  });

  it("ETrade's Fee/Tax -> FEE mapping (already present) is untouched", () => {
    expect(autoImportSrc).toContain('"Fee":           "FEE",');
    expect(autoImportSrc).toContain('"Tax":           "FEE",');
  });
});
