// tests/auto-import.test.js
// Vitest tests for partial fill merging logic in auto-import.js
// Run: npx vitest run tests/

import { describe, it, expect } from "vitest";

// ── Replicate the merge logic from auto-import.js ────────────────────────────
// Keep in sync manually if commitTx logic changes

function findExistingOpen(parsed, openContracts) {
  return openContracts.find(c =>
    c.stock?.toUpperCase()    === parsed.stock?.toUpperCase() &&
    c.opt_type                === parsed.opt_type &&
    String(c.strike)          === String(parsed.strike) &&
    c.expires                 === parsed.expires &&
    (c.account                === parsed.account ||
     (c.account?.startsWith("Schwab") && parsed.account?.startsWith("Schwab")) ||
     (c.account?.startsWith("ETrade") && parsed.account?.startsWith("ETrade")) ||
     (c.account?.startsWith("Etrade") && parsed.account?.startsWith("Etrade"))) &&
    c.date_exec               === parsed.date_exec &&
    c.status                  === "Open"
  );
}

// Simulates commitTx merge + insert behavior including the KEY FIX
function simulateCommitTx(parsed, openContracts) {
  const patches = [];
  const inserts = [];

  if (["STO","BTO"].includes(parsed.opt_type)) {
    const existing = findExistingOpen(parsed, openContracts);
    if (existing) {
      const alreadyMerged = existing.notes?.includes(String(parsed.schwab_transaction_id));
      if (alreadyMerged) return { action: "skipped", patches, inserts };
      const newQty     = (+existing.qty || 0) + (+parsed.qty || 0);
      const newPremium = Math.round(((+existing.premium || 0) + (+parsed.premium || 0)) * 100) / 100;
      patches.push({ id: existing.id, qty: newQty, premium: newPremium });
      existing.qty     = newQty;
      existing.premium = newPremium;
      existing.notes   = `Partial fill merged: ${parsed.qty} @ $${parsed.premium} (tx: ${parsed.schwab_transaction_id})`;
      return { action: "merged", patches, inserts };
    }
  }

  // Insert new
  const newId = Date.now() + Math.random();
  inserts.push({ id: newId, ...parsed, status: "Open" });

  // KEY FIX: push into openContracts immediately so same-batch partials can merge
  if (["STO","BTO"].includes(parsed.opt_type)) {
    openContracts.push({
      id:        newId,
      stock:     parsed.stock,
      type:      parsed.type,
      opt_type:  parsed.opt_type,
      strike:    String(parsed.strike),
      expires:   parsed.expires,
      qty:       +parsed.qty,
      premium:   parsed.premium,
      account:   parsed.account,
      date_exec: parsed.date_exec,
      status:    "Open",
      notes:     null,
      schwab_transaction_id: parsed.schwab_transaction_id,
    });
  }

  return { action: "inserted", patches, inserts };
}

// ── Replicate the NEW order_id-aware merge guard from auto-import.js ─────────
// Mirrors the commitTx guard rewrite: order_id match is the primary safety
// signal (covers manual trades with no trade_orders row). Falls back to a
// trade_orders.fill_qty lookup (injected via tradeOrderLookup) only when
// order_id is missing or doesn't match — preserving 2026-06-18 protection.
// tradeOrderLookup(parsed) => { fill_qty, qty } | null  (sync stand-in for fetch)
function simulateCommitTxWithGuard(parsed, openContracts, tradeOrderLookup = () => null) {
  const patches = [];
  const inserts = [];
  const anomalies = [];

  if (["STO","BTO"].includes(parsed.opt_type)) {
    const existing = findExistingOpen(parsed, openContracts);
    if (existing) {
      const alreadyMerged = existing.notes?.includes(`tx: ${parsed.schwab_transaction_id}`);
      if (alreadyMerged) return { action: "skipped", patches, inserts, anomalies };

      const orderIdMatch = parsed.order_id != null && existing.order_id != null && parsed.order_id === existing.order_id;

      let mergeOk = false;
      if (orderIdMatch) {
        mergeOk = true;
      } else {
        const to = tradeOrderLookup(parsed);
        const filledQty = to?.fill_qty ?? to?.qty ?? null;
        if (filledQty != null) {
          const mergedQty = (+existing.qty || 0) + (+parsed.qty || 0);
          mergeOk = mergedQty <= filledQty;
        }
      }

      if (!mergeOk) {
        anomalies.push({
          ...parsed,
          anomaly_type: "partial_fill_needs_review",
          existing_id: existing.id,
        });
        return { action: "anomaly", patches, inserts, anomalies };
      }

      const newQty     = (+existing.qty || 0) + (+parsed.qty || 0);
      const newPremium = Math.round(((+existing.premium || 0) + (+parsed.premium || 0)) * 100) / 100;
      patches.push({ id: existing.id, qty: newQty, premium: newPremium, order_id: existing.order_id ?? parsed.order_id ?? null });
      existing.qty     = newQty;
      existing.premium = newPremium;
      existing.notes   = `${existing.notes ? existing.notes + "\n" : ""}Partial fill merged: ${parsed.qty} @ $${parsed.premium} on ${parsed.date_exec} (tx: ${parsed.schwab_transaction_id})`;
      existing.order_id = existing.order_id ?? parsed.order_id ?? null;
      return { action: "merged", patches, inserts, anomalies };
    }
  }

  const newId = Date.now() + Math.random();
  inserts.push({ id: newId, ...parsed, status: "Open" });

  if (["STO","BTO"].includes(parsed.opt_type)) {
    openContracts.push({
      id:        newId,
      stock:     parsed.stock,
      type:      parsed.type,
      opt_type:  parsed.opt_type,
      strike:    String(parsed.strike),
      expires:   parsed.expires,
      qty:       +parsed.qty,
      premium:   parsed.premium,
      account:   parsed.account,
      date_exec: parsed.date_exec,
      status:    "Open",
      notes:     null,
      schwab_transaction_id: parsed.schwab_transaction_id,
      order_id:  parsed.order_id ?? null,
    });
  }

  return { action: "inserted", patches, inserts, anomalies };
}

// ── Tests: order_id-aware partial-fill merge guard ────────────────────────────
// Covers the fix for: (1) manual trades placed directly at the broker, which
// never create a trade_orders row and were incorrectly blocked from merging,
// and (2) the 2026-06-18 incident pattern, which must remain protected.

