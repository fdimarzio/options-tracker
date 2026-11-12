// tests/stocks-data-client-readonly.test.js
// P1 of the stocks_data integrity work: market-refresh (server cron) is the ONLY writer
// of market data in col_prefs 'stocks_data'. The browser's quote-polling and broker
// position-pull flows must update React state only. They used to upsert the tab's whole
// in-memory copy, so any stale tab reverted user settings and share counts on every
// refresh (see docs/STOCKS_DATA_OWNERSHIP.md).
//
// pri-tod-v3.jsx is a ~9k-line component that can't be imported under Vitest, so these
// slice the real source text of each function — the repo's source-guard convention.
// Run: npx vitest run tests/stocks-data-client-readonly.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const src = fs.readFileSync(path.resolve("src/pri-tod-v3.jsx"), "utf8");

function between(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  expect(s, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
  const e = src.indexOf(endMarker, s + startMarker.length);
  expect(e, `end marker not found: ${endMarker}`).toBeGreaterThan(s);
  return src.slice(s, e);
}

const applyQuotes = between("const applyQuotesToStocksData = useCallback", "// Main refresh:");
const refreshEtrade = between("const refreshEtrade = useCallback", "}, [etradeStatus, originals, contracts, stocksData, applyQuotesToStocksData]);");
const pollEffect = between("const pollRefresh = async", "const getInterval");

describe("applyQuotesToStocksData — state only", () => {
  it("negative — performs no database write of any kind", () => {
    expect(applyQuotes).not.toMatch(/supabase/);
    expect(applyQuotes).not.toMatch(/col_prefs/);
    expect(applyQuotes).not.toMatch(/upsert|\.insert\(|\.update\(/);
  });

  it("positive — still merges quote fields into React state", () => {
    expect(applyQuotes).toContain("setStocksData(prev =>");
    expect(applyQuotes).toContain("currentPrice: q.lastPrice");
    expect(applyQuotes).toContain("lastQuoteAt:  q.fetchedAt");
  });
});

describe("refreshEtrade (Schwab + ETrade position pulls) — state only for stocks_data", () => {
  it("negative — never references the stocks_data row", () => {
    expect(refreshEtrade).not.toContain('"stocks_data"');
    expect(refreshEtrade).not.toContain("'stocks_data'");
  });

  it("negative — the Schwab and ETrade setStocksData updaters do not upsert", () => {
    // every setStocksData(prev => {...}) updater block in the flow must be pure
    const updaters = refreshEtrade.split("setStocksData(prev =>").slice(1);
    expect(updaters.length).toBeGreaterThanOrEqual(2); // schwab + etrade pulls
    for (const u of updaters) {
      const body = u.slice(0, u.indexOf("return updated;"));
      expect(body).not.toMatch(/upsert|supabase/);
    }
  });

  it("positive — broker-derived cash is applied with persist:false (display only)", () => {
    expect(refreshEtrade).toContain('updateCash("schwab", accountValue.toFixed(2), { persist: false })');
    expect(refreshEtrade).toContain('updateCash("schwab", cash.toFixed(2), { persist: false })');
    expect(refreshEtrade).toContain('updateCash("etrade", etNAV.toFixed(2), { persist: false })');
  });

  it("negative — no updateCash call inside the refresh flow persists (every call opts out)", () => {
    // line-based: the args contain nested parens (toFixed(2)), so a paren regex would truncate
    const calls = refreshEtrade.split("\n").filter(l => /\bupdateCash\(/.test(l) && !l.trim().startsWith("//"));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) expect(c).toContain("persist: false");
  });
});

describe("market-refresh UI polling — read-only", () => {
  it("negative — pollRefresh only reads col_prefs; no write call in the polling effect", () => {
    expect(pollEffect).not.toMatch(/upsert|\.insert\(|\.update\(|\.delete\(/);
    expect(pollEffect).toContain('.select("cols")');
  });

  it("positive — it still hands fresh quotes to the (state-only) applyQuotesToStocksData", () => {
    expect(pollEffect).toContain("await applyQuotesToStocksData(freshQuotes)");
  });
});

describe("updateCash — persist opt-out", () => {
  const updateCash = between("const updateCash = async", "// AI Chat state");

  it("positive — broker-derived call (persist:false) returns before any database write", () => {
    const beforePersist = updateCash.split("if (!persist) return;")[0];
    expect(updateCash).toContain("if (!persist) return;");
    expect(beforePersist).not.toMatch(/supabase/);
  });

  it("positive — uses a functional state update (no stale closure copy of stocksData)", () => {
    expect(updateCash).toContain("setStocksData(prev =>");
  });
});
