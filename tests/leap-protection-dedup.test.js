// tests/leap-protection-dedup.test.js
// Proves the LEAP-protection Pushover fix in api/market-refresh.js's auto-BTC
// scanner (PAM e7b6a4bc): the "🔒 LEAP ... held for LTCG, not closed" alert was
// firing on every 5-min scan for the same held LEAP with no dedup. Runs the REAL
// handler — not a reimplementation — against a mocked LEAP contract (WDC, 400
// origDte, >=85% profit) twice in the same calendar day and confirms the second
// scan does not re-alert, while a separate non-LEAP contract hitting the
// unrelated CLOSE_NOW notification path still alerts normally (unaffected by
// this change). No live network calls are made — global.fetch is fully stubbed.
//
// Run: npx vitest run tests/leap-protection-dedup.test.js

import { describe, it, expect, beforeAll, afterEach, beforeEach, vi } from "vitest";

const NOW_ISO = "2026-09-01T18:00:00Z"; // Tue 2pm ET — within market hours
const TODAY   = "2026-09-01";

// ── LEAP contract: WDC $870 Call, opened at 400 DTE (>=365 → LEAP), deep profit ──
const WDC_CONTRACT = {
  id: 501, stock: "WDC", type: "Call", opt_type: "STO", strike: 870,
  expires: "2027-06-17", premium: 5000, qty: 1, account: "Schwab 3866",
  status: "Open", date_exec: "2026-01-01", entry_dte: 400,
  stop_loss_multiplier: null, time_stop_dte: null, delta_stop: null, last_exit_alert_at: null,
};
// Live bid/ask on WDC's chain implies ~90% profit vs the $5000 premium received.
const WDC_LIVE_CHAIN = {
  callExpDateMap: { "2027-06-17:263": { "870.0": [{ bid: 4.90, ask: 5.10 }] } },
};

// ── Non-LEAP contract: AAPL $150 Call, expires TODAY, near-worthless → CLOSE_NOW
// via the separate evaluateSignal/chainData path (unrelated to btc_auto). ──────
const AAPL_CONTRACT = {
  id: 502, stock: "AAPL", type: "Call", opt_type: "STO", strike: 150,
  expires: TODAY, premium: 300, qty: 1, account: "Schwab 3866",
  status: "Open", date_exec: "2026-01-15", entry_dte: 14,
  stop_loss_multiplier: null, time_stop_dte: null, delta_stop: null, last_exit_alert_at: null,
};
const CHAIN_DATA = {
  [`AAPL|${TODAY}`]: { calls: [{ strikePrice: 150, ask: 0.05, bid: 0.02 }], puts: [] },
};

const BTC_AUTO_RULE = { id: 3, rule_type: "btc_auto", enabled: true, priority: 10, min_profit_pct: 70, dry_run: true, name: "btc_auto" };
const LEAP_PROTECT_RULE = { id: 2, rule_type: "protect_leaps_ltcg", enabled: true, dry_run: false };

function makeRes(body, opts = {}) {
  return {
    ok: opts.ok !== false,
    status: opts.status ?? 200,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: () => null },
  };
}

let calls;

// notificationsSentCols: the notifications_sent col_prefs row's `cols` value the
// mock GET should return — lets a test simulate "this already ran once today".
function makeFetchRouter({ notificationsSentCols }) {
  return async function fetchRouter(url, init = {}) {
    const method = (init && init.method) || "GET";
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
    calls.push({ url: String(url), method, body });

    if (url.includes("/col_prefs?select=cols&id=eq.schwab_tokens")) {
      return makeRes([{ cols: { accessToken: "fake-access-token", accessTokenExpiresAt: Date.now() + 3600000 } }]);
    }
    if (url.includes("/trader/v1/accounts/accountNumbers")) {
      return makeRes([{ accountNumber: "12343866", hashValue: "HASH1" }]);
    }
    if (url.includes("/trader/v1/accounts/HASH1") && url.includes("fields=positions")) {
      return makeRes({ securitiesAccount: { positions: [] } }); // no equity positions needed for this test
    }
    if (url.includes("/api/etrade") && url.includes("action=positions")) {
      return makeRes({ positions: [] });
    }

    // ── Two distinct contracts fetches — differ by exact select/filter clause ──
    // The btc_auto scanner re-fetches open STO Calls itself (opt_type=eq.STO) —
    // only WDC there, so AAPL is only ever reached via the evaluateSignal loop
    // over the general `contracts` fetch, keeping the two scenarios isolated.
    if (url.includes("/rest/v1/contracts") && url.includes("opt_type=eq.STO")) {
      return makeRes([WDC_CONTRACT]);
    }
    if (url.includes("/rest/v1/contracts") && url.includes("status=eq.Open")) {
      return makeRes([WDC_CONTRACT, AAPL_CONTRACT]);
    }

    if (url.includes("/col_prefs?select=cols&id=eq.stocks_data")) {
      return makeRes([]);
    }
    if (url.includes("/signal_rules?enabled=eq.true")) {
      return makeRes([BTC_AUTO_RULE]);
    }
    if (url.includes("/signal_rules?rule_type=eq.protect_leaps_ltcg")) {
      return makeRes([LEAP_PROTECT_RULE]);
    }
    if (url.includes("/col_prefs?select=cols&id=eq.last_chain_refresh")) {
      return makeRes([{ cols: { chains: CHAIN_DATA } }]); // AAPL only — WDC deliberately absent
    }
    if (url.includes("/col_prefs?select=cols&id=eq.notifications_sent")) {
      return makeRes(notificationsSentCols ? [{ cols: notificationsSentCols }] : []);
    }
    if (url.includes("/col_prefs?select=cols&id=eq.watchlist")) {
      return makeRes([]);
    }

    if (url.includes("/marketdata/v1/quotes") && url.includes("symbols=")) {
      return makeRes({
        WDC:  { quote: { lastPrice: 880, netPercentChange: 0.8, bidPrice: 879, askPrice: 881, highPrice: 885, lowPrice: 875, openPrice: 878, totalVolume: 500000 } },
        AAPL: { quote: { lastPrice: 149, netPercentChange: 0.3, bidPrice: 148.9, askPrice: 149.1, highPrice: 150, lowPrice: 148, openPrice: 148.5, totalVolume: 900000 } },
      });
    }
    // btc_auto's own live chain lookup for the WDC BTC price
    if (url.includes("/marketdata/v1/chains") && url.includes("symbol=WDC")) {
      return makeRes(WDC_LIVE_CHAIN);
    }

    if (url.includes("/rest/v1/signal_log")) {
      return makeRes([{ id: 777 }]);
    }
    if (url.includes("pushover")) {
      return makeRes({ status: 1 });
    }

    return method === "GET" ? makeRes([]) : makeRes({});
  };
}