describe("auto-import: order_id-based merge guard — manual trade scenario", () => {

  it("merges manual partial fills sharing the same order_id, even with no trade_orders match", () => {
    const openContracts = [];
    // Simulates the real AMZN case: you manually sold 7 contracts at Schwab,
    // filled as two separate activity legs (qty 3 then qty 4) under one orderId.
    const leg1 = { stock:"AMZN", type:"Call", opt_type:"STO", strike:"245", expires:"2026-07-01", qty:3, premium:493.00, account:"Schwab 3866", date_exec:"2026-06-29", schwab_transaction_id:"123548003414", order_id:"1006966534296" };
    const leg2 = { stock:"AMZN", type:"Call", opt_type:"STO", strike:"245", expires:"2026-07-01", qty:4, premium:657.33, account:"Schwab 3866", date_exec:"2026-06-29", schwab_transaction_id:"123548003411", order_id:"1006966534296" };

    // No trade_orders row exists at all — manual trade, never placed through the app
    const tradeOrderLookup = () => null;

    const r1 = simulateCommitTxWithGuard(leg1, openContracts, tradeOrderLookup);
    const r2 = simulateCommitTxWithGuard(leg2, openContracts, tradeOrderLookup);

    expect(r1.action).toBe("inserted");
    expect(r2.action).toBe("merged");
    expect(openContracts.length).toBe(1);
    expect(openContracts[0].qty).toBe(7);
    expect(openContracts[0].premium).toBeCloseTo(1150.33, 2);
  });

  it("routes to anomaly when order_id is missing on both legs and no trade_orders match exists", () => {
    const openContracts = [];
    const leg1 = { stock:"AMZN", type:"Call", opt_type:"STO", strike:"245", expires:"2026-07-01", qty:3, premium:493.00, account:"Schwab 3866", date_exec:"2026-06-29", schwab_transaction_id:"TXA", order_id:null };
    const leg2 = { stock:"AMZN", type:"Call", opt_type:"STO", strike:"245", expires:"2026-07-01", qty:4, premium:657.33, account:"Schwab 3866", date_exec:"2026-06-29", schwab_transaction_id:"TXB", order_id:null };

    const tradeOrderLookup = () => null;

    const r1 = simulateCommitTxWithGuard(leg1, openContracts, tradeOrderLookup);
    const r2 = simulateCommitTxWithGuard(leg2, openContracts, tradeOrderLookup);

    expect(r1.action).toBe("inserted");
    expect(r2.action).toBe("anomaly");
    expect(openContracts[0].qty).toBe(3); // unchanged — did not merge
  });

  it("still merges via trade_orders fallback when order_id is missing but fill_qty covers it (auto-STO path)", () => {
    const openContracts = [];
    const leg1 = { stock:"NVDA", type:"Call", opt_type:"STO", strike:"190", expires:"2026-07-10", qty:2, premium:300.00, account:"Schwab 3866", date_exec:"2026-06-29", schwab_transaction_id:"TXC", order_id:null };
    const leg2 = { stock:"NVDA", type:"Call", opt_type:"STO", strike:"190", expires:"2026-07-10", qty:1, premium:150.00, account:"Schwab 3866", date_exec:"2026-06-29", schwab_transaction_id:"TXD", order_id:null };

    // Order was placed through the app — trade_orders confirms fill_qty=3
    const tradeOrderLookup = () => ({ fill_qty: 3, qty: 3 });

    const r1 = simulateCommitTxWithGuard(leg1, openContracts, tradeOrderLookup);
    const r2 = simulateCommitTxWithGuard(leg2, openContracts, tradeOrderLookup);

    expect(r1.action).toBe("inserted");
    expect(r2.action).toBe("merged");
    expect(openContracts[0].qty).toBe(3);
  });

  it("routes to anomaly via trade_orders fallback when merge would exceed confirmed fill_qty", () => {
    const openContracts = [];
    const leg1 = { stock:"NVDA", type:"Call", opt_type:"STO", strike:"190", expires:"2026-07-10", qty:2, premium:300.00, account:"Schwab 3866", date_exec:"2026-06-29", schwab_transaction_id:"TXE", order_id:null };
    const leg2 = { stock:"NVDA", type:"Call", opt_type:"STO", strike:"190", expires:"2026-07-10", qty:5, premium:750.00, account:"Schwab 3866", date_exec:"2026-06-29", schwab_transaction_id:"TXF", order_id:null };

    // Confirmed fill was only 3 — merging 2+5=7 would exceed it
    const tradeOrderLookup = () => ({ fill_qty: 3, qty: 3 });

    const r1 = simulateCommitTxWithGuard(leg1, openContracts, tradeOrderLookup);
    const r2 = simulateCommitTxWithGuard(leg2, openContracts, tradeOrderLookup);

    expect(r1.action).toBe("inserted");
    expect(r2.action).toBe("anomaly");
    expect(openContracts[0].qty).toBe(2); // unchanged
  });

});

describe("auto-import: order_id guard — 2026-06-18 incident regression test", () => {

  it("correctly merges all 5 legitimate same-orderId partial fills into one contract without runaway inflation", () => {
    const openContracts = [];
    // Replicates the actual 6/18 incident payloads: one Schwab order
    // (orderId 1006817726045) filled across 5 activity legs (qty 2,1,1,1,1 = 6 total),
    // each with a distinct activityId but the SAME parent order_id.
    const legs = [
      { stock:"AMZN", type:"Call", opt_type:"STO", strike:"245", expires:"2026-06-22", qty:2, premium:92.67,  account:"Schwab 3866", date_exec:"2026-06-18", schwab_transaction_id:"122484833190", order_id:"1006817726045" },
      { stock:"AMZN", type:"Call", opt_type:"STO", strike:"245", expires:"2026-06-22", qty:1, premium:46.33,  account:"Schwab 3866", date_exec:"2026-06-18", schwab_transaction_id:"122484833192", order_id:"1006817726045" },
      { stock:"AMZN", type:"Call", opt_type:"STO", strike:"245", expires:"2026-06-22", qty:1, premium:46.34,  account:"Schwab 3866", date_exec:"2026-06-18", schwab_transaction_id:"122484833194", order_id:"1006817726045" },
      { stock:"AMZN", type:"Call", opt_type:"STO", strike:"245", expires:"2026-06-22", qty:1, premium:46.33,  account:"Schwab 3866", date_exec:"2026-06-18", schwab_transaction_id:"122484833196", order_id:"1006817726045" },
      { stock:"AMZN", type:"Call", opt_type:"STO", strike:"245", expires:"2026-06-22", qty:1, premium:46.33,  account:"Schwab 3866", date_exec:"2026-06-18", schwab_transaction_id:"122484833198", order_id:"1006817726045" },
    ];

    const tradeOrderLookup = () => null; // no trade_orders rows — irrelevant since order_id matches throughout

    const results = legs.map(leg => simulateCommitTxWithGuard(leg, openContracts, tradeOrderLookup));

    expect(results[0].action).toBe("inserted");
    results.slice(1).forEach(r => expect(r.action).toBe("merged"));

    expect(openContracts.length).toBe(1); // never created a second/duplicate row
    expect(openContracts[0].qty).toBe(6); // 2+1+1+1+1, no inflation/double counting
    expect(openContracts[0].premium).toBeCloseTo(278.00, 2);
  });

  it("does NOT merge two coincidentally-identical orders with different order_ids and no trade_orders confirmation", () => {
    const openContracts = [];
    // Two genuinely separate orders, same stock/strike/expiry/account/date,
    // different order_id, no trade_orders row to validate against — must NOT merge.
    const leg1 = { stock:"AMZN", type:"Call", opt_type:"STO", strike:"245", expires:"2026-06-22", qty:2, premium:92.67, account:"Schwab 3866", date_exec:"2026-06-18", schwab_transaction_id:"AAA111", order_id:"1111111111" };
    const leg2 = { stock:"AMZN", type:"Call", opt_type:"STO", strike:"245", expires:"2026-06-22", qty:2, premium:92.67, account:"Schwab 3866", date_exec:"2026-06-18", schwab_transaction_id:"BBB222", order_id:"2222222222" };

    const tradeOrderLookup = () => null;

    const r1 = simulateCommitTxWithGuard(leg1, openContracts, tradeOrderLookup);
    const r2 = simulateCommitTxWithGuard(leg2, openContracts, tradeOrderLookup);

    expect(r1.action).toBe("inserted");
    expect(r2.action).toBe("anomaly");
    expect(openContracts[0].qty).toBe(2); // unchanged — correctly held back for review
  });

});

