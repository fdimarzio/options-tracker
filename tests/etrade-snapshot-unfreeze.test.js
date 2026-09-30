// tests/etrade-snapshot-unfreeze.test.js
// Regression test for the 65-day ETrade snapshot freeze (portfolio_snapshots.etrade_value
// stuck at $110,558 with etrade_stale=true from ~2026-07 to 2026-09-17, real NAV ~$487K).
//
// Root cause: the portfolio-snapshot outlier guard in api/market-refresh.js compared a fresh
// ETrade pull against the PRIOR snapshot's total_value without checking whether that prior
// value was itself stale/carried-forward. Once one bad pull got carried forward and marked
// stale, every subsequent good pull looked like a >15% "outlier" vs. the stale baseline and
// got carried forward again — a self-perpetuating lock that never resolved on its own.
//
// Fix: the outlier guard now also requires `!prevEtradeStale` — it only fires when the prior
// snapshot's ETrade side was itself trustworthy (not stale).
//
// This runs the REAL api/market-refresh.js handler (not a reimplementation), stubbing fetch,
// to prove:
//   (1) a fresh, correct ETrade pull is ACCEPTED (not carried forward) when the prior
//       snapshot was stale, even though it looks like a huge swing vs. that stale baseline.
//   (2) the guard still protects against a genuine bad pull when the prior snapshot was
//       trustworthy (not stale) — existing behavior is preserved.
//
// Run: npx vitest run tests/etrade-snapshot-unfreeze.test.js

import { describe, it, expect, beforeAll, afterEach, beforeEach, vi } from "vitest";

const NOW_ISO = "2026-09-17T18:00:00Z"; // Thu 2pm ET — within market hours

const CHAIN_EXPIRY = "2026-09-25";
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
let scenario; // set per-test: { prevEtradeStale, prevTotalValue, freshEtradeNav }

async function fetchRouter(url, init = {}) {
  const method = (init && init.method) || "GET";
  let body = null;
  try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
  calls.push({ url: String(url), method, body });

  // ── Schwab: valid, non-expiring token — no refresh needed ──────────────────
  if (url.includes("/col_prefs?select=cols&id=eq.schwab_tokens")) {
    return makeRes([{ cols: { accessToken: "fake-access-token", accessTokenExpiresAt: Date.now() + 3600000 } }]);
  }

  // ── Schwab: one account, one INTC position (so the handler doesn't bail out
  // early on "no contracts/positions/watchlist"), fixed liquidation value ─────
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

  // ── No signal rules — disables auto-STO / auto-BTC scanners entirely ───────
  if (url.includes("/signal_rules?enabled=eq.true")) {
    return makeRes([]);
  }

  // ── Chain data for INTC (needed for per-ticker scoring, not for signals) ───
  if (url.includes("/col_prefs?select=cols&id=eq.last_chain_refresh")) {
    return makeRes([{ cols: { chains: CHAIN_DATA } }]);
  }

  // ── No open contracts ────────────────────────────────────────────────────
  if (url.includes("/rest/v1/contracts") && url.includes("status=eq.Open")) {
    return makeRes([]);
  }

  // ── ETrade positions (used by other scanners, not the snapshot writer) ─────
  if (url.includes("/api/etrade") && url.includes("action=positions")) {
    return makeRes({ positions: [] });
  }

  // ── ETrade live balance for the snapshot writer — a fresh, correct pull, or a
  // failed pull (expired token) when the scenario wants ETrade to carry forward ──
  if (url.includes("/api/etrade") && url.includes("action=balance")) {
    if (scenario.etradeBalanceFails) {
      return makeRes({ accounts: [{ accountId: "1", account: "ETrade 1234", ok: false, error: "token_expired" }] });
    }
    return makeRes({
      accounts: [
        { accountId: "1", account: "ETrade 1234", ok: true, value: scenario.freshEtradeNav, cash: 10000 },
      ],
    });
  }

  // ── Portfolio snapshot: does today's row already exist? Default no (force a fresh
  // write); a scenario may supply an existing stale row to model a same-day re-run. ─
  if (url.includes("/rest/v1/portfolio_snapshots") && url.includes("snapshot_date=eq.")) {
    return makeRes(scenario.existingTodayRow ?? []);
  }

  // ── Portfolio snapshot: prior day's row, for daily-change + outlier-guard baseline ─
  // The fixed handler scopes this lookup with `snapshot_date=lt.<today>` so it can never
  // read today's own just-written row. We branch on that filter so the test can prove the
  // exclusion: with the filter present we hand back the REAL prior day; without it (the old
  // buggy query) we'd hand back today's own row — a different total that fails the assertions.
  if (url.includes("/rest/v1/portfolio_snapshots") && url.includes("select=total_value,etrade_stale")) {
    if (url.includes("snapshot_date=lt.")) {
      return makeRes([{ total_value: scenario.prevTotalValue, etrade_stale: scenario.prevEtradeStale }]);
    }
    return makeRes([{
      total_value:  scenario.todayOwnTotalValue  ?? scenario.prevTotalValue,
      etrade_stale: scenario.todayOwnEtradeStale ?? scenario.prevEtradeStale,
    }]);
  }

  // ── carryForward() lookups (last known-good, non-stale value) ──────────────
  if (url.includes("/rest/v1/portfolio_snapshots") && url.includes("_stale=eq.false")) {
    return makeRes([{ etrade_value: 480000, etrade_cash: 10000, schwab_value: 200000, schwab_cash: 5000 }]);
  }

  if (url.includes("/col_prefs?select=cols&id=eq.stocks_data")) {
    return makeRes([]);
  }
  if (url.includes("/col_prefs?select=cols&id=eq.notifications_sent")) {
    return makeRes([]);
  }
  if (url.includes("/col_prefs?select=cols&id=eq.watchlist")) {
    return makeRes([]);
  }
  if (url.includes("/col_prefs?select=cols&id=eq.portfolio_stale_alert")) {
    return makeRes([]);
  }
  if (url.includes("pushover")) {
    return makeRes({ status: 1 });
  }

  // ── Generic fallback for everything else ────────────────────────────────────
  return method === "GET" ? makeRes([]) : makeRes({});
}

