// tests/auto-sto-dry-run.test.js
// Proves the Schwab auto-STO order path is safe to enable for the dynamic
// ticker universe merge (branch covered-call-assignment-chase-etrade-leaps-ui):
// runs the REAL api/market-refresh.js handler — not a reimplementation — against
// a mocked Schwab holding (INTC, 200sh, no existing coverage) with the "sto"
// signal_rules row forced to dry_run: true, and asserts that it
//   (a) builds a complete, valid STO order payload (ticker/strike/expiry/qty/
//       limit_price/account — everything schwab-orders.js needs to submit it), and
//   (b) logs sto_auto intent to signal_log,
//   while NEVER calling the live order endpoints (schwab-orders preview-new /
//   approve-new), which is the only thing that can place a real trade.
// No live network calls are made anywhere in this test — global.fetch is fully
// stubbed with a URL-routed mock.
//
// Run: npx vitest run tests/auto-sto-dry-run.test.js

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const NOW_ISO = "2026-09-01T18:00:00Z"; // Tue 2pm ET — within market hours, well past min_time_et

const STO_RULE = {
  id: 1,
  rule_type: "sto",
  enabled: true,
  dry_run: true, // ← the thing this test is forcing/proving
  priority: 10,
  min_change_pct: 0.5,
  min_premium: 50,
  min_dte: 1,
  max_dte: 14,
  min_otm_pct: 1,
  max_otm_pct: 10,
  min_time_et: "09:00",
};

const CHAIN_EXPIRY = "2026-09-08";
const CHAIN_DATA = {
  [`INTC|${CHAIN_EXPIRY}`]: {
    calls: [
      { strikePrice: 36, bid: 1.00, ask: 1.10, mark: 1.05, delta: 0.3, volatility: 28, totalVolume: 500, openInterest: 1000 },
    ],
    puts: [],
  },
};

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

async function fetchRouter(url, init = {}) {
  const method = (init && init.method) || "GET";
  let body = null;
  try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
  calls.push({ url: String(url), method, body });

  // ── Schwab: valid, non-expiring token — no refresh needed ──────────────────
  if (url.includes("/col_prefs?select=cols&id=eq.schwab_tokens")) {
    return makeRes([{ cols: { accessToken: "fake-access-token", accessTokenExpiresAt: Date.now() + 3600000 } }]);
  }

  // ── Schwab: one account, INTC 200sh, no other positions ─────────────────────
  if (url.includes("/trader/v1/accounts/accountNumbers")) {
    return makeRes([{ accountNumber: "12343866", hashValue: "HASH1" }]);
  }
  if (url.includes("/trader/v1/accounts/HASH1") && url.includes("fields=positions")) {
    return makeRes({ securitiesAccount: { positions: [
      { instrument: { assetType: "EQUITY", symbol: "INTC" }, longQuantity: 200 },
    ] } });
  }

  // ── ETrade: no positions ─────────────────────────────────────────────────────
  if (url.includes("/api/etrade") && url.includes("action=positions")) {
    return makeRes({ positions: [] });
  }

  // ── No open contracts — INTC is uncovered ────────────────────────────────────
  if (url.includes("/rest/v1/contracts") && url.includes("status=eq.Open")) {
    return makeRes([]);
  }

  // ── No pre-existing stocks_data blob — shares come entirely from live positions ─
  if (url.includes("/col_prefs?select=cols&id=eq.stocks_data")) {
    return makeRes([]);
  }

  // ── The forced-dry_run STO rule ──────────────────────────────────────────────
  if (url.includes("/signal_rules?enabled=eq.true")) {
    return makeRes([STO_RULE]);
  }

  // ── Chain data with one valid, in-range OTM call ─────────────────────────────
  if (url.includes("/col_prefs?select=cols&id=eq.last_chain_refresh")) {
    return makeRes([{ cols: { chains: CHAIN_DATA } }]);
  }

  if (url.includes("/col_prefs?select=cols&id=eq.notifications_sent")) {
    return makeRes([]);
  }
  if (url.includes("/col_prefs?select=cols&id=eq.watchlist")) {
    return makeRes([]);
  }

  // ── Live stock quote: up 1.5%, clears min_change_pct ─────────────────────────
  if (url.includes("/marketdata/v1/quotes") && url.includes("symbols=INTC")) {
    return makeRes({ INTC: { quote: {
      lastPrice: 35, netPercentChange: 1.5, bidPrice: 34.9, askPrice: 35.1,
      highPrice: 35.5, lowPrice: 34, openPrice: 34.5, totalVolume: 1000000,
    } } });
  }

  // ── signal_log insert — this is the "sto_auto intent logged" proof ──────────
  if (url.includes("/rest/v1/signal_log")) {
    return makeRes([{ id: 999 }]);
  }

  // ── Pushover — this is where the dry-run order payload gets surfaced ────────
  if (url.includes("pushover")) {
    return makeRes({ status: 1 });
  }

  // ── Anything under /api/schwab-orders would mean a LIVE order attempt ───────
  // (preview-new / approve-new). Should never be hit in dry_run — respond
  // harmlessly rather than throwing, so the assertion below is the one that fails.
  if (url.includes("/api/schwab-orders")) {
    return makeRes({ ok: false, error: "TEST HARNESS: schwab-orders should not be called in dry_run" });
  }

  // ── Generic fallback for everything else (heartbeats, iv_history, S/R,
  // scoring_factor_values, ticker_risk_config, earnings_dates, momentum config,
  // price_snapshots, etc.) — all are soft-fail / try-caught in market-refresh.js.
  return method === "GET" ? makeRes([]) : makeRes({});
}