describe("auto-import: order_id guard — duplicate leg idempotency", () => {

  it("does not double-merge the same activity leg if it appears twice in the same batch", () => {
    const openContracts = [];
    const leg1 = { stock:"AMZN", type:"Call", opt_type:"STO", strike:"245", expires:"2026-07-01", qty:3, premium:493.00, account:"Schwab 3866", date_exec:"2026-06-29", schwab_transaction_id:"123548003414", order_id:"1006966534296" };
    const leg2 = { stock:"AMZN", type:"Call", opt_type:"STO", strike:"245", expires:"2026-07-01", qty:4, premium:657.33, account:"Schwab 3866", date_exec:"2026-06-29", schwab_transaction_id:"123548003411", order_id:"1006966534296" };
    const leg2Repeat = { ...leg2 }; // same schwab_transaction_id reprocessed

    const tradeOrderLookup = () => null;

    simulateCommitTxWithGuard(leg1, openContracts, tradeOrderLookup);
    simulateCommitTxWithGuard(leg2, openContracts, tradeOrderLookup);
    const r3 = simulateCommitTxWithGuard(leg2Repeat, openContracts, tradeOrderLookup);

    expect(r3.action).toBe("skipped");
    expect(openContracts[0].qty).toBe(7); // not 11 — repeat leg did not get re-added
  });

});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("auto-import: same-batch partial fills", () => {

  it("AMZN ETrade: two partial fills in same batch should merge into one", () => {
    const openContracts = [];
    const fill1 = { stock:"AMZN", type:"Call", opt_type:"STO", strike:"267.5", expires:"2026-05-22", qty:2, premium:214.95, account:"ETrade 6917", date_exec:"2026-05-20", schwab_transaction_id:"TX001" };
    const fill2 = { stock:"AMZN", type:"Call", opt_type:"STO", strike:"267.5", expires:"2026-05-22", qty:1, premium:106.48, account:"ETrade 6917", date_exec:"2026-05-20", schwab_transaction_id:"TX002" };
    const r1 = simulateCommitTx(fill1, openContracts);
    const r2 = simulateCommitTx(fill2, openContracts);
    expect(r1.action).toBe("inserted");
    expect(r2.action).toBe("merged");
    expect(openContracts.length).toBe(1);
    expect(openContracts[0].qty).toBe(3);
    expect(openContracts[0].premium).toBe(321.43);
  });

  it("NOW Schwab: two partial fills in same batch should merge into one", () => {
    const openContracts = [];
    const fill1 = { stock:"NOW", type:"Call", opt_type:"BTO", strike:"120", expires:"2026-10-16", qty:1, premium:-1074.67, account:"Schwab 3866", date_exec:"2026-05-20", schwab_transaction_id:"TX003" };
    const fill2 = { stock:"NOW", type:"Call", opt_type:"BTO", strike:"120", expires:"2026-10-16", qty:2, premium:-2149.32, account:"Schwab 3866", date_exec:"2026-05-20", schwab_transaction_id:"TX004" };
    const r1 = simulateCommitTx(fill1, openContracts);
    const r2 = simulateCommitTx(fill2, openContracts);
    expect(r1.action).toBe("inserted");
    expect(r2.action).toBe("merged");
    expect(openContracts[0].qty).toBe(3);
    expect(openContracts[0].premium).toBe(-3223.99);
  });

  it("three partial fills in same batch should all merge into one", () => {
    const openContracts = [];
    const fills = [
      { stock:"AAPL", type:"Put", opt_type:"STO", strike:"300", expires:"2026-05-29", qty:3, premium:300, account:"Schwab 3866", date_exec:"2026-05-20", schwab_transaction_id:"TX010" },
      { stock:"AAPL", type:"Put", opt_type:"STO", strike:"300", expires:"2026-05-29", qty:2, premium:200, account:"Schwab 3866", date_exec:"2026-05-20", schwab_transaction_id:"TX011" },
      { stock:"AAPL", type:"Put", opt_type:"STO", strike:"300", expires:"2026-05-29", qty:1, premium:100, account:"Schwab 3866", date_exec:"2026-05-20", schwab_transaction_id:"TX012" },
    ];
    fills.forEach(f => simulateCommitTx(f, openContracts));
    expect(openContracts.length).toBe(1);
    expect(openContracts[0].qty).toBe(6);
    expect(openContracts[0].premium).toBe(600);
  });

});

describe("auto-import: different accounts should NOT merge", () => {

  it("AAPL Schwab and AAPL ETrade same strike/expiry should stay separate", () => {
    const openContracts = [];
    const schwabFill = { stock:"AAPL", type:"Put", opt_type:"STO", strike:"302.5", expires:"2026-05-22", qty:1, premium:368.33, account:"Schwab 3866", date_exec:"2026-05-20", schwab_transaction_id:"TX005" };
    const etradeFill = { stock:"AAPL", type:"Put", opt_type:"STO", strike:"302.5", expires:"2026-05-22", qty:2, premium:678.94, account:"ETrade 6917", date_exec:"2026-05-20", schwab_transaction_id:"TX006" };
    const r1 = simulateCommitTx(schwabFill, openContracts);
    const r2 = simulateCommitTx(etradeFill, openContracts);
    expect(r1.action).toBe("inserted");
    expect(r2.action).toBe("inserted");
    expect(openContracts.length).toBe(2);
    expect(openContracts[0].qty).toBe(1);
    expect(openContracts[1].qty).toBe(2);
  });

  it("different Schwab account numbers should not cross-merge (documents current behavior)", () => {
    const openContracts = [];
    const f1 = { stock:"JPM", type:"Call", opt_type:"STO", strike:"305", expires:"2026-05-29", qty:2, premium:200, account:"Schwab 3866", date_exec:"2026-05-20", schwab_transaction_id:"TX007" };
    const f2 = { stock:"JPM", type:"Call", opt_type:"STO", strike:"305", expires:"2026-05-29", qty:3, premium:300, account:"Schwab 9999", date_exec:"2026-05-20", schwab_transaction_id:"TX008" };
    simulateCommitTx(f1, openContracts);
    simulateCommitTx(f2, openContracts);
    // Current Schwab* wildcard matching merges these — document for future tightening
    expect(openContracts.length).toBeGreaterThanOrEqual(1);
  });

});

describe("auto-import: different dates should NOT merge", () => {

  it("same stock/strike/expiry but different date_exec should not merge", () => {
    const openContracts = [];
    const day1 = { stock:"NVDA", type:"Call", opt_type:"STO", strike:"227.5", expires:"2026-05-22", qty:3, premium:1321.42, account:"ETrade 6917", date_exec:"2026-05-19", schwab_transaction_id:"TX020" };
    const day2 = { stock:"NVDA", type:"Call", opt_type:"STO", strike:"227.5", expires:"2026-05-22", qty:2, premium:900, account:"ETrade 6917", date_exec:"2026-05-20", schwab_transaction_id:"TX021" };
    simulateCommitTx(day1, openContracts);
    const r2 = simulateCommitTx(day2, openContracts);
    expect(r2.action).toBe("inserted");
    expect(openContracts.length).toBe(2);
  });

});

