// Unauthorized-access tests: every /api handler must reject anonymous callers and
// enforce roles. Handlers are imported for real; only network fetch is stubbed.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const CRON = "unit-test-cron-secret";
const LEGACY_SECRET = "legacy-hardcoded-secret"; // stands in for the retired shared secret
const TOKENS = {
  viewer: { id: "u-viewer", row: { id: "v", name: "V", role: "viewer" } },
  trader: { id: "u-trader", row: { id: "t", name: "T", role: "trader" } },
  admin:  { id: "u-admin",  row: { id: "a", name: "A", role: "admin" } },
  stranger: { id: "u-stranger", row: null },        // valid Supabase user, not on the allow-list
  unconfirmed: { id: "u-unconf", row: { id: "x", role: "admin" }, unconfirmed: true },
};

let handlers = {};
let realFetch;
const proxyCalls = [];

function stubFetch() {
  return vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/auth/v1/user")) {
      const tok = (opts.headers?.Authorization || "").replace("Bearer ", "");
      const t = TOKENS[tok];
      if (!t) return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ id: t.id, email: `${tok}@example.com`, email_confirmed_at: t.unconfirmed ? null : "2026-01-01" }) };
    }
    if (u.includes("/rest/v1/app_users")) {
      const id = decodeURIComponent(u.match(/auth_user_id=eq\.([^&]+)/)?.[1] || "");
      const t = Object.values(TOKENS).find((x) => x.id === id);
      return { ok: true, status: 200, json: async () => (t?.row ? [t.row] : []) };
    }
    proxyCalls.push(u);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => "{}" };
  });
}

function makeRes() {
  const r = { statusCode: 200, body: undefined, headers: {} };
  const chain = new Proxy(r, {
    get(t, p) {
      if (p === "then" || typeof p === "symbol") return undefined;
      if (p in t) return t[p];
      if (p === "status") return (c) => { t.statusCode = c; return chain; };
      if (p === "json") return (b) => { t.body = b; return chain; };
      if (p === "setHeader") return (k, v) => { t.headers[k] = v; return chain; };
      return () => chain; // end, send, redirect, writeHead, ...
    },
  });
  return chain;
}

const req = (over = {}) => ({ method: "GET", query: {}, headers: {}, body: {}, ...over });
const bearer = (who) => ({ authorization: `Bearer ${who}` });
const run = async (name, request) => { const res = makeRes(); await handlers[name](request, res).catch(() => {}); return res.statusCode; };

beforeAll(async () => {
  process.env.VITE_SUPABASE_URL = "https://x.supabase.co";
  process.env.VITE_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_KEY = "svc";
  process.env.CRON_SECRET = CRON;
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.ETRADE_CONSUMER_KEY = "k";
  process.env.ETRADE_CONSUMER_SECRET = "s";
  realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch();
  for (const n of ["claude", "schwab-proxy", "schwab-orders", "etrade", "chase-step", "market-refresh", "auto-import", "chain-refresh", "oi-tracker", "dani-simulate", "schwab-auth"]) {
    handlers[n] = (await import(`../api/${n}.js`)).default;
  }
});
afterAll(() => { globalThis.fetch = realFetch; });

const PROTECTED = [
  ["claude POST", "claude", { method: "POST", body: { mode: "chat", messages: [] } }],
  ["schwab-proxy quotes", "schwab-proxy", { query: { path: "/marketdata/v1/quotes", symbols: "AAPL" } }],
  ["schwab-orders list", "schwab-orders", { query: { action: "list" } }],
  ["schwab-orders place", "schwab-orders", { method: "POST", query: { action: "approve-new" }, body: {} }],
  ["schwab-orders cancel", "schwab-orders", { method: "POST", query: { action: "cancel" }, body: {} }],
  ["etrade positions", "etrade", { query: { action: "positions" } }],
  ["etrade import dryRun (previously unauthenticated)", "etrade", { query: { action: "import", dryRun: "1" } }],
  ["etrade proxy", "etrade", { query: { action: "proxy", path: "/v1/accounts/list" } }],
  ["chase-step", "chase-step", {}],
  ["market-refresh", "market-refresh", {}],
  ["auto-import", "auto-import", {}],
  ["chain-refresh", "chain-refresh", {}],
  ["oi-tracker", "oi-tracker", {}],
  ["dani-simulate", "dani-simulate", {}],
  ["schwab-auth refresh", "schwab-auth", { query: { action: "refresh" } }],
  ["schwab-auth status", "schwab-auth", { query: { action: "status" } }],
];

