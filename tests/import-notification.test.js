// tests/import-notification.test.js
// Auto-import's "committed" Pushover notification used to report just a count
// ("N transactions auto-committed") — now it lists the actual imported records
// (symbol, strike, call/put, qty, account, open/close), capped so a big batch
// doesn't blow up the Pushover message body. Display only — no import/matching
// logic changed. formatCommittedLine/MAX_LISTED_TX are local consts inside the
// handler (not exported), so the message-building logic is hand-mirrored here,
// matching this repo's convention for embedded, non-exported logic (see
// tests/auto-import.test.js's simulateCommitTx). Source-guard tests pin the
// real implementation. Run: npx vitest run tests/import-notification.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const autoImportSrc = fs.readFileSync(path.resolve("api/auto-import.js"), "utf8");

const MAX_LISTED_TX = 10;

function formatCommittedLine(t) {
  const isOpen = ["STO","BTO"].includes(t.opt_type);
  return `${isOpen ? "📤" : "✅"} ${t.stock} $${t.strike} ${t.type} x${t.qty} (${t.account}) — ${isOpen ? "open" : "close"}`;
}

// Mirrors the msg-building block in the "Push notification for committed" section
function buildCommittedMsg(committed, totalProfit) {
  const closes = committed.filter(t => ["BTC","STC"].includes(t.opt_type));
  let msg = `${committed.length} transaction${committed.length > 1 ? "s" : ""} auto-committed.`;
  msg += "\n" + committed.slice(0, MAX_LISTED_TX).map(formatCommittedLine).join("\n");
  if (committed.length > MAX_LISTED_TX) {
    msg += `\n…and ${committed.length - MAX_LISTED_TX} more`;
  }
  if (closes.length && totalProfit !== 0) {
    msg += `\n${totalProfit >= 0 ? "💰" : "📉"} Net P&L: ${totalProfit >= 0 ? "+" : ""}$${totalProfit.toFixed(2)}`;
  }
  return msg;
}

const makeTx = (over = {}) => ({
  stock: "AAPL", strike: 150, type: "Call", opt_type: "STO",
  qty: 2, account: "Schwab 1234", ...over,
});

describe("formatCommittedLine", () => {
  it("positive — an open (STO) formats with the open badge and 📤 icon", () => {
    expect(formatCommittedLine(makeTx({ opt_type: "STO" })))
      .toBe("📤 AAPL $150 Call x2 (Schwab 1234) — open");
  });

  it("positive — a close (BTC) formats with the close badge and ✅ icon", () => {
    expect(formatCommittedLine(makeTx({ opt_type: "BTC", type: "Put", strike: 300, qty: 1, account: "ETrade 5678" })))
      .toBe("✅ AAPL $300 Put x1 (ETrade 5678) — close");
  });

  it("edge — EXPIRED and ASSIGNED (neither STO nor BTO) are treated as closes", () => {
    expect(formatCommittedLine(makeTx({ opt_type: "EXPIRED" }))).toContain("— close");
    expect(formatCommittedLine(makeTx({ opt_type: "ASSIGNED" }))).toContain("— close");
  });
});

describe("buildCommittedMsg — notification body lists actual records", () => {
  it("positive — 3 contracts imported lists all 3 with full details", () => {
    const committed = [
      makeTx({ stock: "AAPL", strike: 150, type: "Call", opt_type: "STO", qty: 2, account: "Schwab 1234" }),
      makeTx({ stock: "MSFT", strike: 300, type: "Put",  opt_type: "BTC", qty: 1, account: "ETrade 5678" }),
      makeTx({ stock: "TSLA", strike: 200, type: "Put",  opt_type: "BTO", qty: 1, account: "Schwab 1234" }),
    ];
    const msg = buildCommittedMsg(committed, 0);
    expect(msg).toContain("3 transactions auto-committed.");
    expect(msg).toContain("📤 AAPL $150 Call x2 (Schwab 1234) — open");
    expect(msg).toContain("✅ MSFT $300 Put x1 (ETrade 5678) — close");
    expect(msg).toContain("📤 TSLA $200 Put x1 (Schwab 1234) — open");
    expect(msg).not.toContain("…and");
  });

  it("edge — 20 imported shows the first 10 records plus an overflow count", () => {
    const committed = Array.from({ length: 20 }, (_, i) =>
      makeTx({ stock: `SYM${i}`, opt_type: i % 2 === 0 ? "STO" : "BTC" })
    );
    const msg = buildCommittedMsg(committed, 0);
    const lines = msg.split("\n");
    // header + 10 listed records + overflow line
    expect(lines.length).toBe(12);
    expect(msg).toContain("SYM0");
    expect(msg).toContain("SYM9");
    expect(msg).not.toContain("SYM10");
    expect(msg).toContain("…and 10 more");
  });

  it("positive — includes the Net P&L line when there are closes with nonzero profit", () => {
    const committed = [makeTx({ opt_type: "BTC" })];
    const msg = buildCommittedMsg(committed, 125.5);
    expect(msg).toContain("💰 Net P&L: +$125.50");
  });

  it("negative — no Net P&L line when there are no closes", () => {
    const committed = [makeTx({ opt_type: "STO" })];
    const msg = buildCommittedMsg(committed, 0);
    expect(msg).not.toContain("Net P&L");
  });
});

describe("api/auto-import.js — committed notification wiring", () => {
  it("only sends the committed-notification when there's something to report (unchanged gate)", () => {
    expect(autoImportSrc).toContain("if (committed.length) {");
  });

  it("no longer reports a bare open/close count instead of the itemized list", () => {
    expect(autoImportSrc).not.toContain("open${opens.length > 1");
    expect(autoImportSrc).not.toContain("close${closes.length > 1");
  });

  it("builds the message from formatCommittedLine, capped at MAX_LISTED_TX", () => {
    expect(autoImportSrc).toContain("const MAX_LISTED_TX = 10;");
    expect(autoImportSrc).toContain("committed.slice(0, MAX_LISTED_TX).map(formatCommittedLine)");
    expect(autoImportSrc).toContain("…and ${committed.length - MAX_LISTED_TX} more");
  });

  it("formatCommittedLine includes symbol, strike, call/put, qty, account, and open/close", () => {
    const fnBlock = autoImportSrc.split("const formatCommittedLine")[1]?.split("};")[0] || "";
    expect(fnBlock).toContain("t.stock");
    expect(fnBlock).toContain("t.strike");
    expect(fnBlock).toContain("t.type");
    expect(fnBlock).toContain("t.qty");
    expect(fnBlock).toContain("t.account");
    expect(fnBlock).toContain('"open" : "close"');
  });

  it("import/matching logic (closes filter used for sound+title) is untouched", () => {
    expect(autoImportSrc).toContain('const closes = committed.filter(t => ["BTC","STC"].includes(t.opt_type));');
  });
});