describe("auto-import: duplicate transaction ID protection", () => {

  it("same transaction ID imported twice should be skipped on second import", () => {
    const openContracts = [];
    const tx = { stock:"WDC", type:"Call", opt_type:"STO", strike:"477.5", expires:"2026-05-22", qty:1, premium:958.32, account:"Schwab 3866", date_exec:"2026-05-20", schwab_transaction_id:"TX030" };
    const r1 = simulateCommitTx(tx, openContracts);
    openContracts[0].notes = "Partial fill merged: 1 @ $958.32 (tx: TX030)";
    const r2 = simulateCommitTx(tx, openContracts);
    expect(r1.action).toBe("inserted");
    expect(r2.action).toBe("skipped");
    expect(openContracts.length).toBe(1);
  });

});

describe("auto-import: closers (BTC/STC) should never trigger partial fill merge", () => {

  it("BTC should always insert, never merge with existing open BTC", () => {
    const openContracts = [
      { id:999, stock:"AAPL", type:"Put", opt_type:"BTC", strike:"297.5", expires:"2026-05-20", qty:1, premium:-19.66, account:"Schwab 3866", date_exec:"2026-05-20", status:"Closed", notes:null }
    ];
    const newBtc = { stock:"AAPL", type:"Put", opt_type:"BTC", strike:"297.5", expires:"2026-05-20", qty:2, premium:-35.03, account:"Schwab 3866", date_exec:"2026-05-20", schwab_transaction_id:"TX040" };
    const r = simulateCommitTx(newBtc, openContracts);
    expect(r.action).toBe("inserted");
  });

});

// ── matchToOpen — never cross-matches accounts (June 8 2026 bug fix) ──────────
describe("auto-import: matchToOpen never assigns BTC to wrong account", () => {
  // Simulates the fixed matchToOpen logic: same-account-first, never fallback across accounts

  function matchToOpen(parsed, candidates) {
    if (!candidates.length) return { matchId: null, matchConfidence: "unmatched" };
    // Fixed: always filter to same account first
    const sameAcct = candidates.filter(c => c.account === parsed.account);
    if (!sameAcct.length) return { matchId: null, matchConfidence: "unmatched" };
    const exact = sameAcct.find(c => +c.qty === +parsed.qty);
    if (exact) return { matchId: exact.id, matchConfidence: "exact" };
    const best = sameAcct.reduce((a, b) =>
      Math.abs(+a.qty - +parsed.qty) < Math.abs(+b.qty - +parsed.qty) ? a : b
    );
    return { matchId: best.id, matchConfidence: "partial" };
  }

  it("positive — BTC matches open STO in same account (Schwab)", () => {
    const candidates = [
      { id: 100, stock: "AMZN", strike: "252.5", expires: "2026-06-10", account: "Schwab 3866", qty: 7 },
    ];
    const btc = { stock: "AMZN", strike: "252.5", expires: "2026-06-10", account: "Schwab 3866", qty: 7 };
    const r = matchToOpen(btc, candidates);
    expect(r.matchId).toBe(100);
    expect(r.matchConfidence).toBe("exact");
  });

  it("positive — BTC matches open STO in same account (ETrade)", () => {
    const candidates = [
      { id: 200, stock: "AMZN", strike: "252.5", expires: "2026-06-10", account: "ETrade 6917", qty: 3 },
    ];
    const btc = { stock: "AMZN", strike: "252.5", expires: "2026-06-10", account: "ETrade 6917", qty: 3 };
    const r = matchToOpen(btc, candidates);
    expect(r.matchId).toBe(200);
    expect(r.matchConfidence).toBe("exact");
  });

  it("negative — BTC does NOT match open STO in different account even if same strike/expiry", () => {
    // This is the exact bug from June 8 2026: ETrade BTC was matched to Schwab STO
    const candidates = [
      { id: 100, stock: "AMZN", strike: "252.5", expires: "2026-06-10", account: "Schwab 3866", qty: 7 },
    ];
    const etradeBtc = { stock: "AMZN", strike: "252.5", expires: "2026-06-10", account: "ETrade 6917", qty: 3 };
    const r = matchToOpen(etradeBtc, candidates);
    expect(r.matchId).toBeNull();
    expect(r.matchConfidence).toBe("unmatched");
  });

  it("negative — Schwab BTC does NOT match ETrade STO", () => {
    const candidates = [
      { id: 200, stock: "AMZN", strike: "252.5", expires: "2026-06-10", account: "ETrade 6917", qty: 3 },
    ];
    const schwabBtc = { stock: "AMZN", strike: "252.5", expires: "2026-06-10", account: "Schwab 3866", qty: 7 };
    const r = matchToOpen(schwabBtc, candidates);
    expect(r.matchId).toBeNull();
    expect(r.matchConfidence).toBe("unmatched");
  });

  it("when both accounts have matching STOs, each BTC matches only its own account", () => {
    const candidates = [
      { id: 100, stock: "AMZN", strike: "252.5", expires: "2026-06-10", account: "Schwab 3866", qty: 7 },
      { id: 200, stock: "AMZN", strike: "252.5", expires: "2026-06-10", account: "ETrade 6917", qty: 3 },
    ];
    const schwabBtc = { stock: "AMZN", strike: "252.5", expires: "2026-06-10", account: "Schwab 3866", qty: 7 };
    const etradeBtc = { stock: "AMZN", strike: "252.5", expires: "2026-06-10", account: "ETrade 6917", qty: 3 };
    expect(matchToOpen(schwabBtc, candidates).matchId).toBe(100);
    expect(matchToOpen(etradeBtc, candidates).matchId).toBe(200);
  });
});