describe("LEAP-protection alert dedup + unaffected CLOSE_NOW path", () => {
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

  beforeEach(() => {
    calls = [];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function runHandler(notificationsSentCols) {
    vi.stubGlobal("fetch", vi.fn(makeFetchRouter({ notificationsSentCols })));
    const req = { method: "GET", query: { force: "1" }, headers: {} };
    let statusCode = null;
    const res = {
      setHeader: () => {},
      status(code) { statusCode = code; return this; },
      json() { return this; },
      end() { return this; },
    };
    await handler(req, res);
    expect(statusCode).not.toBeNull();
  }

  function leapPushoverCalls() {
    return calls.filter(c => c.url.includes("pushover") && c.body?.title?.includes("🔒 LEAP WDC"));
  }
  function leapSignalLogCalls() {
    return calls.filter(c => c.url.includes("/rest/v1/signal_log") && c.method === "POST" && c.body?.signal_type === "leap_protection");
  }
  function closeNowPushoverCalls() {
    return calls.filter(c => c.url.includes("pushover") && c.body?.title?.includes("AAPL"));
  }

  it("first scan of the day: LEAP >=85% profit alerts once, logs signal_log, and persists the dedup key", async () => {
    await runHandler(undefined); // fresh day — no notifications_sent row yet

    expect(leapPushoverCalls(), `expected exactly one LEAP Pushover alert. Got: ${JSON.stringify(calls.filter(c=>c.url.includes("pushover")).map(c=>c.body?.title))}`).toHaveLength(1);
    expect(leapPushoverCalls()[0].body.title).toContain("held for LTCG");
    expect(leapPushoverCalls()[0].body.message).toContain("auto-BTC skipped to preserve long-term cap gains");

    expect(leapSignalLogCalls()).toHaveLength(1);
    expect(leapSignalLogCalls()[0].body).toMatchObject({ symbol: "WDC", contract_id: 501 });
    expect(leapSignalLogCalls()[0].body.profit_pct_at_signal).toBeGreaterThanOrEqual(85);

    // The dedup key must actually be persisted back to notifications_sent —
    // otherwise the next 5-min cycle re-fetches a stale blob and re-alerts.
    const notifSaves = calls.filter(c => c.url.includes("/col_prefs") && c.method === "POST" && c.body?.id === "notifications_sent");
    const savedWithLeapKey = notifSaves.find(c => c.body?.cols?.contracts?.["leap_protect|501"]);
    expect(savedWithLeapKey, `expected a notifications_sent save containing leap_protect|501. Saves: ${JSON.stringify(notifSaves.map(c=>c.body?.cols?.contracts))}`).toBeTruthy();
    expect(savedWithLeapKey.body.cols.contracts["leap_protect|501"].sentAt.slice(0, 10)).toBe(TODAY);
  });

  it("second scan same day (dedup key already persisted): does NOT re-alert or re-log", async () => {
    const persistedFromEarlierToday = {
      date: TODAY,
      contracts: { "leap_protect|501": { sentAt: `${TODAY}T14:00:00.000Z`, symbol: "WDC", account: "Schwab 3866" } },
    };
    await runHandler(persistedFromEarlierToday);

    expect(leapPushoverCalls(), `expected NO LEAP Pushover alert on the second same-day scan. Got: ${JSON.stringify(leapPushoverCalls().map(c=>c.body?.title))}`).toHaveLength(0);
    expect(leapSignalLogCalls()).toHaveLength(0);
  });

  it("a non-LEAP contract still fires its normal CLOSE_NOW alert — unaffected by the LEAP dedup change", async () => {
    await runHandler(undefined);

    expect(closeNowPushoverCalls(), `expected an AAPL close alert. Got: ${JSON.stringify(calls.filter(c=>c.url.includes("pushover")).map(c=>c.body?.title))}`).toHaveLength(1);
    expect(closeNowPushoverCalls()[0].body.title).toContain("HIGH PROFIT");

    const closeNowSignal = calls.find(c => c.url.includes("/rest/v1/signal_log") && c.method === "POST" && c.body?.signal_type === "close_now" && c.body?.symbol === "AAPL");
    expect(closeNowSignal).toBeTruthy();
  });
});
