// tests/watchdog-heartbeats.test.js
// Watchdog Phase 2a — proves the three newly-instrumented jobs each emit an
// ecosystem_heartbeat on their happy path with the correct agent_name, and that
// watchdog.js actually watches those agents. Each handler test runs the REAL
// handler (api/chain-refresh.js, api/chase-step.js, api/etrade.js) against a
// URL-routed global.fetch mock — no live network calls — following the style of
// tests/auto-sto-dry-run.test.js. The upsert must be idempotent on agent_name
// (see tests/market-refresh-idempotency.test.js for why on_conflict matters).
//
// Run: npx vitest run tests/watchdog-heartbeats.test.js

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";

function makeRes(body, opts = {}) {
  return {
    ok: opts.ok !== false,
    status: opts.status ?? 200,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: () => null },
  };
}

// Minimal Express-style res double capturing status + json body.
function makeResSpy() {
  const out = { statusCode: null, jsonBody: null };
  const res = {
    setHeader: () => {},
    status(code) { out.statusCode = code; return this; },
    json(body) { out.jsonBody = body; return this; },
    send(body) { out.jsonBody = body; return this; },
    end() { return this; },
  };
  return { res, out };
}

let calls;
function heartbeatUpserts(agent) {
  return calls.filter(c =>
    c.url.includes("/rest/v1/ecosystem_heartbeat") &&
    c.method === "POST" &&
    c.body?.agent_name === agent
  );
}

beforeEach(() => {
  calls = [];
  process.env.VITE_SUPABASE_URL = "https://fake-project.supabase.co";
  process.env.VITE_SUPABASE_ANON_KEY = "fake-anon-key";
  process.env.SUPABASE_SERVICE_KEY = "fake-service-key";
  delete process.env.CRON_SECRET; // no secret configured → auth check skipped
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── chain-refresh: "no open contracts" happy path writes an ok heartbeat ───────
describe("chain-refresh heartbeat", () => {
  async function router(url, init = {}) {
    const method = (init && init.method) || "GET";
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
    calls.push({ url: String(url), method, body });

    if (url.includes("/col_prefs?select=cols&id=eq.schwab_tokens")) {
      return makeRes([{ cols: { accessToken: "fake-access-token", accessTokenExpiresAt: Date.now() + 3600000 } }]);
    }
    if (url.includes("/rest/v1/contracts") && url.includes("status=eq.Open")) return makeRes([]);
    if (url.includes("/col_prefs?select=cols&id=eq.stocks_data")) return makeRes([]);
    if (url.includes("/col_prefs?select=cols&id=eq.watchlist")) return makeRes([]);
    return method === "GET" ? makeRes([]) : makeRes({});
  }

  it("writes an ok heartbeat with agent_name 'chain-refresh' and returns 200 when there are no open contracts", async () => {
    vi.stubGlobal("fetch", vi.fn(router));
    const { default: handler } = await import("../api/chain-refresh.js");
    const { res, out } = makeResSpy();

    await handler({ method: "GET", query: {}, headers: {} }, res);

    expect(out.statusCode).toBe(200);
    const hb = heartbeatUpserts("chain-refresh");
    expect(hb.length, "expected an ecosystem_heartbeat upsert for chain-refresh").toBeGreaterThan(0);
    expect(hb[0].body.status).toBe("ok");
    expect(hb[0].url).toContain("on_conflict=agent_name");
  });
});

// ── chase: main success (processed 0) happy path writes an ok heartbeat ─────────
describe("chase heartbeat", () => {
  async function router(url, init = {}) {
    const method = (init && init.method) || "GET";
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
    calls.push({ url: String(url), method, body });

    if (url.includes("/signal_rules?rule_type=eq.chase")) return makeRes([{ enabled: true, dry_run: true, chase_params: {} }]);
    if (url.includes("/skynet_controls")) return makeRes([{ master_enabled: true }]);
    if (url.includes("/rest/v1/trade_orders") && url.includes("chase_status=eq.active")) return makeRes([]);
    if (url.includes("/col_prefs?select=cols&id=eq.stocks_data")) return makeRes([{ cols: {} }]);
    return method === "GET" ? makeRes([]) : makeRes({});
  }

  it("writes an ok heartbeat with agent_name 'chase' and returns 200 with processed 0 when there are no active orders", async () => {
    // Tue 2026-09-01 14:00 ET — inside market hours so the RTH gate passes.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T18:00:00Z"));
    vi.stubGlobal("fetch", vi.fn(router));
    const { default: handler } = await import("../api/chase-step.js");
    const { res, out } = makeResSpy();

    await handler({ method: "GET", query: {}, headers: {} }, res);

    expect(out.statusCode).toBe(200);
    expect(out.jsonBody?.processed).toBe(0);
    const hb = heartbeatUpserts("chase");
    expect(hb.length, "expected an ecosystem_heartbeat upsert for chase").toBeGreaterThan(0);
    expect(hb[0].body.status).toBe("ok");
    expect(hb[0].url).toContain("on_conflict=agent_name");
  });
});

// ── extend-etrade-token: action=renew success writes an ok heartbeat ────────────
describe("extend-etrade-token heartbeat", () => {
  async function router(url, init = {}) {
    const method = (init && init.method) || "GET";
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
    calls.push({ url: String(url), method, body });

    if (url.includes("/col_prefs?select=cols&id=eq.etrade_tokens")) {
      // savedAt = now → same-day, so renew proceeds to the ETrade renew endpoint
      return makeRes([{ cols: { accessToken: "at", accessTokenSecret: "ats", savedAt: new Date().toISOString() } }]);
    }
    if (url.includes("/oauth/renew_access_token")) return makeRes("Access Token has been renewed");
    return method === "GET" ? makeRes([]) : makeRes({});
  }

  it("writes an ok heartbeat with agent_name 'extend-etrade-token' and returns 200 on a successful renew", async () => {
    process.env.ETRADE_CONSUMER_KEY = "ck";
    process.env.ETRADE_CONSUMER_SECRET = "cs";
    vi.stubGlobal("fetch", vi.fn(router));
    const { default: handler } = await import("../api/etrade.js");
    const { res, out } = makeResSpy();

    await handler({ method: "GET", query: { action: "renew" }, headers: {} }, res);

    expect(out.statusCode).toBe(200);
    const hb = heartbeatUpserts("extend-etrade-token");
    expect(hb.length, "expected an ecosystem_heartbeat upsert for extend-etrade-token").toBeGreaterThan(0);
    expect(hb[0].body.status).toBe("ok");
    expect(hb[0].url).toContain("on_conflict=agent_name");
  });
});

// ── watchdog.js watches the three newly-instrumented agents ────────────────────
describe("watchdog CHECKS cover the Phase 2a agents", () => {
  const src = fs.readFileSync(path.resolve("scripts/watchdog.js"), "utf8");
  it.each(["chain-refresh", "chase", "extend-etrade-token"])(
    "has a heartbeatFresh check for %s",
    (agent) => {
      expect(src).toContain(`heartbeatFresh("${agent}"`);
    }
  );
});
