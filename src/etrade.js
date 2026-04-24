// ─────────────────────────────────────────────────────────────────────────────
// etrade.js  —  E*TRADE Sandbox API helper
//
// All requests go through /etrade/* which Vite proxies to
// https://apisb.etrade.com, adding your OAuth 1.0a signature server-side.
//
// REQUIRED .env variables:
//   VITE_ETRADE_CONSUMER_KEY      (your sandbox consumer key  — safe to expose)
//   ETRADE_CONSUMER_SECRET        (never prefix with VITE_    — stays server-side)
//   ETRADE_ACCESS_TOKEN           (obtained once via OAuth flow)
//   ETRADE_ACCESS_TOKEN_SECRET    (obtained once via OAuth flow)
//
// The Vite dev-proxy (vite.config.js) injects the Authorization header so the
// browser never sees your secrets.
// ─────────────────────────────────────────────────────────────────────────────

// In dev, calls go to /etrade (Vite proxy in vite.config.js signs them).
// In production, calls go to /api/etrade-proxy (Vercel serverless function signs them).
const IS_DEV = import.meta.env.DEV;

async function etradeGet(path, params = {}) {
  let url;
  if (IS_DEV) {
    // Dev: Vite proxy at /etrade/* handles OAuth signing
    const qs = new URLSearchParams(params).toString();
    url = `/etrade${path}${qs ? "?" + qs : ""}`;
  } else {
    // Production: Vercel serverless function at /api/etrade-proxy
    const qs = new URLSearchParams({ path, ...params }).toString();
    url = `/api/etrade-proxy?${qs}`;
  }
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`E*TRADE ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ── Quote — returns { [ticker]: { lastPrice, bid, ask, changeClose, volume } }
export async function fetchQuotes(tickers) {
  if (!tickers.length) return {};
  // E*TRADE allows up to 25 symbols per request
  const chunks = [];
  for (let i = 0; i < tickers.length; i += 25)
    chunks.push(tickers.slice(i, i + 25));

  const results = {};
  await Promise.all(
    chunks.map(async (chunk) => {
      const symbols = chunk.join(",");
      const data = await etradeGet(`/v1/market/quote/${symbols}.json`);
      // Response: { QuoteResponse: { QuoteData: [...] } }
      const list = data?.QuoteResponse?.QuoteData ?? [];
      for (const q of list) {
        const sym = q?.Product?.symbol;
        // Production API returns data under All, Intraday, or directly on q
        const all = q?.All ?? q?.Intraday ?? q ?? {};
        if (sym) {
          // E*TRADE production uses different field names depending on quote detail level
          // Try all known variants for each field
          const lastPrice   = all.lastTrade ?? all.lastPrice ?? all.last ?? null;
          const changeClose = all.changeClose ?? all.change ?? all.priceChange ?? null;
          // changeClosePercentage comes as e.g. 1.25 meaning 1.25% — store as decimal 0.0125
          const changePctRaw = all.changeClosePercentage ?? all.changePercent ?? all.percentChange ?? null;
          const changePct    = changePctRaw != null ? changePctRaw / 100 : null;
          results[sym.toUpperCase()] = {
            lastPrice,
            bid:         all.bid          ?? null,
            ask:         all.ask          ?? null,
            changeClose,
            changePct,
            volume:      all.totalVolume  ?? all.volume ?? null,
            high52:      all.high52       ?? null,
            low52:       all.low52        ?? null,
            fetchedAt:   new Date().toISOString(),
          };
          // Debug log first result so we can verify field names in browser console
          if (Object.keys(results).length === 1) {
            console.log("[etrade] quote fields:", sym, JSON.stringify({
              lastTrade: all.lastTrade, lastPrice: all.lastPrice, last: all.last,
              change: all.change, changeClose: all.changeClose, priceChange: all.priceChange,
              changePercent: all.changePercent, percentChange: all.percentChange,
              changeClosePercentage: all.changeClosePercentage,
              bid: all.bid, ask: all.ask,
            }));
          }
        }
      }
    })
  );
  return results;
}

// ── Option chain for a single ticker + expiry date ────────────────────────────
// Returns { calls: [...], puts: [...] }  (raw E*TRADE OptionPair arrays)
export async function fetchOptionChain(ticker, expiryDate) {
  // NOTE: E*TRADE sandbox does not return real option chain data.
  // This will work correctly against the production API (api.etrade.com).
  // expiryDate: "YYYY-MM-DD"
  const [year, month, day] = expiryDate.split("-").map(Number);
  const data = await etradeGet("/v1/market/optionchains.json", {
    symbol:         ticker.toUpperCase(),
    expiryYear:     year,
    expiryMonth:    month,
    expiryDay:      day,
    optionCategory: "STANDARD",
    chainType:      "CALLPUT",
    noOfStrikes:    30,
  });

  const pairs = data?.OptionChainResponse?.OptionPair ?? [];
  const calls = [];
  const puts  = [];

  for (const pair of pairs) {
    if (pair.Call) calls.push(normalizeOption(pair.Call, ticker, expiryDate, "Call"));
    if (pair.Put)  puts.push(normalizeOption(pair.Put,  ticker, expiryDate, "Put"));
  }

  return { calls, puts };
}

// ── Fetch option chains for ALL open positions' (ticker, expiry) combos ───────
// openContracts: array of contract objects with .stock and .expires fields
// Returns { [ticker_expiry_key]: { calls, puts } }
export async function fetchOpenPositionChains(openContracts) {
  // Deduplicate by (ticker, expiry)
  const seen = new Set();
  const pairs = [];
  for (const c of openContracts) {
    if (!c.stock || !c.expires) continue;
    const key = `${c.stock.toUpperCase()}|${c.expires}`;
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push({ ticker: c.stock.toUpperCase(), expiry: c.expires, key });
    }
  }

  const result = {};
  // Fetch concurrently (throttled to 5 at a time to avoid rate limits)
  const concurrency = 5;
  for (let i = 0; i < pairs.length; i += concurrency) {
    await Promise.all(
      pairs.slice(i, i + concurrency).map(async ({ ticker, expiry, key }) => {
        try {
          result[key] = await fetchOptionChain(ticker, expiry);
        } catch (err) {
          console.warn(`[etrade] chain fetch failed for ${key}:`, err.message);
          result[key] = { calls: [], puts: [], error: err.message };
        }
      })
    );
  }
  return result;
}

// ── Normalize raw E*TRADE option object → app-friendly shape ─────────────────
function normalizeOption(raw, ticker, expiryDate, type) {
  return {
    ticker,
    expiryDate,
    type,                                  // "Call" | "Put"
    strike:       raw.strikePrice  ?? null,
    bid:          raw.bid          ?? null,
    ask:          raw.ask          ?? null,
    last:         raw.lastPrice    ?? null,
    volume:       raw.volume       ?? null,
    openInterest: raw.openInterest ?? null,
    iv:           raw.iv           ?? null,  // implied volatility (decimal, e.g. 0.45)
    delta:        raw.GreekValues?.currentValue ?? null,
    inTheMoney:   raw.inTheMoney   ?? null,
    optionSymbol: raw.optionSymbol ?? null,
  };
}

// ── Find the closest option in a chain to a contract's strike ─────────────────
// Returns the matching option object or null
export function findOptionForContract(chainData, contract) {
  if (!chainData) return null;
  const key = `${contract.stock?.toUpperCase()}|${contract.expires}`;
  const chain = chainData[key];
  if (!chain) return null;
  const list = contract.type === "Put" ? chain.puts : chain.calls;
  if (!list?.length) return null;
  // Find exact strike match first, then closest
  const exact = list.find(o => Number(o.strike) === Number(contract.strike));
  if (exact) return exact;
  return list.reduce((best, o) =>
    Math.abs(o.strike - contract.strike) < Math.abs(best.strike - contract.strike)
      ? o : best
  );
}