describe("anonymous callers are rejected everywhere", () => {
  for (const [label, name, over] of PROTECTED) {
    it(`401: ${label}`, async () => expect(await run(name, req(over))).toBe(401));
  }
  it("401: garbage bearer token", async () => expect(await run("schwab-orders", req({ query: { action: "list" }, headers: bearer("nope") }))).toBe(401));
  it("401: the old hard-coded secret no longer works", async () => {
    expect(await run("schwab-orders", req({ query: { action: "list", secret: LEGACY_SECRET } }))).toBe(401);
    expect(await run("etrade", req({ query: { action: "positions", secret: LEGACY_SECRET } }))).toBe(401);
  });
  it("401: authenticated Supabase user who is NOT on the allow-list", async () =>
    expect(await run("schwab-orders", req({ query: { action: "list" }, headers: bearer("stranger") }))).toBe(401));
  it("401: allow-listed but email unconfirmed", async () =>
    expect(await run("schwab-orders", req({ query: { action: "list" }, headers: bearer("unconfirmed") }))).toBe(401));
  it("fails CLOSED when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    expect(await run("market-refresh", req({ query: { secret: "" } }))).toBe(401);
    expect(await run("schwab-orders", req({ query: { action: "list", secret: "undefined" } }))).toBe(401);
    process.env.CRON_SECRET = CRON;
  });
});

describe("service callers (cron secret) still work", () => {
  it("header secret is accepted", async () => {
    const code = await run("schwab-orders", req({ query: { action: "list" }, headers: { "x-cron-secret": CRON } }));
    expect([401, 403]).not.toContain(code);
  });
  it("query secret is accepted (server-to-server calls use it)", async () => {
    const code = await run("etrade", req({ query: { action: "positions", secret: CRON } }));
    expect([401, 403]).not.toContain(code);
  });
  it("cron-only endpoints reject a signed-in admin's user token", async () => {
    for (const n of ["market-refresh", "auto-import", "chain-refresh", "oi-tracker", "dani-simulate"]) {
      expect(await run(n, req({ headers: bearer("admin") })), n).toBe(401);
    }
  });
});

describe("role enforcement", () => {
  it("viewer may read orders/status/quotes", async () => {
    expect([401, 403]).not.toContain(await run("schwab-orders", req({ query: { action: "list" }, headers: bearer("viewer") })));
    expect([401, 403]).not.toContain(await run("schwab-proxy", req({ query: { path: "/marketdata/v1/quotes", symbols: "AAPL" }, headers: bearer("viewer") })));
    expect([401, 403]).not.toContain(await run("etrade", req({ query: { action: "positions" }, headers: bearer("viewer") })));
  });
  it("viewer is FORBIDDEN from placing/cancelling orders, AI calls, and chase control", async () => {
    expect(await run("schwab-orders", req({ method: "POST", query: { action: "approve-new" }, headers: bearer("viewer") }))).toBe(403);
    expect(await run("schwab-orders", req({ method: "POST", query: { action: "cancel" }, headers: bearer("viewer") }))).toBe(403);
    expect(await run("schwab-orders", req({ method: "POST", query: { action: "chase-start" }, headers: bearer("viewer") }))).toBe(403);
    expect(await run("claude", req({ method: "POST", headers: bearer("viewer") }))).toBe(403);
    expect(await run("chase-step", req({ headers: bearer("viewer") }))).toBe(403);
    expect(await run("etrade", req({ query: { action: "proxy", path: "/v1/accounts/list" }, headers: bearer("viewer") }))).toBe(403);
  });
  it("a GET-shaped action name cannot downgrade a mutating call (method matters)", async () => {
    expect(await run("schwab-orders", req({ method: "POST", query: { action: "list" }, headers: bearer("viewer") }))).toBe(403);
  });
  it("trader and admin pass authorization", async () => {
    for (const who of ["trader", "admin"]) {
      expect([401, 403], who).not.toContain(await run("schwab-orders", req({ method: "POST", query: { action: "cancel" }, headers: bearer(who) })));
      expect([401, 403], who).not.toContain(await run("claude", req({ method: "POST", headers: bearer(who) })));
    }
  });
});

describe("schwab-proxy is market-data only", () => {
  const paths = ["/trader/v1/accounts", "/trader/v1/accounts/ABC/orders", "/v1/oauth/token", "/marketdata/v1/../../trader/v1/accounts", "//evil.example.net/x", "/marketdata/v1/quotes?x=1&y=2", "marketdata/v1/quotes"];
  for (const p of paths) {
    it(`403 for ${p}`, async () => {
      expect(await run("schwab-proxy", req({ query: { path: p }, headers: { "x-cron-secret": CRON } }))).toBe(403);
    });
  }
  it("200-class for real market-data paths", async () => {
    for (const p of ["/marketdata/v1/quotes", "/marketdata/v1/chains", "/marketdata/v1/pricehistory", "/marketdata/v1/expirationchain"]) {
      expect([401, 403], p).not.toContain(await run("schwab-proxy", req({ query: { path: p, symbols: "AAPL" }, headers: bearer("viewer") })));
    }
  });
  it("never forwards caller-supplied secrets to Schwab", async () => {
    proxyCalls.length = 0;
    await run("schwab-proxy", req({ query: { path: "/marketdata/v1/quotes", symbols: "AAPL", secret: CRON, "x-cron-secret": CRON }, headers: bearer("viewer") }));
    for (const u of proxyCalls) expect(u).not.toContain(CRON);
  });
});

describe("OAuth hand-off stays reachable (cannot carry headers)", () => {
  it("etrade action=auth and callback are not blocked by authorize()", async () => {
    for (const action of ["auth", "callback"]) {
      expect([401, 403], action).not.toContain(await run("etrade", req({ query: { action } })));
    }
  });
});
