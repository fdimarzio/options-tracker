// tests/etrade-balance-allowlist.test.js
// Regression test: one stray/empty ETrade account staled the whole ETrade snapshot side.
//
// Root cause: api/etrade.js action=balance iterated EVERY account ETrade lists. "ETrade 5707"
// (not a funded account — funded are 6917 + 8222) returns accountBalance = 0, which threw
// "no usable NAV field" → ok:false for that account → api/market-refresh.js saw failed.length
// and carried forward the whole ETrade side, discarding the good 6917 + 8222 numbers.
//
// Fix:
//   - action=balance only fetches/sums accounts in the ACCOUNT_NAMES allowlist; others are
//     returned in `ignored` and never count as a failure.
//   - an allowlisted account whose balance parses fine with NAV fields present and zero is a
//     real $0 (ok:true, value:0), not a failure. Real HTTP/parse failures still fail.
//
// Runs the REAL api/etrade.js handler and the REAL api/market-refresh.js snapshot writer
// (market-refresh's /api/etrade?action=balance call is routed into the real etrade handler).
//
// Run: npx vitest run tests/etrade-balance-allowlist.test.js

import { describe, it, expect, beforeAll, afterEach, beforeEach, vi } from "vitest";

const NOW_ISO = "2026-09-17T18:00:00Z"; // Thu 2pm ET — within market hours

function makeRes(body, opts = {}) {
  return {
    ok: opts.ok !== false,
    status: opts.status ?? 200,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: () => null },
  };
}

const ACCT_6917 = { accountId: "227156917", accountIdKey: "KEY6917" };
const ACCT_8222 = { accountId: "227418222", accountIdKey: "KEY8222" };
const ACCT_5707 = { accountId: "227005707", accountIdKey: "KEY5707" }; // stray, unfunded

let calls;
let scenario; // { accounts: [...], balances: { KEYxxxx: Computed | {status, body} }, portfolios: { KEYxxxx: [...] } }
let etradeHandler, marketRefreshHandler;

async function callHandler(handler, query) {
  let statusCode = null, jsonBody = null;
  const res = {
    setHeader: () => {},
    status(code) { statusCode = code; return this; },
    json(body) { jsonBody = body; return this; },
    send(body) { jsonBody = body; return this; },
    end() { return this; },
  };
  await handler({ method: "GET", query, headers: {} }, res);
  return { statusCode, jsonBody };
}

async function etradeRoutes(url) {
  if (url.includes("/col_prefs?select=cols&id=eq.etrade_tokens")) {
    return makeRes([{ cols: { accessToken: "tok", accessTokenSecret: "sec" } }]);
  }
  if (url.startsWith("https://api.etrade.com/v1/accounts/list")) {
    return makeRes({ AccountListResponse: { Accounts: { Account: scenario.accounts } } });
  }
  const bal = url.match(/api\.etrade\.com\/v1\/accounts\/(\w+)\/balance/);
  if (bal) {
    const b = scenario.balances[bal[1]];
    if (b?.status) return makeRes(b.body, { ok: false, status: b.status });
    return makeRes({ BalanceResponse: { Computed: b } });
  }
  const port = url.match(/api\.etrade\.com\/v1\/accounts\/(\w+)\/portfolio/);
  if (port) {
    return makeRes({ PortfolioResponse: { AccountPortfolio: [{ Position: scenario.portfolios?.[port[1]] || [] }] } });
  }
  return null;
}

async function fetchRouter(url, init = {}) {
  url = String(url);
  const method = (init && init.method) || "GET";
  let body = null;
  try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
  calls.push({ url, method, body });

  // market-refresh → real etrade handler
  if (url.includes("/api/etrade") && url.includes("action=balance")) {
    const { statusCode, jsonBody } = await callHandler(etradeHandler, { action: "balance" });
    return makeRes(jsonBody, { ok: statusCode === 200, status: statusCode });
  }
  const et = await etradeRoutes(url);
  if (et) return et;

  // ── market-refresh plumbing (same shape as etrade-snapshot-unfreeze.test.js) ──
  if (url.includes("/col_prefs?select=cols&id=eq.schwab_tokens")) {
    return makeRes([{ cols: { accessToken: "fake-access-token", accessTokenExpiresAt: Date.now() + 3600000 } }]);
  }
  if (url.includes("/trader/v1/accounts/accountNumbers")) {
    return makeRes([{ accountNumber: "12343866", hashValue: "HASH1" }]);
  }
  if (url.includes("/trader/v1/accounts/HASH1") && url.includes("fields=positions")) {
    return makeRes({ securitiesAccount: {
      positions: [{ instrument: { assetType: "EQUITY", symbol: "INTC" }, longQuantity: 200 }],
      currentBalances: { liquidationValue: 200000, cashBalance: 5000 },
    } });
  }
  if (url.includes("/marketdata/v1/quotes") && url.includes("symbols=INTC")) {
    return makeRes({ INTC: { quote: {
      lastPrice: 35, netPercentChange: 1.5, bidPrice: 34.9, askPrice: 35.1,
      highPrice: 35.5, lowPrice: 34, openPrice: 34.5, totalVolume: 1000000,
    } } });
  }
  if (url.includes("/signal_rules?enabled=eq.true")) return makeRes([]);
  if (url.includes("/rest/v1/contracts") && url.includes("status=eq.Open")) return makeRes([]);
  if (url.includes("/api/etrade") && url.includes("action=positions")) return makeRes({ positions: [] });
  if (url.includes("/rest/v1/portfolio_snapshots") && url.includes("snapshot_date=eq.")) return makeRes([]);
  if (url.includes("/rest/v1/portfolio_snapshots") && url.includes("select=total_value,etrade_stale")) {
    return makeRes([{ total_value: 680000, etrade_stale: false }]);
  }
  if (url.includes("/rest/v1/portfolio_snapshots") && url.includes("_stale=eq.false")) {
    return makeRes([{ etrade_value: 111111, etrade_cash: 1111, schwab_value: 200000, schwab_cash: 5000 }]);
  }
  if (url.includes("pushover")) return makeRes({ status: 1 });

  return method === "GET" ? makeRes([]) : makeRes({});
}

