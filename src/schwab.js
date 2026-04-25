// schwab.js — Schwab Market Data API
// Replaces etrade.js for quotes and option chains
// In dev: calls /schwab-dev/* (Vite proxy)
// In prod: calls /api/schwab-proxy

const IS_DEV = import.meta.env.DEV;

export async function schwabGet(path, params = {}) {
  let url;
  if (IS_DEV) {
    const qs = new URLSearchParams(params).toString();
    url = `/schwab-dev${path}${qs ? "?" + qs : ""}`;
  } else {
    const qs = new URLSearchParams({ path, ...params }).toString();
    url = `/api/schwab-proxy?${qs}`;
  }
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Schwab ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// ── Quotes — returns { [ticker]: { lastPrice, bid, ask, changeClose, changePct, ... } }
export async function fetchQuotes(tickers) {
  if (!tickers.length) return {};

  // Schwab allows up to 500 symbols per request
  const data = await schwabGet("/marketdata/v1/quotes", {
    symbols: tickers.join(","),
    fields:  "quote,reference",
    indicative: false,
  });

  const results = {};
  for (const [sym, entry] of Object.entries(data || {})) {
    // Schwab returns data under entry.quote for equities
    const q = entry?.quote ?? entry;
    if (!q) continue;
    results[sym.toUpperCase()] = {
      lastPrice:   q.lastPrice   ?? q.mark        ?? null,
      bid:         q.bidPrice    ?? null,
      ask:         q.askPrice    ?? null,
      changeClose: q.netChange   ?? q.markChange  ?? null,
      changePct:   q.netPercentChange != null
                     ? q.netPercentChange / 100
                     : q.markPercentChange != null
                     ? q.markPercentChange / 100
                     : null,
      volume:      q.totalVolume ?? null,
      high52:      q["52WeekHigh"] ?? null,
      low52:       q["52WeekLow"]  ?? null,
      fetchedAt:   new Date().toISOString(),
    };
  }
  return results;
}

// ── Option chain for a single ticker + expiry date ─────────────────────────
export async function fetchOptionChain(ticker, expiryDate) {
  // expiryDate: "YYYY-MM-DD"
  const data = await schwabGet("/marketdata/v1/chains", {
    symbol:       ticker.toUpperCase(),
    contractType: "ALL",
    strikeCount:  30,
    fromDate:     expiryDate,
    toDate:       expiryDate,
  });

  const calls = [];
  const puts  = [];

  // Schwab returns callExpDateMap / putExpDateMap keyed by "YYYY-MM-DD:DTE"
  for (const [, strikes] of Object.entries(data?.callExpDateMap || {})) {
    for (const [, options] of Object.entries(strikes)) {
      for (const o of options) calls.push(normalizeOption(o, ticker, expiryDate, "Call"));
    }
  }
  for (const [, strikes] of Object.entries(data?.putExpDateMap || {})) {
    for (const [, options] of Object.entries(strikes)) {
      for (const o of options) puts.push(normalizeOption(o, ticker, expiryDate, "Put"));
    }
  }

  return { calls, puts };
}

// ── Fetch chains for all open positions ────────────────────────────────────
export async function fetchOpenPositionChains(openContracts) {
  const seen = new Set();
  const pairs = [];
  for (const c of openContracts) {
    if (!c.stock || !c.expires) continue;
    const key = `${c.stock.toUpperCase()}|${c.expires}`;
    if (!seen.has(key)) { seen.add(key); pairs.push({ ticker: c.stock.toUpperCase(), expiry: c.expires, key }); }
  }

  const result = {};
  const concurrency = 5;
  for (let i = 0; i < pairs.length; i += concurrency) {
    await Promise.all(
      pairs.slice(i, i + concurrency).map(async ({ ticker, expiry, key }) => {
        try {
          result[key] = await fetchOptionChain(ticker, expiry);
        } catch (err) {
          console.warn(`[schwab] chain fetch failed for ${key}:`, err.message);
          result[key] = { calls: [], puts: [], error: err.message };
        }
      })
    );
  }
  return result;
}

function normalizeOption(raw, ticker, expiryDate, type) {
  return {
    ticker, expiryDate, type,
    strike:       raw.strikePrice  ?? null,
    bid:          raw.bid          ?? null,
    ask:          raw.ask          ?? null,
    last:         raw.last         ?? raw.mark ?? null,
    mark:         raw.mark         ?? null,
    volume:       raw.totalVolume  ?? null,
    openInterest: raw.openInterest ?? null,
    iv:           raw.volatility   ?? null,
    delta:        raw.delta        ?? null,
    gamma:        raw.gamma        ?? null,
    theta:        raw.theta        ?? null,
    vega:         raw.vega         ?? null,
    dte:          raw.daysToExpiration ?? null,
    inTheMoney:   raw.inTheMoney   ?? null,
    optionSymbol: raw.symbol       ?? null,
    intrinsicValue: raw.intrinsicValue ?? null,
    extrinsicValue: raw.extrinsicValue ?? null,
  };
}

// ── Fetch Schwab account positions ────────────────────────────────────────────
// Returns { stocks: [{symbol, qty, avgPrice, marketValue, gainLoss, gainLossPct}],
//           cash: number, accountValue: number }
export async function fetchPositions() {
  // Step 1: get account hash
  const acctData = await schwabGet("/trader/v1/accounts/accountNumbers");
  const accounts = Array.isArray(acctData) ? acctData : [acctData];
  if (!accounts.length) throw new Error("No Schwab accounts found");

  // Fetch positions for all accounts
  const stocks = [];
  let totalCash = 0;
  let totalValue = 0;

  for (const acct of accounts) {
    const hash = acct.hashValue;
    if (!hash) continue;
    const data = await schwabGet(`/trader/v1/accounts/${hash}`, { fields: "positions" });
    const positions = data?.securitiesAccount?.positions ?? data?.positions ?? [];
    const balances  = data?.securitiesAccount?.currentBalances ?? data?.currentBalances ?? {};

    totalCash  += balances.cashAvailableForTrading ?? 0;
    totalValue += balances.liquidationValue ?? 0;

    for (const pos of positions) {
      const inst = pos.instrument;
      if (!inst || inst.assetType !== "EQUITY") continue; // skip options, funds
      const qty = pos.longQuantity ?? 0;
      if (qty <= 0) continue;
      stocks.push({
        symbol:       inst.symbol,
        qty,
        avgPrice:     pos.averageLongPrice ?? pos.taxLotAverageLongPrice ?? 0,
        marketValue:  pos.marketValue ?? 0,
        gainLoss:     pos.longOpenProfitLoss ?? 0,
        gainLossPct:  pos.averageLongPrice > 0
                        ? ((pos.marketValue / (pos.averageLongPrice * qty)) - 1) * 100
                        : 0,
        currentDayGL: pos.currentDayProfitLoss ?? 0,
        currentDayGLPct: pos.currentDayProfitLossPercentage ?? 0,
        accountNumber: acct.accountNumber,
      });
    }
  }

  return { stocks, cash: totalCash, accountValue: totalValue };
}

export function findOptionForContract(chainData, contract) {
  if (!chainData) return null;
  const key   = `${contract.stock?.toUpperCase()}|${contract.expires}`;
  const chain = chainData[key];
  if (!chain) return null;
  const list  = contract.type === "Put" ? chain.puts : chain.calls;
  if (!list?.length) return null;
  const exact = list.find(o => Number(o.strike) === Number(contract.strike));
  if (exact) return exact;
  return list.reduce((best, o) =>
    Math.abs(o.strike - contract.strike) < Math.abs(best.strike - contract.strike) ? o : best
  );
}
