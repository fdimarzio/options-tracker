// tests/helpers/earnings-fetch-stub.cjs
// Preloaded (node --require) into a CHILD process that runs the real scripts/earnings-refresh.js, so the
// script's actual control flow is exercised with the network replaced. Not a test file itself.
// Config via env: EARN_STUB_FIXTURE (json path), EARN_STUB_LOG (jsonl path the stub appends every request to).
const fs = require("node:fs");

const fx = JSON.parse(fs.readFileSync(process.env.EARN_STUB_FIXTURE, "utf8"));
const logFile = process.env.EARN_STUB_LOG;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const method = (init && init.method) || "GET";
  let body = null;
  try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = init && init.body; }
  fs.appendFileSync(logFile, JSON.stringify({ method, url, body }) + "\n");

  // ── reads: the four universe sources ──
  if (url.includes("/rest/v1/contracts?select=stock&status=eq.Open")) {
    return fx.contractsStatus ? json({ message: "boom" }, fx.contractsStatus) : json(fx.contracts || []);
  }
  if (url.includes("id=eq.watchlist")) return json(fx.watchlist ? [{ cols: { tickers: fx.watchlist } }] : []);
  if (url.includes("id=eq.stocks_data")) {
    return fx.stocksDataStatus ? json({ message: "boom" }, fx.stocksDataStatus) : json(fx.stocks_data ? [{ cols: fx.stocks_data }] : []);
  }
  if (url.includes("/rest/v1/stock_user_settings")) {
    return fx.settingsStatus ? json({ message: 'relation "stock_user_settings" does not exist' }, fx.settingsStatus) : json(fx.settings || []);
  }

  // ── Finnhub per-symbol calendar ──
  if (url.includes("finnhub.io/api/v1/calendar/earnings")) {
    const sym = new URL(url).searchParams.get("symbol");
    const dates = (fx.finnhub && fx.finnhub[sym]) || [];
    return json({ earningsCalendar: dates.map(date => ({ symbol: sym, date })) });
  }

  // ── writes ──
  if (method === "POST") return new Response("", { status: 201 });

  // everything else (straddling-shorts query, earnings_prealert read, ...)
  return json([]);
};