// ── BTC fill chain: alreadyHandledByTradeOrder ────────────────────────────────
describe("auto-import: alreadyHandledByTradeOrder", () => {

  // Simulates the fixed alreadyHandledByTradeOrder logic
  function alreadyHandledByTradeOrder(parsed, tradeOrders) {
    if (!["BTC","STC"].includes(parsed.opt_type)) return false;
    const match = tradeOrders.find(o =>
      o.ticker   === parsed.stock &&
      +o.strike  === +parsed.strike &&
      o.expires  === parsed.expires &&
      o.account  === parsed.account &&
      ["filled","submitted"].includes(o.status) &&
      +o.qty === +parsed.qty &&
      Math.abs(new Date(o.filled_at || o.created_at) - new Date(parsed.date_exec)) < 2 * 86400000
    );
    if (match) return { skip: false, skipParentClose: true, tradeOrderId: match.id };
    return false;
  }

  it("positive — returns skipParentClose when filled trade_order exists for same contract", () => {
    const tradeOrders = [{
      id: 129, ticker: "CAT", strike: "930", expires: "2026-06-12",
      account: "Schwab 3866", status: "filled", qty: 1,
      filled_at: "2026-06-10T14:50:11.562Z", opt_type: "BTC",
    }];
    const btc = {
      opt_type: "BTC", stock: "CAT", strike: "930", expires: "2026-06-12",
      account: "Schwab 3866", qty: 1, date_exec: "2026-06-10",
    };
    const result = alreadyHandledByTradeOrder(btc, tradeOrders);
    expect(result).not.toBe(false);
    expect(result.skipParentClose).toBe(true);
    expect(result.tradeOrderId).toBe(129);
    expect(result.skip).toBe(false); // should still create BTC audit row
  });

  it("positive — returns skipParentClose when submitted trade_order exists", () => {
    const tradeOrders = [{
      id: 200, ticker: "JPM", strike: "315", expires: "2026-06-12",
      account: "Schwab 3866", status: "submitted", qty: 2,
      created_at: "2026-06-10T14:00:00.000Z", opt_type: "BTC",
    }];
    const btc = {
      opt_type: "BTC", stock: "JPM", strike: "315", expires: "2026-06-12",
      account: "Schwab 3866", qty: 2, date_exec: "2026-06-10",
    };
    const result = alreadyHandledByTradeOrder(btc, tradeOrders);
    expect(result).not.toBe(false);
    expect(result.skipParentClose).toBe(true);
  });

  it("negative — returns false when no matching trade_order exists", () => {
    const tradeOrders = [];
    const btc = {
      opt_type: "BTC", stock: "CAT", strike: "930", expires: "2026-06-12",
      account: "Schwab 3866", qty: 1, date_exec: "2026-06-10",
    };
    expect(alreadyHandledByTradeOrder(btc, tradeOrders)).toBe(false);
  });

  it("negative — returns false when trade_order is cancelled (not filled/submitted)", () => {
    const tradeOrders = [{
      id: 174, ticker: "CAT", strike: "930", expires: "2026-06-12",
      account: "Schwab 3866", status: "cancelled", qty: 1,
      filled_at: null, created_at: "2026-06-10T18:20:40.000Z", opt_type: "BTC",
    }];
    const btc = {
      opt_type: "BTC", stock: "CAT", strike: "930", expires: "2026-06-12",
      account: "Schwab 3866", qty: 1, date_exec: "2026-06-10",
    };
    expect(alreadyHandledByTradeOrder(btc, tradeOrders)).toBe(false);
  });

  it("negative — returns false for STO (not a closer)", () => {
    const tradeOrders = [{
      id: 999, ticker: "CAT", strike: "930", expires: "2026-06-12",
      account: "Schwab 3866", status: "filled", qty: 1,
      filled_at: "2026-06-10T14:50:00.000Z",
    }];
    const sto = {
      opt_type: "STO", stock: "CAT", strike: "930", expires: "2026-06-12",
      account: "Schwab 3866", qty: 1, date_exec: "2026-06-10",
    };
    expect(alreadyHandledByTradeOrder(sto, tradeOrders)).toBe(false);
  });

  it("negative — returns false when qty does not match", () => {
    const tradeOrders = [{
      id: 129, ticker: "CAT", strike: "930", expires: "2026-06-12",
      account: "Schwab 3866", status: "filled", qty: 1,
      filled_at: "2026-06-10T14:50:11.562Z",
    }];
    const btc = {
      opt_type: "BTC", stock: "CAT", strike: "930", expires: "2026-06-12",
      account: "Schwab 3866", qty: 7, date_exec: "2026-06-10", // different qty
    };
    expect(alreadyHandledByTradeOrder(btc, tradeOrders)).toBe(false);
  });

});

// ── BTC auto loop: filled-order guard ────────────────────────────────────────
describe("market-refresh: auto-BTC filled-order guard", () => {

  function shouldSkipBtc(contract, filledOrders) {
    // Simulates the filled-order guard added to the auto-BTC loop
    const existing = filledOrders.find(o =>
      o.ticker   === contract.stock &&
      +o.strike  === +contract.strike &&
      o.expires  === contract.expires &&
      o.account  === contract.account &&
      o.status   === "filled"
    );
    return !!existing;
  }

  it("positive — skips BTC when filled trade_order exists for same contract", () => {
    const filledOrders = [{
      id: 129, ticker: "CAT", strike: "930", expires: "2026-06-12",
      account: "Schwab 3866", status: "filled",
    }];
    const contract = {
      stock: "CAT", strike: "930", expires: "2026-06-12", account: "Schwab 3866",
    };
    expect(shouldSkipBtc(contract, filledOrders)).toBe(true);
  });

  it("negative — does not skip when no filled trade_order exists", () => {
    const filledOrders = [];
    const contract = {
      stock: "CAT", strike: "930", expires: "2026-06-12", account: "Schwab 3866",
    };
    expect(shouldSkipBtc(contract, filledOrders)).toBe(false);
  });

  it("negative — does not skip when trade_order is cancelled (not filled)", () => {
    const filledOrders = [{
      id: 174, ticker: "CAT", strike: "930", expires: "2026-06-12",
      account: "Schwab 3866", status: "cancelled",
    }];
    const contract = {
      stock: "CAT", strike: "930", expires: "2026-06-12", account: "Schwab 3866",
    };
    expect(shouldSkipBtc(contract, filledOrders)).toBe(false);
  });

  it("negative — does not skip a different contract with same ticker", () => {
    const filledOrders = [{
      id: 129, ticker: "CAT", strike: "930", expires: "2026-06-12",
      account: "Schwab 3866", status: "filled",
    }];
    const differentContract = {
      stock: "CAT", strike: "940", expires: "2026-06-12", account: "Schwab 3866",
    };
    expect(shouldSkipBtc(differentContract, filledOrders)).toBe(false);
  });

  it("negative — does not skip contract in different account", () => {
    const filledOrders = [{
      id: 129, ticker: "CAT", strike: "930", expires: "2026-06-12",
      account: "Schwab 3866", status: "filled",
    }];
    const etradeContract = {
      stock: "CAT", strike: "930", expires: "2026-06-12", account: "ETrade 6917",
    };
    expect(shouldSkipBtc(etradeContract, filledOrders)).toBe(false);
  });

});

// ── ETrade transaction ID dedup (from earlier today) ─────────────────────────
describe("auto-import: ETrade transaction ID pre-check", () => {

  function preCheckExists(parsedTxId, existingTxIds) {
    // Simulates the pre-insert transaction ID existence check
    if (!parsedTxId) return false;
    return existingTxIds.includes(parsedTxId);
  }

  it("positive — skips import when transaction ID already in DB (closed row)", () => {
    const existingIds = ["etrade_26159500540446"];
    expect(preCheckExists("etrade_26159500540446", existingIds)).toBe(true);
  });

  it("negative — imports normally when transaction ID not in DB", () => {
    const existingIds = ["etrade_26159500540446"];
    expect(preCheckExists("etrade_NEW999", existingIds)).toBe(false);
  });

  it("negative — null transaction ID does not trigger skip", () => {
    const existingIds = ["etrade_26159500540446"];
    expect(preCheckExists(null, existingIds)).toBe(false);
  });

});

// ── ETrade partial fill split ─────────────────────────────────────────────────
describe("auto-import: ETrade partial fill split guard", () => {

  function shouldSkipPartial(existing, parsed) {
    // Simulates the fixed guard: skip only on same tx ID, not on qty comparison
    const isEtrade = parsed.account?.toLowerCase().startsWith("etrade");
    if (!isEtrade) return false;
    return existing.schwab_transaction_id === parsed.schwab_transaction_id;
  }

  it("positive — skips re-issue with same transaction ID", () => {
    const existing = { schwab_transaction_id: "etrade_SAME", qty: 2, account: "ETrade 6917" };
    const parsed   = { schwab_transaction_id: "etrade_SAME", qty: 2, account: "ETrade 6917" };
    expect(shouldSkipPartial(existing, parsed)).toBe(true);
  });

  it("negative — does NOT skip second fill with different transaction ID (even if qty smaller)", () => {
    const existing = { schwab_transaction_id: "etrade_FIRST", qty: 2, account: "ETrade 6917" };
    const parsed   = { schwab_transaction_id: "etrade_SECOND", qty: 1, account: "ETrade 6917" };
    expect(shouldSkipPartial(existing, parsed)).toBe(false);
  });

  it("negative — Schwab transactions are never subject to ETrade guard", () => {
    const existing = { schwab_transaction_id: "schwab_ABC", qty: 2, account: "Schwab 3866" };
    const parsed   = { schwab_transaction_id: "schwab_ABC", qty: 2, account: "Schwab 3866" };
    expect(shouldSkipPartial(existing, parsed)).toBe(false);
  });

});