describe("portfolio snapshot — ETrade outlier guard vs. stale baseline", () => {
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
    vi.stubGlobal("fetch", vi.fn(fetchRouter));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function runHandler() {
    const req = { method: "GET", query: { force: "1" }, headers: {} };
    let statusCode = null, jsonBody = null;
    const res = {
      setHeader: () => {},
      status(code) { statusCode = code; return this; },
      json(body) { jsonBody = body; return this; },
      end() { return this; },
    };
    await handler(req, res);
    return { statusCode, jsonBody };
  }

  function snapshotWriteBody() {
    const writes = calls.filter(c => c.url.includes("/rest/v1/portfolio_snapshots") && c.method === "POST" && c.url.includes("on_conflict=snapshot_date"));
    return writes[writes.length - 1]?.body;
  }

  function staleAlertSent() {
    return calls.some(c => c.url.includes("api.pushover.net") && c.body?.title?.includes("Portfolio snapshot stale"));
  }

  it("accepts a fresh correct ETrade pull when the prior snapshot was stale, instead of re-freezing it (regression: 65-day $110,558 freeze)", async () => {
    scenario = {
      prevEtradeStale: true,      // prior snapshot was carried-forward / frozen
      prevTotalValue: 310558,     // stale baseline: $110,558 ETrade (frozen) + $200,000 Schwab
      freshEtradeNav: 487000,     // real live NAV — looks like a huge swing vs. the stale baseline
    };

    await runHandler();

    const written = snapshotWriteBody();
    expect(written, `expected a portfolio_snapshots write. Calls: ${JSON.stringify(calls.filter(c => c.url.includes("portfolio_snapshots")).map(c => ({ url: c.url, method: c.method })))}`).toBeTruthy();
    expect(written.etrade_stale).toBe(false);
    expect(written.etrade_value).toBe(487000);
    expect(written.total_value).toBe(687000);
  });

  it("still carries forward a genuine bad pull when the prior snapshot was trustworthy (existing behavior preserved)", async () => {
    scenario = {
      prevEtradeStale: false,     // prior snapshot was a good, live value
      prevTotalValue: 687000,     // $487,000 ETrade (good) + $200,000 Schwab
      freshEtradeNav: 1000,       // a bad pull implying a huge, implausible drop
    };

    await runHandler();

    const written = snapshotWriteBody();
    expect(written, "expected a portfolio_snapshots write").toBeTruthy();
    expect(written.etrade_stale).toBe(true);
    expect(written.etrade_value).toBe(480000); // carried forward from carryForward() mock
  });

  // ── Regression: prior-snapshot lookup must exclude today (6am false-alarm bug) ──
  // On a same-day re-run (etradeLooksStale keeps the block re-firing), the prior-snapshot
  // lookup used to select the newest row overall — which by then is TODAY's own just-written
  // row. That made prevValue/prevEtradeStale reflect today itself: daily_change collapsed to
  // ~0 (comparing today to itself) and prevEtradeStale echoed today's stale flag instead of the
  // real prior day. Fix: scope the lookup with `snapshot_date=lt.<today>`.
  it("scopes the prior-snapshot lookup to before today, so a same-day re-run reads the real prior day (not today's own row)", async () => {
    scenario = {
      existingTodayRow: [{ id: 1, etrade_value: 110000, etrade_stale: true }], // today's row exists & looks stale → block re-runs
      prevEtradeStale: false,       // the REAL prior day was a good, live value
      prevTotalValue: 685000,       // yesterday's total
      freshEtradeNav: 487000,       // today's fresh, correct ETrade pull (→ total 687000)
      todayOwnTotalValue: 687000,   // what an un-scoped lookup would wrongly return (today's own row)
      todayOwnEtradeStale: true,    // …with today's own stale flag
    };

    await runHandler();

    // The lookup URL is scoped to before today and still ordered newest-first.
    const priorLookup = calls.find(c =>
      c.url.includes("/rest/v1/portfolio_snapshots") && c.url.includes("select=total_value,etrade_stale"));
    expect(priorLookup, "expected a prior-snapshot lookup").toBeTruthy();
    expect(priorLookup.url).toContain("snapshot_date=lt.");
    expect(priorLookup.url).toContain("order=snapshot_date.desc");

    // daily_change is computed against the REAL prior day (685000), not today itself (→ 0).
    const written = snapshotWriteBody();
    expect(written, "expected a portfolio_snapshots write").toBeTruthy();
    expect(written.total_value).toBe(687000);
    expect(written.etrade_stale).toBe(false);   // fresh pull accepted (guard sees prior day fresh, tiny Δ%)
    expect(written.daily_change).toBe(2000);    // 687000 − 685000, NOT 0 (would be 687000 − 687000 if it re-read today's row)
  });

  // ── Morning-stale alert suppression (the ~6am false alarm) ────────────────────
  // ETrade OAuth tokens require same-day renewal, so ETrade carries forward every morning
  // until re-auth (~10am ET). That expected gap shouldn't page. The alert is suppressed only
  // when ETrade is the SOLE stale side, the prior day's ETrade was fresh (a one-morning gap,
  // not a freeze), and it's before 10am ET — a genuine multi-day freeze still alerts. The
  // prior-day-fresh signal relies on the yest lookup excluding today's own row (fix above).
  it("does NOT alert on expected morning ETrade staleness (ETrade-only, prior day fresh, before 10am ET)", async () => {
    vi.setSystemTime(new Date("2026-09-17T13:00:00Z")); // 9:00am ET
    scenario = {
      etradeBalanceFails: true,   // ETrade token not yet renewed → carries forward, etrade_stale=true
      prevEtradeStale: false,     // the REAL prior day's ETrade was fresh → this is a one-morning gap
      prevTotalValue: 680000,
    };

    await runHandler();

    // The row is still written (staleness is recorded), but no page goes out.
    const written = snapshotWriteBody();
    expect(written, "expected a portfolio_snapshots write").toBeTruthy();
    expect(written.etrade_stale).toBe(true);
    expect(written.schwab_stale).toBe(false);
    expect(staleAlertSent()).toBe(false);
  });

  it("STILL alerts on a genuine multi-day freeze (ETrade stale this morning AND the prior day)", async () => {
    vi.setSystemTime(new Date("2026-09-17T13:00:00Z")); // 9:00am ET — same early window
    scenario = {
      etradeBalanceFails: true,   // ETrade stale again today
      prevEtradeStale: true,      // …and it was already stale yesterday → a real freeze, not a morning gap
      prevTotalValue: 680000,
    };

    await runHandler();

    const written = snapshotWriteBody();
    expect(written, "expected a portfolio_snapshots write").toBeTruthy();
    expect(written.etrade_stale).toBe(true);
    expect(staleAlertSent()).toBe(true);
  });
});