describe("auto-STO scanner — Schwab dry-run order path", () => {
  let handler;

  beforeAll(async () => {
    process.env.VITE_SUPABASE_URL = "https://fake-project.supabase.co";
    process.env.VITE_SUPABASE_ANON_KEY = "fake-anon-key";
    process.env.SUPABASE_SERVICE_KEY = "fake-service-key";
    process.env.PUSHOVER_API_TOKEN = "fake-pushover-token"; // must be truthy so sendPushover actually fires
    process.env.PUSHOVER_USER_KEY = "fake-pushover-user";
    delete process.env.CRON_SECRET; // no secret configured → auth check is skipped

    ({ default: handler } = await import("../api/market-refresh.js"));
  });

  beforeEach(() => {
    calls = [];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW_ISO));
    vi.stubGlobal("fetch", vi.fn(fetchRouter));
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("builds a valid dry-run STO order and logs sto_auto intent, without ever calling the live Schwab order endpoints", async () => {
    const req = { method: "GET", query: { force: "1" }, headers: {} };
    let statusCode = null, jsonBody = null;
    const res = {
      setHeader: () => {},
      status(code) { statusCode = code; return this; },
      json(body) { jsonBody = body; return this; },
      end() { return this; },
    };

    await handler(req, res);

    // ── Sanity: handler actually ran and reached a response ────────────────────
    expect(statusCode).not.toBeNull();

    // ── (b) sto_auto intent was logged to signal_log ────────────────────────────
    const signalLogCalls = calls.filter(c => c.url.includes("/rest/v1/signal_log") && c.method === "POST");
    const autoStoSignal = signalLogCalls.find(c => c.body?.signal_type === "sto_auto" && c.body?.symbol === "INTC");
    expect(autoStoSignal, `expected a signal_log insert with signal_type:"sto_auto" for INTC. Got: ${JSON.stringify(signalLogCalls.map(c => c.body))}`).toBeTruthy();
    expect(autoStoSignal.body.account).toBe("Schwab 3866");
    expect(autoStoSignal.body.strike).toBe(36);
    expect(autoStoSignal.body.expires).toBe(CHAIN_EXPIRY);
    expect(autoStoSignal.body.suggested_qty).toBe(2); // floor(200sh / 100) = 2 uncovered contracts
    expect(autoStoSignal.body.rule_id).toBe(STO_RULE.id);

    // ── (a) a valid, complete order payload was built and surfaced via Pushover ─
    const pushoverCalls = calls.filter(c => c.url.includes("pushover"));
    const dryRunPush = pushoverCalls.find(c => c.body?.title?.includes("[DRY RUN] Auto-STO") && c.body?.title?.includes("INTC"));
    expect(dryRunPush, `expected a "[DRY RUN] Auto-STO" Pushover notification for INTC. Got titles: ${JSON.stringify(pushoverCalls.map(c => c.body?.title))}`).toBeTruthy();

    const jsonMatch = dryRunPush.body.message.match(/\{[\s\S]*\}/);
    expect(jsonMatch, "dry-run Pushover message should embed the full order JSON").toBeTruthy();
    const orderPayload = JSON.parse(jsonMatch[0]);

    expect(orderPayload).toMatchObject({
      ticker: "INTC",
      type: "Call",
      opt_type: "STO",
      strike: 36,
      expiry: CHAIN_EXPIRY,
      qty: 2,
      account: "Schwab 3866",
    });
    expect(orderPayload.limit_price).toBeGreaterThan(0);
    expect(orderPayload.dte).toBeGreaterThan(0);

    // These are exactly the fields buildOSI()/buildOrderPayload() in
    // api/schwab-orders.js need to construct a real Schwab order — proving this
    // is a genuinely placeable order, not a stub.
    for (const field of ["ticker", "type", "strike", "expiry", "qty", "limit_price", "account"]) {
      expect(orderPayload[field], `order payload missing "${field}"`).not.toBeUndefined();
    }

    // ── The critical safety assertion: no live order call was ever made ────────
    const liveOrderCalls = calls.filter(c =>
      c.url.includes("/api/schwab-orders") &&
      (c.url.includes("action=preview-new") || c.url.includes("action=approve-new"))
    );
    expect(liveOrderCalls, `no call to schwab-orders preview-new/approve-new should happen in dry_run. Got: ${JSON.stringify(liveOrderCalls.map(c => c.url))}`).toHaveLength(0);

    // Also confirm no order was ever approved with dry_run:false anywhere.
    const liveApprovals = calls.filter(c => c.body?.dry_run === false);
    expect(liveApprovals, `no approval with dry_run:false should occur. Got: ${JSON.stringify(liveApprovals)}`).toHaveLength(0);

    // And no trade_orders row was written with status "submitted".
    const submittedOrders = calls.filter(c => c.url.includes("/rest/v1/trade_orders") && c.body?.status === "submitted");
    expect(submittedOrders).toHaveLength(0);
  });
});