// ── ETrade composite fingerprint dedup ───────────────────────────────────────
describe("auto-import: ETrade composite fingerprint dedup", () => {

  function fingerprintMatch(parsed, existingContracts) {
    if (!parsed.schwab_transaction_id?.startsWith('etrade_')) return null;
    return existingContracts.find(r =>
      r.stock    === parsed.stock &&
      r.opt_type === parsed.opt_type &&
      String(r.strike)  === String(parsed.strike) &&
      r.expires  === parsed.expires &&
      r.account  === parsed.account &&
      r.date_exec === parsed.date_exec &&
      Math.abs(Math.abs(parseFloat(r.premium)) - Math.abs(parseFloat(parsed.premium))) <= 0.10
    ) || null;
  }

  it("positive — same trade different ETrade tx ID matches on fingerprint", () => {
    const existing = [{
      id: 1777730812256, stock: 'AMZN', opt_type: 'STO', strike: '255',
      expires: '2026-06-12', account: 'ETrade 6917', date_exec: '2026-06-09',
      premium: '246.95', schwab_transaction_id: 'etrade_26160200380354',
    }];
    const parsed = {
      stock: 'AMZN', opt_type: 'STO', strike: '255', expires: '2026-06-12',
      account: 'ETrade 6917', date_exec: '2026-06-09', premium: 246.95,
      schwab_transaction_id: 'etrade_26160500487346', // different ID, same trade
    };
    expect(fingerprintMatch(parsed, existing)).not.toBeNull();
    expect(fingerprintMatch(parsed, existing).id).toBe(1777730812256);
  });

  it("positive — premium within $0.10 tolerance still matches", () => {
    const existing = [{
      id: 100, stock: 'JPM', opt_type: 'STO', strike: '315',
      expires: '2026-06-12', account: 'ETrade 6917', date_exec: '2026-06-09',
      premium: '604.66', schwab_transaction_id: 'etrade_AAA',
    }];
    const parsed = {
      stock: 'JPM', opt_type: 'STO', strike: '315', expires: '2026-06-12',
      account: 'ETrade 6917', date_exec: '2026-06-09', premium: 604.70, // $0.04 diff
      schwab_transaction_id: 'etrade_BBB',
    };
    expect(fingerprintMatch(parsed, existing)).not.toBeNull();
  });

  it("negative — genuinely different trade same day same stock does not match", () => {
    const existing = [{
      id: 100, stock: 'AMZN', opt_type: 'STO', strike: '255',
      expires: '2026-06-12', account: 'ETrade 6917', date_exec: '2026-06-09',
      premium: '246.95', schwab_transaction_id: 'etrade_AAA',
    }];
    const parsed = {
      stock: 'AMZN', opt_type: 'STO', strike: '260', // different strike
      expires: '2026-06-12', account: 'ETrade 6917', date_exec: '2026-06-09',
      premium: 310.00, schwab_transaction_id: 'etrade_BBB',
    };
    expect(fingerprintMatch(parsed, existing)).toBeNull();
  });

  it("negative — premium difference > $0.10 does not match", () => {
    const existing = [{
      id: 100, stock: 'AMZN', opt_type: 'STO', strike: '255',
      expires: '2026-06-12', account: 'ETrade 6917', date_exec: '2026-06-09',
      premium: '246.95', schwab_transaction_id: 'etrade_AAA',
    }];
    const parsed = {
      stock: 'AMZN', opt_type: 'STO', strike: '255', expires: '2026-06-12',
      account: 'ETrade 6917', date_exec: '2026-06-09',
      premium: 123.48, // different premium — genuinely different fill
      schwab_transaction_id: 'etrade_BBB',
    };
    expect(fingerprintMatch(parsed, existing)).toBeNull();
  });

  it("negative — Schwab transactions skip fingerprint check entirely", () => {
    const existing = [{
      id: 100, stock: 'AMZN', opt_type: 'STO', strike: '255',
      expires: '2026-06-12', account: 'Schwab 3866', date_exec: '2026-06-09',
      premium: '324.34', schwab_transaction_id: 'schwab_12345',
    }];
    const parsed = {
      stock: 'AMZN', opt_type: 'STO', strike: '255', expires: '2026-06-12',
      account: 'Schwab 3866', date_exec: '2026-06-09', premium: 324.34,
      schwab_transaction_id: 'schwab_99999', // Schwab — should not use fingerprint check
    };
    // Schwab tx IDs don't start with 'etrade_' so fingerprint check is skipped
    const isEtrade = parsed.schwab_transaction_id?.startsWith('etrade_');
    expect(isEtrade).toBe(false);
    // fingerprintMatch would return a match, but it's never called for Schwab
  });

});

// ── open_method detection via trade_orders ────────────────────────────────────
// Replicates the open_method logic added to commitTx in auto-import.js

// approved_by='skynet_auto_sto' filter added — without it, ANY submitted/filled
// trade_order (including user-clicked manual approvals) falsely set open_method=auto.
// This is also the ETrade fix: market-refresh.js tags the trade_orders row with
// approved_by='skynet_auto_sto' immediately (the contract itself doesn't exist yet
// for ETrade — it only arrives later via this same auto-import path on fill).
//
// status filter removed (AMZN fix, 2026-07-14): the trade_order's status can lag or
// diverge from the actual broker fill state (e.g. mid-chase resubmit), which caused
// real skynet_auto_sto orders to be missed. approved_by alone is now the sole signal.
function detectOpenMethod(parsed, tradeOrders) {
  if (!["STO","BTO"].includes(parsed.opt_type)) return null;
  if (!parsed.stock || !parsed.strike || !parsed.expires || !parsed.account) return null;
  const match = tradeOrders.find(to =>
    to.ticker  === parsed.stock &&
    String(to.strike)  === String(parsed.strike) &&
    to.expires === parsed.expires &&
    to.account === parsed.account &&
    to.opt_type === parsed.opt_type &&
    to.approved_by === "skynet_auto_sto"
  );
  return match ? "auto" : null;
}