beforeAll(async () => {
  process.env.VITE_SUPABASE_URL = "https://fake-project.supabase.co";
  process.env.VITE_SUPABASE_ANON_KEY = "fake-anon-key";
  process.env.SUPABASE_SERVICE_KEY = "fake-service-key";
  process.env.PUSHOVER_API_TOKEN = "fake-pushover-token";
  process.env.PUSHOVER_USER_KEY = "fake-pushover-user";
  process.env.ETRADE_CONSUMER_KEY = "fake-consumer-key";
  process.env.ETRADE_CONSUMER_SECRET = "fake-consumer-secret";
  delete process.env.CRON_SECRET;

  ({ default: etradeHandler } = await import("../api/etrade.js"));
  ({ default: marketRefreshHandler } = await import("../api/market-refresh.js"));
});

beforeEach(() => {
  calls = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW_ISO));
  vi.stubGlobal("fetch", vi.fn(fetchRouter));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const FUNDED_BALANCES = {
  KEY6917: { accountBalance: 270000, cashBalance: 8000 },
  KEY8222: { accountBalance: 210000, cashBalance: 2000 },
};

describe("api/etrade.js action=balance — funded-account allowlist", () => {
  it("ignores a stray empty account (5707): not fetched, not a failure, ok:true", async () => {
    scenario = {
      accounts: [ACCT_6917, ACCT_8222, ACCT_5707],
      balances: { ...FUNDED_BALANCES, KEY5707: { accountBalance: 0 } },
    };
    const { statusCode, jsonBody } = await callHandler(etradeHandler, { action: "balance" });

    expect(statusCode).toBe(200);
    expect(jsonBody.ok).toBe(true);
    expect(jsonBody.accounts.map(a => a.account)).toEqual(["ETrade 6917", "ETrade 8222"]);
    expect(jsonBody.ignored).toEqual(["ETrade 5707"]);
    expect(calls.some(c => c.url.includes("/KEY5707/"))).toBe(false);
  });

  it("allowlisted account that is genuinely empty (NAV fields present and 0) → ok:true value:0", async () => {
    scenario = {
      accounts: [ACCT_6917, ACCT_8222],
      balances: { KEY6917: FUNDED_BALANCES.KEY6917, KEY8222: { accountBalance: 0, cashBalance: 0 } },
    };
    const { jsonBody } = await callHandler(etradeHandler, { action: "balance" });

    expect(jsonBody.ok).toBe(true);
    expect(jsonBody.accounts.find(a => a.account === "ETrade 8222")).toMatchObject({ ok: true, value: 0 });
  });

  it("still fails an allowlisted account on a real HTTP failure (existing behavior preserved)", async () => {
    scenario = {
      accounts: [ACCT_6917, ACCT_8222],
      balances: { KEY6917: FUNDED_BALANCES.KEY6917, KEY8222: { status: 500, body: { Error: { message: "boom" } } } },
    };
    const { jsonBody } = await callHandler(etradeHandler, { action: "balance" });

    expect(jsonBody.ok).toBe(false);
    expect(jsonBody.accounts.find(a => a.account === "ETrade 8222").ok).toBe(false);
  });

  it("still fails an allowlisted account whose balance response has no NAV fields at all", async () => {
    scenario = {
      accounts: [ACCT_6917, ACCT_8222],
      balances: { KEY6917: FUNDED_BALANCES.KEY6917, KEY8222: { someOtherField: "x" } },
    };
    const { jsonBody } = await callHandler(etradeHandler, { action: "balance" });

    expect(jsonBody.ok).toBe(false);
    expect(jsonBody.accounts.find(a => a.account === "ETrade 8222").ok).toBe(false);
  });
});

describe("portfolio snapshot — a stray empty ETrade account does not stale the ETrade side", () => {
  function snapshotWriteBody() {
    const writes = calls.filter(c => c.url.includes("/rest/v1/portfolio_snapshots") && c.method === "POST" && c.url.includes("on_conflict=snapshot_date"));
    return writes[writes.length - 1]?.body;
  }

  it("writes the live 6917 + 8222 NAV (not carried forward) when ETrade also lists an empty 5707", async () => {
    scenario = {
      accounts: [ACCT_6917, ACCT_8222, ACCT_5707],
      balances: { ...FUNDED_BALANCES, KEY5707: { accountBalance: 0 } },
    };
    await callHandler(marketRefreshHandler, { force: "1" });

    const written = snapshotWriteBody();
    expect(written, "expected a portfolio_snapshots write").toBeTruthy();
    expect(written.etrade_stale).toBe(false);
    expect(written.etrade_value).toBe(480000);
    expect(written.etrade_value).not.toBe(111111); // not the carry-forward value
  });

  it("a real failure on a funded account still carries forward (existing behavior preserved)", async () => {
    scenario = {
      accounts: [ACCT_6917, ACCT_8222, ACCT_5707],
      balances: { KEY6917: FUNDED_BALANCES.KEY6917, KEY8222: { status: 500, body: { Error: { message: "boom" } } }, KEY5707: { accountBalance: 0 } },
    };
    await callHandler(marketRefreshHandler, { force: "1" });

    const written = snapshotWriteBody();
    expect(written, "expected a portfolio_snapshots write").toBeTruthy();
    expect(written.etrade_stale).toBe(true);
    expect(written.etrade_value).toBe(111111);
  });
});
