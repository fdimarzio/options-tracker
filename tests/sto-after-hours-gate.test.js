// tests/sto-after-hours-gate.test.js
// Regression for the STO-suggestion after-hours push bug: the "💡 STO Opportunity"
// Pushover was NOT inside the isMarketOpen gate, so it pushed suggestions built on
// stale quotes after the 4pm ET close (signal_log showed AMD at 13:25/14:25/15:25/
// 16:25 ET — only the first on a live quote). The auto-ORDER block below it is gated,
// so nothing traded off-hours; this was notification noise only.
//
// Runs the REAL api/market-refresh.js handler (not a reimplementation) against a mocked
// Schwab holding (INTC 200sh uncovered, up 1.5%) with an enabled STO rule, and asserts:
//   - market OPEN (Tue 2pm ET)  -> the STO-suggestion push fires (positive control)
//   - market CLOSED (Tue 5pm ET, after 4pm close) -> NO STO-suggestion push
//   - weekend (Sat 2pm ET)      -> NO STO-suggestion push
// global.fetch is fully stubbed; no live network calls.
// Run: npx vitest run tests/sto-after-hours-gate.test.js

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const STO_RULE = {
  id: 1, rule_type: "sto", enabled: true, dry_run: true, priority: 10,
  min_change_pct: 0.5, min_premium: 50, min_dte: 1, max_dte: 14,
  min_otm_pct: 1, max_otm_pct: 10, min_time_et: "09:00",
};

const CHAIN_EXPIRY = "2026-09-08";
const CHAIN_DATA = {
  [`INTC|${CHAIN_EXPIRY}`]: {
    calls: [{ strikePrice: 36, bid: 1.00, ask: 1.10, mark: 1.05, delta: 0.3, volatility: 28, totalVolume: 500, openInterest: 1000 }],
    puts: [],
  },
};

function makeRes(body, opts = {}) {
  return {
    ok: opts.ok !== false, status: opts.status ?? 200,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: () => null },
  };
}

let calls;
async function fetchRouter(url, init = {}) {
  const method = (init && init.method) || "GET";
  let body = null;
  try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
  calls.push({ url: String(url), method, body });

  if (url.includes("/col_prefs?select=cols&id=eq.schwab_tokens"))
    return makeRes([{ cols: { accessToken: "fake-access-token", accessTokenExpiresAt: Date.now() + 3600000 } }]);
  if (url.includes("/trader/v1/accounts/accountNumbers"))
    return makeRes([{ accountNumber: "12343866", hashValue: "HASH1" }]);
  if (url.includes("/trader/v1/accounts/HASH1") && url.includes("fields=positions"))
    return makeRes({ securitiesAccount: { positions: [{ instrument: { assetType: "EQUITY", symbol: "INTC" }, longQuantity: 200 }] } });
  if (url.includes("/api/etrade") && url.includes("action=positions"))
    return makeRes({ positions: [] });
  if (url.includes("/rest/v1/contracts") && url.includes("status=eq.Open"))
    return makeRes([]);
  if (url.includes("/col_prefs?select=cols&id=eq.stocks_data")) return makeRes([]);
  if (url.includes("/signal_rules?enabled=eq.true")) return makeRes([STO_RULE]);
  if (url.includes("/col_prefs?select=cols&id=eq.last_chain_refresh"))
    return makeRes([{ cols: { chains: CHAIN_DATA } }]);
  if (url.includes("/col_prefs?select=cols&id=eq.notifications_sent")) return makeRes([]);
  if (url.includes("/col_prefs?select=cols&id=eq.watchlist")) return makeRes([]);
  if (url.includes("/marketdata/v1/quotes") && url.includes("symbols=INTC"))
    return makeRes({ INTC: { quote: {
      lastPrice: 35, netPercentChange: 1.5, bidPrice: 34.9, askPrice: 35.1,
      highPrice: 35.5, lowPrice: 34, openPrice: 34.5, totalVolume: 1000000,
    } } });
  if (url.includes("/rest/v1/signal_log")) return makeRes([{ id: 999 }]);
  if (url.includes("pushover")) return makeRes({ status: 1 });
  if (url.includes("/api/schwab-orders")) return makeRes({ ok: false, error: "TEST: not expected" });
  return method === "GET" ? makeRes([]) : makeRes({});
}

async function runHandlerAt(iso, handler) {
  calls = [];
  vi.setSystemTime(new Date(iso));
  vi.stubGlobal("fetch", vi.fn(fetchRouter));
  const req = { method: "GET", query: { force: "1" }, headers: {} };
  const res = { setHeader: () => {}, status() { return this; }, json() { return this; }, end() { return this; } };
  await handler(req, res);
}

// The STO-suggestion push — distinct from the "[DRY RUN] Auto-STO" order push below it.
function stoSuggestionPushes() {
  return calls.filter(c => c.url.includes("pushover") && /STO Opportunity/.test(c.body?.title || ""));
}

describe("STO suggestion push — market-hours / weekday gate", () => {
  let handler;

  beforeAll(async () => {
    process.env.VITE_SUPABASE_URL = "https://fake-project.supabase.co";
    process.env.VITE_SUPABASE_ANON_KEY = "fake-anon-key";
    process.env.SUPABASE_SERVICE_KEY = "fake-service-key";
    process.env.PUSHOVER_API_TOKEN = "fake-pushover-token";
    process.env.PUSHOVER_USER_KEY = "fake-pushover-user";
    delete process.env.CRON_SECRET;
    ({ default: handler } = await import("../api/market-refresh.js"));
  });

  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
  afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("positive control — during market hours on a weekday (Tue 2pm ET), the STO suggestion IS pushed", async () => {
    await runHandlerAt("2026-09-01T18:00:00Z", handler); // Tue 14:00 ET
    expect(stoSuggestionPushes().length, "expected an STO-suggestion push during market hours").toBeGreaterThan(0);
  });

  it("after-hours (Tue 5pm ET, past the 4pm close) — NO STO-suggestion push", async () => {
    await runHandlerAt("2026-09-01T21:00:00Z", handler); // Tue 17:00 ET → isMarketOpen false
    const pushes = stoSuggestionPushes();
    expect(pushes, `expected no STO-suggestion push after close, got: ${JSON.stringify(pushes.map(p => p.body?.title))}`).toHaveLength(0);
    // And it's recorded as suppressed (pushed:false) rather than silently vanishing.
    const suppressed = calls.filter(c => c.url.includes("/rest/v1/signal_log") && c.method === "POST"
      && c.body?.signal_type === "sto_suggestion" && c.body?.pushed === false);
    expect(suppressed.length).toBeGreaterThan(0);
  });

  it("weekend (Sat 2pm ET) — NO STO-suggestion push even though it's within the clock window", async () => {
    await runHandlerAt("2026-09-05T18:00:00Z", handler); // Sat 14:00 ET
    expect(stoSuggestionPushes()).toHaveLength(0);
  });
});