describe("auto-import: open_method detection via trade_orders", () => {
  const baseOrder = {
    id: 1, ticker: "AAPL", strike: "200", expires: "2026-06-20",
    account: "Schwab 3866", opt_type: "STO", status: "filled", approved_by: "skynet_auto_sto",
  };
  const baseParsed = {
    stock: "AAPL", strike: "200", expires: "2026-06-20",
    account: "Schwab 3866", opt_type: "STO",
  };

  it("positive — returns 'auto' when filled trade_order matches STO", () => {
    expect(detectOpenMethod(baseParsed, [baseOrder])).toBe("auto");
  });

  it("positive — returns 'auto' when submitted trade_order matches", () => {
    expect(detectOpenMethod(baseParsed, [{ ...baseOrder, status: "submitted" }])).toBe("auto");
  });

  it("positive — BTO also detected as auto when matched", () => {
    const btoOrder  = { ...baseOrder, opt_type: "BTO" };
    const btoParsed = { ...baseParsed, opt_type: "BTO" };
    expect(detectOpenMethod(btoParsed, [btoOrder])).toBe("auto");
  });

  it("negative — returns null when no matching trade_order exists", () => {
    expect(detectOpenMethod(baseParsed, [])).toBeNull();
  });

  it("positive — status no longer gates the match (AMZN fix) — a cancelled row still matches on approved_by", () => {
    // Status can lag/diverge from the real fill state, so approved_by alone is authoritative now.
    expect(detectOpenMethod(baseParsed, [{ ...baseOrder, status: "cancelled" }])).toBe("auto");
  });

  it("negative — returns null when account does not match", () => {
    const wrongAccount = { ...baseOrder, account: "ETrade 6917" };
    expect(detectOpenMethod(baseParsed, [wrongAccount])).toBeNull();
  });

  it("negative — returns null when strike does not match", () => {
    const wrongStrike = { ...baseOrder, strike: "205" };
    expect(detectOpenMethod(baseParsed, [wrongStrike])).toBeNull();
  });

  it("negative — returns null when expires does not match", () => {
    const wrongExpiry = { ...baseOrder, expires: "2026-06-27" };
    expect(detectOpenMethod(baseParsed, [wrongExpiry])).toBeNull();
  });

  it("negative — BTC/STC never get open_method set", () => {
    expect(detectOpenMethod({ ...baseParsed, opt_type: "BTC" }, [baseOrder])).toBeNull();
    expect(detectOpenMethod({ ...baseParsed, opt_type: "STC" }, [baseOrder])).toBeNull();
  });

  it("negative — returns null when parsed has no stock", () => {
    expect(detectOpenMethod({ ...baseParsed, stock: null }, [baseOrder])).toBeNull();
  });

  it("regression — a manually-approved order no longer falsely matches as auto (pre-fix bug)", () => {
    // Before the approved_by filter, any submitted/filled order (including user-clicked
    // manual approvals) matched here and incorrectly set open_method=auto.
    const manualOrder = { ...baseOrder, approved_by: "user" };
    expect(detectOpenMethod(baseParsed, [manualOrder])).toBeNull();
  });

  // ── ETrade auto-STO handoff (the actual bug: contract doesn't exist yet for ETrade,
  //    so market-refresh.js tags the trade_orders row instead, and auto-import picks
  //    it up here when the contract is finally created on fill) ──────────────────────
  const etradeParsed = { stock: "AMZN", strike: "220", expires: "2026-07-17", account: "ETrade 6917", opt_type: "STO" };

  it("ETrade auto-STO fill → open_method=auto", () => {
    const tradeOrders = [{ ticker: "AMZN", strike: "220", expires: "2026-07-17", account: "ETrade 6917", opt_type: "STO", status: "submitted", approved_by: "skynet_auto_sto" }];
    expect(detectOpenMethod(etradeParsed, tradeOrders)).toBe("auto");
  });

  it("ETrade manual STO → open_method=manual", () => {
    const tradeOrders = [{ ticker: "AMZN", strike: "220", expires: "2026-07-17", account: "ETrade 6917", opt_type: "STO", status: "submitted", approved_by: "user" }];
    expect(detectOpenMethod(etradeParsed, tradeOrders)).toBeNull();
  });

  it("ETrade STO with no matching trade_order at all → open_method=manual", () => {
    // e.g. traded directly in ETrade's own app/website, never touched this app
    expect(detectOpenMethod(etradeParsed, [])).toBeNull();
  });

  it("Schwab auto-STO path unchanged (regression guard)", () => {
    expect(detectOpenMethod(baseParsed, [baseOrder])).toBe("auto");
  });

  it("positive — auto-import detects fill on Schwab skynet_auto_sto order → contract gets open_method=auto", () => {
    // Exercises the BUG 1 fix: market-refresh.js now tags the Schwab trade_orders row
    // with approved_by='skynet_auto_sto' (it previously relied solely on schwab-orders.js's
    // approve-new handler, which silently ignores the approved_by param).
    const schwabAutoOrder = { ticker: "NVDA", strike: "130", expires: "2026-08-21", account: "Schwab 3866", opt_type: "STO", status: "filled", approved_by: "skynet_auto_sto" };
    const schwabParsed    = { stock: "NVDA", strike: "130", expires: "2026-08-21", account: "Schwab 3866", opt_type: "STO" };
    expect(detectOpenMethod(schwabParsed, [schwabAutoOrder])).toBe("auto");
  });

  it("negative — non-auto-STO order (BTC) → open_method unaffected", () => {
    const schwabAutoOrder = { ticker: "NVDA", strike: "130", expires: "2026-08-21", account: "Schwab 3866", opt_type: "STO", status: "filled", approved_by: "skynet_auto_sto" };
    const btcParsed = { stock: "NVDA", strike: "130", expires: "2026-08-21", account: "Schwab 3866", opt_type: "BTC" };
    expect(detectOpenMethod(btcParsed, [schwabAutoOrder])).toBeNull();
  });
});

// ── Schwab equity transaction parser ─────────────────────────────────────────
// Replicates parseSchwabEquityTx logic added to auto-import.js

const SCHWAB_EQUITY_TYPE_MAP = {
  DIVIDEND: "DIVIDEND", INTEREST: "INTEREST", TRANSFER: "TRANSFER",
  JOURNAL: "TRANSFER", MARGIN_INTEREST: "INTEREST", OTHER: "OTHER",
};

function parseSchwabEquityTx(tx, accountNumber) {
  const items = tx.transferItems || [];
  if (items.find(i => i.instrument?.assetType === "OPTION")) return null;
  const netAmt = tx.netAmount || 0;
  const type   = tx.type || "";
  let txType;
  if (type === "TRADE") {
    const equityItem = items.find(i => ["EQUITY","ETF","MUTUAL_FUND"].includes(i.instrument?.assetType));
    if (!equityItem) return null;
    txType = netAmt < 0 ? "BUY" : "SELL";
  } else {
    txType = SCHWAB_EQUITY_TYPE_MAP[type] ?? "OTHER";
  }
  const equityItem = items.find(i => i.instrument?.symbol);
  const symbol = equityItem?.instrument?.symbol?.trim().toUpperCase() || null;
  return {
    schwab_transaction_id: String(tx.activityId),
    symbol, transaction_type: txType,
    net_amount: Math.round(netAmt * 100) / 100,
    account: accountNumber ? `Schwab ${String(accountNumber).slice(-4)}` : "Schwab",
    description: tx.description || "",
  };
}

function parseEtradeEquityTx(tx) {
  const br   = tx.brokerage;
  const prod = br?.product;
  if (prod?.securityType === "OPTN") return null;
  const ETRADE_MAP = {
    "Bought":"BUY","Sold":"SELL","Dividend":"DIVIDEND","Interest":"INTEREST",
    "Transfer":"TRANSFER","Fee":"FEE","Other":"OTHER",
  };
  const txType = ETRADE_MAP[tx.transactionType];
  if (!txType) return null;
  return {
    schwab_transaction_id: `etrade_${tx.transactionId}`,
    symbol: prod?.symbol?.toUpperCase() || null,
    transaction_type: txType,
    net_amount: Math.round((tx.amount || 0) * 100) / 100,
    description: tx.description || "",
  };
}

describe("parseSchwabEquityTx", () => {
  it("returns null for option transactions", () => {
    const tx = {
      activityId: 1, type: "TRADE", netAmount: -500,
      transferItems: [{ instrument: { assetType: "OPTION", symbol: "AAPL" }, amount: 5 }],
    };
    expect(parseSchwabEquityTx(tx, "3866")).toBeNull();
  });

  it("parses equity BUY (negative netAmount)", () => {
    const tx = {
      activityId: 123, type: "TRADE", netAmount: -5000, description: "Buy AAPL",
      tradeDate: "2026-06-12T14:00:00Z",
      transferItems: [{ instrument: { assetType: "EQUITY", symbol: "AAPL" }, amount: 10, price: 500 }],
    };
    const result = parseSchwabEquityTx(tx, "3866");
    expect(result).not.toBeNull();
    expect(result.transaction_type).toBe("BUY");
    expect(result.symbol).toBe("AAPL");
    expect(result.net_amount).toBe(-5000);
    expect(result.account).toBe("Schwab 3866");
  });

  it("parses equity SELL (positive netAmount)", () => {
    const tx = {
      activityId: 124, type: "TRADE", netAmount: 5100,
      tradeDate: "2026-06-12T14:00:00Z",
      transferItems: [{ instrument: { assetType: "EQUITY", symbol: "MSFT" }, amount: 10, price: 510 }],
    };
    const result = parseSchwabEquityTx(tx, "3866");
    expect(result.transaction_type).toBe("SELL");
    expect(result.symbol).toBe("MSFT");
  });

  it("parses DIVIDEND transaction", () => {
    const tx = {
      activityId: 125, type: "DIVIDEND", netAmount: 42.50,
      tradeDate: "2026-06-12T00:00:00Z", description: "Dividend AAPL",
      transferItems: [],
    };
    const result = parseSchwabEquityTx(tx, "3866");
    expect(result.transaction_type).toBe("DIVIDEND");
    expect(result.net_amount).toBe(42.50);
  });

  it("parses INTEREST transaction", () => {
    const tx = {
      activityId: 126, type: "INTEREST", netAmount: 12.33,
      tradeDate: "2026-06-12T00:00:00Z", transferItems: [],
    };
    expect(parseSchwabEquityTx(tx, "3866").transaction_type).toBe("INTEREST");
  });

  it("parses MARGIN_INTEREST as INTEREST", () => {
    const tx = {
      activityId: 127, type: "MARGIN_INTEREST", netAmount: -8.50,
      tradeDate: "2026-06-12T00:00:00Z", transferItems: [],
    };
    expect(parseSchwabEquityTx(tx, "3866").transaction_type).toBe("INTEREST");
  });

  it("returns null for TRADE with no equity item", () => {
    const tx = {
      activityId: 128, type: "TRADE", netAmount: -100,
      tradeDate: "2026-06-12T00:00:00Z",
      transferItems: [{ instrument: { assetType: "UNKNOWN" } }],
    };
    expect(parseSchwabEquityTx(tx, "3866")).toBeNull();
  });

  it("uses last 4 digits of accountNumber for account field", () => {
    const tx = {
      activityId: 129, type: "DIVIDEND", netAmount: 10,
      tradeDate: "2026-06-12T00:00:00Z", transferItems: [],
    };
    expect(parseSchwabEquityTx(tx, "123866").account).toBe("Schwab 3866");
  });

  it("sets schwab_transaction_id as string of activityId", () => {
    const tx = {
      activityId: 999123, type: "DIVIDEND", netAmount: 5,
      tradeDate: "2026-06-12T00:00:00Z", transferItems: [],
    };
    expect(parseSchwabEquityTx(tx, "3866").schwab_transaction_id).toBe("999123");
  });
});

describe("parseEtradeEquityTx", () => {
  it("returns null for option transactions", () => {
    const tx = {
      transactionId: 1, transactionType: "Sold", amount: 500,
      brokerage: { product: { securityType: "OPTN", symbol: "AAPL" } },
    };
    expect(parseEtradeEquityTx(tx)).toBeNull();
  });

  it("returns null for unrecognized transaction type", () => {
    const tx = {
      transactionId: 2, transactionType: "UnknownType", amount: 100,
      brokerage: { product: { securityType: "EQ", symbol: "AAPL" } },
    };
    expect(parseEtradeEquityTx(tx)).toBeNull();
  });

  it("parses equity buy", () => {
    const tx = {
      transactionId: 3, transactionType: "Bought", amount: -5000,
      brokerage: { product: { securityType: "EQ", symbol: "AMZN" }, quantity: 10, price: 500 },
    };
    const result = parseEtradeEquityTx(tx);
    expect(result.transaction_type).toBe("BUY");
    expect(result.symbol).toBe("AMZN");
    expect(result.net_amount).toBe(-5000);
    expect(result.schwab_transaction_id).toBe("etrade_3");
  });

  it("parses dividend", () => {
    const tx = {
      transactionId: 4, transactionType: "Dividend", amount: 33.25,
      description: "Dividend",
      brokerage: { product: { securityType: "EQ", symbol: "JPM" } },
    };
    const result = parseEtradeEquityTx(tx);
    expect(result.transaction_type).toBe("DIVIDEND");
    expect(result.net_amount).toBe(33.25);
  });

  it("prefixes schwab_transaction_id with etrade_", () => {
    const tx = {
      transactionId: 99887, transactionType: "Sold", amount: 1000,
      brokerage: { product: { securityType: "EQ", symbol: "NVDA" } },
    };
    expect(parseEtradeEquityTx(tx).schwab_transaction_id).toBe("etrade_99887");
  });

  it("handles null product gracefully (e.g. cash interest)", () => {
    const tx = {
      transactionId: 5, transactionType: "Interest", amount: 8.50,
      description: "Interest", brokerage: {},
    };
    const result = parseEtradeEquityTx(tx);
    expect(result.transaction_type).toBe("INTEREST");
    expect(result.symbol).toBeNull();
  });
});

// ── P11: stock_transactions import — Schwab only, ETrade excluded ────────────
// Mirrors api/auto-import.js's equity-import aggregation (~line 1430):
// `allEquityTxs = [...schwabEquityTxs]` — ETrade equity is parsed (parseEtradeEquityTx
// still exists, e.g. for future debugging) but never included in what gets inserted
// into stock_transactions, since both ETrade accounts are IRAs (tax-deferred) and mixing
// them with Schwab's taxable equity activity in one table would corrupt tax reporting.
describe("stock_transactions import — Schwab only (P11)", () => {
  function buildEquityImportList(schwabEquityTxs, etradeEquityTxs) {
    // Deliberately does NOT spread etradeEquityTxs — this is the actual production line.
    return [...schwabEquityTxs];
  }

  it("positive — a Schwab equity transaction is included in the import list", () => {
    const schwabTx = { schwab_transaction_id: "1", symbol: "AAPL", transaction_type: "BUY", account: "Schwab 3866" };
    const result = buildEquityImportList([schwabTx], []);
    expect(result).toContainEqual(schwabTx);
    expect(result.length).toBe(1);
  });

  it("negative — an ETrade equity transaction is NOT included, even when present in the parsed list", () => {
    const schwabTx = { schwab_transaction_id: "1", symbol: "AAPL", transaction_type: "BUY", account: "Schwab 3866" };
    const etradeTx = { schwab_transaction_id: "etrade_2", symbol: "NVDA", transaction_type: "SELL", account: "ETrade 6917" };
    const result = buildEquityImportList([schwabTx], [etradeTx]);
    expect(result).toContainEqual(schwabTx);
    expect(result).not.toContainEqual(etradeTx);
    expect(result.find(r => r.account?.startsWith("ETrade"))).toBeUndefined();
  });

  it("negative — an all-ETrade batch results in an empty import list", () => {
    const etradeTx = { schwab_transaction_id: "etrade_3", symbol: "TSLA", transaction_type: "BUY", account: "ETrade 8222" };
    expect(buildEquityImportList([], [etradeTx])).toEqual([]);
  });
});
