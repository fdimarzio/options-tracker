// api/market-refresh.js
// Fetches stock quotes, evaluates close signals using DTE/OTM matrix,
// sends Pushover notifications with bid/ask/mid/profit. Re-notifies on improvement.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY; // service key for token rows
const SCHWAB_BASE  = "https://api.schwabapi.com";
const APP_URL      = "https://options-tracker-five.vercel.app";

function isMarketHours() {
  const et   = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day  = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960;
}

async function getValidToken() {
  const res  = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_tokens`, {
    headers: { apikey: SUPABASE_SVC_KEY, Authorization: `Bearer ${SUPABASE_SVC_KEY}` },
  });
  const t = (await res.json())?.[0]?.cols;
  if (!t?.accessToken) throw new Error("No Schwab tokens");
  if (t.accessTokenExpiresAt > Date.now() + 120000) return t.accessToken;
  if (!t.refreshToken || t.refreshTokenExpiresAt < Date.now()) throw new Error("Refresh token expired");
  const creds = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString("base64");
  const r = await fetch("https://api.schwabapi.com/v1/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken }),
  });
  const n = await r.json();
  if (!n.access_token) throw new Error("Token refresh failed");
  await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
    method: "POST",
    headers: { apikey: SUPABASE_SVC_KEY, Authorization: `Bearer ${SUPABASE_SVC_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: "schwab_tokens", cols: { ...t, accessToken: n.access_token, refreshToken: n.refresh_token || t.refreshToken, accessTokenExpiresAt: Date.now() + (n.expires_in * 1000) }, updated_at: new Date().toISOString() }),
  });
  return n.access_token;
}

// ── Get Schwab account hash by account name (in-memory cache) ─────────────────
let _acctHashCache = null;
async function getAccountHash(token, accountName) {
  if (_acctHashCache) return _acctHashCache;
  const r = await fetch(`${SCHWAB_BASE}/trader/v1/accounts/accountNumbers`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const accounts = await r.json();
  if (!Array.isArray(accounts) || !accounts.length) throw new Error("No Schwab accounts");
  const suffix = accountName?.replace(/\D/g, "").slice(-4);
  if (suffix) {
    const match = accounts.find(a => a.accountNumber?.slice(-4) === suffix);
    if (match) { _acctHashCache = match.hashValue; return match.hashValue; }
  }
  _acctHashCache = accounts[0].hashValue;
  return _acctHashCache;
}

// ── Fetch equity positions from Schwab + ETrade ───────────────────────────────
// Returns array of { symbol, qty, account, accountIdKey? }
async function fetchAllPositions(token) {
  const positions = [];

  // ── Schwab ──────────────────────────────────────────────────────────────────
  try {
    const acctRes  = await fetch(`${SCHWAB_BASE}/trader/v1/accounts/accountNumbers`, { headers: { Authorization: `Bearer ${token}` } });
    const accounts = await acctRes.json();
    for (const acct of (Array.isArray(accounts) ? accounts : [])) {
      try {
        const posRes  = await fetch(`${SCHWAB_BASE}/trader/v1/accounts/${acct.hashValue}?fields=positions`, { headers: { Authorization: `Bearer ${token}` } });
        const posData = await posRes.json();
        const pos     = posData?.securitiesAccount?.positions || [];
        for (const p of pos) {
          const inst = p.instrument;
          if (inst?.assetType !== "EQUITY") continue;
          const qty = p.longQuantity || 0;
          if (qty < 1) continue;
          positions.push({
            symbol:  inst.symbol?.toUpperCase(),
            qty,
            account: `Schwab ${String(acct.accountNumber || "").slice(-4)}`,
            broker:  "schwab",
          });
        }
      } catch(e) { console.warn("[positions] Schwab account", acct.accountNumber, e.message); }
    }
  } catch(e) { console.warn("[positions] Schwab fetch failed:", e.message); }

  // ── ETrade ──────────────────────────────────────────────────────────────────
  try {
    const etRes  = await fetch(`${APP_URL}/api/etrade?action=positions&secret=${process.env.CRON_SECRET}`);
    const etData = await etRes.json();
    for (const p of (etData?.positions || [])) {
      const qty = Math.floor(p.qty || 0);
      if (qty < 1) continue;
      positions.push({
        symbol:  p.symbol?.toUpperCase(),
        qty,
        account: p.account,
        broker:  "etrade",
      });
    }
  } catch(e) { console.warn("[positions] ETrade fetch failed:", e.message); }

  return positions;
}

async function sendPushover(title, body, url, urlTitle, priority) {
  const token = process.env.PUSHOVER_API_TOKEN;
  const user  = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return;
  await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, user, title, message: body, priority: priority || 0, sound: priority >= 1 ? "cashregister" : "pushover", url, url_title: urlTitle }),
  });
}

// ── DTE/OTM matrix lookup ─────────────────────────────────────────────────────
function getMatrixTarget(contract, stockPrice, matrix) {
  if (!matrix?.dteCols || !matrix?.otmRows) return null;
  const data   = contract.type === "Put" ? matrix.put : matrix.call;
  if (!data) return null;

  const dte    = Math.ceil((new Date(contract.expires) - new Date()) / 86400000);
  const strike = +contract.strike;

  // OTM% — for calls: (strike - stock) / stock, for puts: (stock - strike) / stock
  const otmPct = contract.type === "Put"
    ? ((stockPrice - strike) / stockPrice) * 100
    : ((strike - stockPrice) / stockPrice) * 100;

  // Find DTE column index
  const dteIdx = matrix.dteCols.findIndex(col => dte <= col.max);
  if (dteIdx === -1) return null;

  // Find OTM row index (rows are ordered highest OTM first)
  let otmIdx = matrix.otmRows.length - 1;
  for (let i = 0; i < matrix.otmRows.length; i++) {
    if (otmPct >= matrix.otmRows[i].min) { otmIdx = i; break; }
  }

  const targetPct = data[otmIdx]?.[dteIdx];
  if (!targetPct || targetPct === 0) return null; // 0 = avoid

  return {
    targetPct,          // e.g. 65 = close when 65% of premium captured
    buyBackPct: 100 - targetPct, // e.g. 35 = buy back when contract worth 35% of premium
    dte,
    otmPct: Math.round(otmPct * 10) / 10,
    dteLabel:  matrix.dteCols[dteIdx]?.label,
    otmLabel:  matrix.otmRows[otmIdx]?.label,
  };
}

// ── Signal evaluation ─────────────────────────────────────────────────────────
function evaluateSignal(contract, chainEntry, stockPrice, matrix, quotes) {
  if (!chainEntry) return null;

  const ask = chainEntry.ask ?? chainEntry.mark ?? null;
  const bid = chainEntry.bid ?? null;
  const mid = (ask != null && bid != null)
    ? Math.round(((ask + bid) / 2) * 100) / 100
    : ask;
  if (ask == null) return null;

  const qty          = +contract.qty || 1;
  const premiumTotal = Math.abs(+contract.premium || 0); // netAmount — already full position value
  if (!premiumTotal) return null;

  const costToClose     = Math.round(ask * qty * 100 * 100) / 100;
  const projectedProfit = Math.round((premiumTotal - costToClose) * 100) / 100;
  const profitPct       = Math.round((projectedProfit / premiumTotal) * 1000) / 10; // e.g. 67.3

  const dte   = Math.ceil((new Date(contract.expires) - new Date()) / 86400000);
  const isITM = contract.type === "Put"
    ? stockPrice < +contract.strike
    : stockPrice > +contract.strike;

  // ITM% — how far in the money
  const itmPct = isITM ? (contract.type === "Put"
    ? ((+contract.strike - stockPrice) / +contract.strike) * 100
    : ((stockPrice - +contract.strike) / +contract.strike) * 100) : 0;

  const isWheel   = contract.strategy?.toLowerCase().includes("wheel");
  const changePct = quotes[contract.stock?.toUpperCase()]?.changePct ?? 0;
  const stockUp   = changePct > 0;

  const target = getMatrixTarget(contract, stockPrice, matrix);

  let level    = null;
  let scenario = null; // for expiry day notification framing

  if (dte <= 0) {
    // ── Expiry day scenario matrix ─────────────────────────────────────────
    if (isWheel && contract.type === "Put") {
      // Wheel put — special handling
      if (isITM && itmPct > 5) {
        level    = "WHEEL_ITM";
        scenario = "wheel_itm_deep";  // deep ITM — present roll math
      } else if (isITM) {
        level    = "WHEEL_ITM";
        scenario = "wheel_itm_shallow"; // shallow ITM — may let assign
      } else {
        level    = "WHEEL_OTM";
        scenario = "wheel_otm"; // OTM — take profit, re-sell put
      }
    } else if (profitPct >= 65) {
      // High profit regardless of direction — act fast (WDC rule)
      level    = "CLOSE_NOW";
      scenario = "expiry_high_profit";
    } else if (!isITM && stockUp) {
      // OTM + stock up — take profit, re-sell STO
      level    = "CLOSE_NOW";
      scenario = "expiry_otm_up";
    } else if (isITM && stockUp) {
      // ITM + stock up — depends on momentum (check changePct trend)
      level    = "ITM_WARNING";
      scenario = "expiry_itm_up";
    } else if (!isITM && !stockUp) {
      // OTM + stock down — time decay working, auto-close at 2pm
      level    = "EXPIRY_WAIT";
      scenario = "expiry_otm_down";
    } else if (isITM && !stockUp) {
      // ITM + stock down — time decay minimizing loss, auto-close at 2pm
      level    = "ITM_WARNING";
      scenario = "expiry_itm_down";
    } else {
      level    = "CLOSE_NOW";
      scenario = "expiry_default";
    }
  } else if (target && profitPct >= target.targetPct)        level = "CLOSE_NOW";
  else if (target && profitPct >= target.targetPct * 0.75)   level = "APPROACHING";

  if (!level) return null;

  return {
    level, scenario, profitPct, projectedProfit, premiumTotal,
    costToClose, ask, bid, mid, dte, isITM, itmPct, stockUp, changePct,
    stockPrice, target, isWheel,
  };
}

// ── Notification message builder ──────────────────────────────────────────────
function buildNotification(contract, signal, quotes) {
  const sign = signal.projectedProfit >= 0 ? "+" : "";
  const stockLine = signal.stockPrice != null ? `Stock: $${signal.stockPrice.toFixed(2)}${(() => {
    const q = quotes?.[contract.stock?.toUpperCase()];
    if (!q?.changeClose && !q?.changePct) return "";
    const chg = q.changeClose != null ? `${q.changeClose >= 0?"+":""}$${q.changeClose.toFixed(2)}` : "";
    const pct = q.changePct   != null ? ` (${q.changePct >= 0?"+":""}${(q.changePct*100).toFixed(2)}%)` : "";
    return `  ${chg}${pct}`;
  })()}` : "";

  const priceLine = `Bid: $${signal.bid?.toFixed(2)??"—"}  Mid: $${signal.mid?.toFixed(2)??"—"}  Ask: $${signal.ask?.toFixed(2)??"—"}`;
  const profitLine = `Profit: ${sign}$${signal.projectedProfit.toFixed(2)} (${signal.profitPct.toFixed(0)}%)`;
  const costLine   = `Cost to close: $${signal.costToClose.toFixed(2)}`;
  const header     = `${contract.opt_type} ${contract.stock} $${contract.strike} ${contract.type} ${contract.expires} · ${contract.account} · qty ${contract.qty}`;

  // ── Scenario-specific messaging ─────────────────────────────────────────
  const s = signal.scenario;
  let emoji, label, actionLine, priority;

  if (s === "expiry_high_profit") {
    emoji = "⚡"; label = "ACT FAST — HIGH PROFIT";
    actionLine = `${signal.profitPct.toFixed(0)}% profit — close immediately, stock volatile`;
    priority = 2;
  } else if (s === "expiry_otm_up") {
    emoji = "🎯"; label = "EXPIRY — TAKE PROFIT";
    actionLine = `OTM + stock up ${signal.changePct >= 0 ? "+" : ""}${(signal.changePct*100).toFixed(1)}% — close and re-sell STO`;
    priority = 1;
  } else if (s === "expiry_itm_up") {
    emoji = "🚨"; label = "EXPIRY — ITM + RISING";
    actionLine = `${signal.itmPct.toFixed(1)}% ITM, stock still up — watch momentum, close if fading`;
    priority = 1;
  } else if (s === "expiry_otm_down") {
    emoji = "⏳"; label = "EXPIRY — TIME DECAY WORKING";
    actionLine = `OTM + stock down — time decay increasing profit, consider closing`;
    priority = 0;
  } else if (s === "expiry_itm_down") {
    emoji = "⚠️"; label = "EXPIRY — ITM + FALLING";
    actionLine = `${signal.itmPct.toFixed(1)}% ITM, stock down — time decay minimizing loss, monitor closely`;
    priority = 1;
  } else if (s === "wheel_itm_deep") {
    emoji = "🔄"; label = "WHEEL — DEEP ITM";
    actionLine = `${signal.itmPct.toFixed(1)}% ITM — assignment risk high, consider rolling to lower strike`;
    priority = 1;
  } else if (s === "wheel_itm_shallow") {
    emoji = "🔄"; label = "WHEEL — ITM";
    actionLine = `${signal.itmPct.toFixed(1)}% ITM — may let assign or close for profit`;
    priority = 0;
  } else if (s === "wheel_otm") {
    emoji = "🔄"; label = "WHEEL — TAKE PROFIT";
    actionLine = `OTM — take profit and re-sell put at same or lower strike`;
    priority = 0;
  } else {
    // Non-expiry signals — existing behavior
    emoji  = signal.level === "ITM_WARNING" ? "🚨" : signal.level === "CLOSE_NOW" ? "🎯" : "📈";
    label  = signal.level === "ITM_WARNING" ? "ITM WARNING" : signal.level === "CLOSE_NOW" ? "CLOSE NOW" : "APPROACHING TARGET";
    actionLine = signal.target ? `Target: ${signal.target.targetPct}% [${signal.target.otmLabel} / ${signal.target.dteLabel}]` : "";
    priority = signal.level === "ITM_WARNING" ? 1 : signal.level === "CLOSE_NOW" ? 1 : 0;
  }

  const title = `${emoji} ${label}: ${contract.stock} ${contract.expires} $${contract.strike} ${contract.type}`;
  const body  = [header, "", priceLine, costLine, profitLine, actionLine, stockLine].filter(Boolean).join("\n");
  const url   = `${APP_URL}/?action=close&id=${contract.id}`;

  return { title, body, url, priority };
}

// ── Momentum evaluation ────────────────────────────────────────────────────────
// Returns { pass: bool, reasons: string[], indicators: {} } 
function evaluateMomentum(symbol, quote, priceHistory, config) {
  if (!config) return { pass: true, reasons: ["no momentum config — passing"], indicators: {} };

  const reasons    = [];
  const indicators = {};
  let pass         = true;

  const last     = quote.lastPrice;
  const dayHigh  = quote.dayHigh;
  const openPrice = quote.openPrice;

  // 1. Pullback from intraday high
  if (config.pullback_enabled && dayHigh && last) {
    const pullbackPct = ((dayHigh - last) / dayHigh) * 100;
    indicators.pullbackFromHigh = Math.round(pullbackPct * 100) / 100;
    if (pullbackPct < config.min_pullback_from_high_pct) {
      pass = false;
      reasons.push(`within ${pullbackPct.toFixed(2)}% of intraday high ($${dayHigh}) — momentum still running (need ≥${config.min_pullback_from_high_pct}% pullback)`);
    } else {
      reasons.push(`✓ pullback ${pullbackPct.toFixed(2)}% from high — momentum fading`);
    }
  }

  // 2. Rate of change (deceleration)
  if (config.momentum_enabled && config.require_decelerating) {
    const symHistory = (Array.isArray(priceHistory) ? priceHistory : [])
      .filter(r => r.symbol === symbol)
      .sort((a, b) => new Date(b.captured_at) - new Date(a.captured_at));

    const lookbackMs = (config.momentum_lookback_mins || 30) * 60000;
    const cutoff     = new Date(Date.now() - lookbackMs);
    const historical = symHistory.find(r => new Date(r.captured_at) <= cutoff);

    if (historical?.change_pct != null && quote.changePct != null) {
      const currentChangePct  = quote.changePct * 100;
      const historicalChangePct = historical.change_pct;
      const isDecelerating    = currentChangePct <= historicalChangePct;
      indicators.changePctNow  = Math.round(currentChangePct * 100) / 100;
      indicators.changePct30m  = Math.round(historicalChangePct * 100) / 100;
      indicators.decelerating  = isDecelerating;
      if (!isDecelerating) {
        pass = false;
        reasons.push(`accelerating: +${historicalChangePct.toFixed(2)}% → +${currentChangePct.toFixed(2)}% — still running up`);
      } else {
        reasons.push(`✓ decelerating: +${historicalChangePct.toFixed(2)}% → +${currentChangePct.toFixed(2)}% — move fading`);
      }
    } else {
      reasons.push(`no historical snapshot for deceleration check (${config.momentum_lookback_mins}m lookback)`);
    }
  }

  // 3. Open gap check
  if (config.gap_enabled && openPrice && last) {
    const gapPct = ((openPrice - (quote.closePrice || openPrice)) / (quote.closePrice || openPrice)) * 100;
    // Simpler: use changePct from open
    const moveFromOpen = ((last - openPrice) / openPrice) * 100;
    indicators.moveFromOpen = Math.round(moveFromOpen * 100) / 100;
    // Skip if stock gapped up too much at open (gap already captured, may keep running)
    if (config.max_gap_up_pct && moveFromOpen > config.max_gap_up_pct) {
      pass = false;
      reasons.push(`gap-up ${moveFromOpen.toFixed(2)}% from open exceeds max ${config.max_gap_up_pct}% — too risky`);
    } else {
      reasons.push(`✓ move from open ${moveFromOpen.toFixed(2)}% within acceptable range`);
    }
  }

  return { pass, reasons, indicators };
}

// ── Fibonacci level computation ───────────────────────────────────────────────
function computeFibFactors(candles, stockPrice, lookback = 60) {
  if (!candles || candles.length < 10 || !stockPrice) return null;
  const window = candles.slice(-Math.min(lookback, candles.length));
  const swingHigh = Math.max(...window.map(c => c.high));
  const swingLow  = Math.min(...window.map(c => c.low));
  const range = swingHigh - swingLow;
  if (range <= 0) return null;
  const FIB_PCTS = [0.236, 0.382, 0.5, 0.618, 0.786];
  const levels = FIB_PCTS.map(pct => ({
    pct, price: Math.round((swingHigh - pct * range) * 100) / 100,
  }));
  let nearestLevel = null, nearestDistPct = Infinity;
  for (const lvl of levels) {
    const distPct = Math.abs(stockPrice - lvl.price) / stockPrice * 100;
    if (distPct < nearestDistPct) { nearestDistPct = distPct; nearestLevel = lvl; }
  }
  const prevClose  = candles[candles.length - 2]?.close;
  const brokeBelow = nearestLevel && prevClose > nearestLevel.price && stockPrice < nearestLevel.price;
  return {
    fib_proximity_pct:   Math.round(nearestDistPct * 100) / 100,
    fib_level:           nearestLevel?.pct ?? null,
    fib_broke_below:     brokeBelow ? 1 : 0,
    fib_near_resistance: (nearestLevel?.pct <= 0.382 && nearestDistPct < 1.5) ? 1 : 0,
    fib_near_support:    (nearestLevel?.pct >= 0.618 && nearestDistPct < 1.5) ? 1 : 0,
  };
}

// ── RSI-14 computation ────────────────────────────────────────────────────────
function computeRSI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const closes = candles.map(c => c.close);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }
  let avgGain = gains  / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

// ── Bollinger Bands ───────────────────────────────────────────────────────────
// candles: [{ close }] ordered oldest → newest, period default 20
// Returns:
//   bb_position: where current price sits in the band (-1 = at/below lower, 0 = middle, 1 = at/above upper)
//   bb_pct_b:    %B value (0 = lower band, 0.5 = middle, 1 = upper band, can exceed 0-1)
//   bb_width:    band width as % of middle band (volatility proxy)
function computeBollingerBands(candles, period = 20) {
  if (!candles || candles.length < period) return null;
  const recent = candles.slice(-period);
  const closes = recent.map(c => c.close);

  // Simple moving average
  const sma = closes.reduce((s, v) => s + v, 0) / period;

  // Standard deviation
  const variance = closes.reduce((s, v) => s + Math.pow(v - sma, 2), 0) / period;
  const stdDev   = Math.sqrt(variance);

  const upper = sma + 2 * stdDev;
  const lower = sma - 2 * stdDev;
  const currentClose = candles[candles.length - 1].close;

  const bbPctB   = stdDev === 0 ? 0.5 : (currentClose - lower) / (upper - lower);
  const bbWidth  = stdDev === 0 ? 0 : Math.round((upper - lower) / sma * 100 * 100) / 100; // as % of SMA

  // Position: 1 = near/above upper (overbought), -1 = near/below lower (oversold), 0 = middle
  const bbPosition = stdDev === 0 ? 0
    : currentClose >= upper - (stdDev * 0.2) ? 1
    : currentClose <= lower + (stdDev * 0.2) ? -1
    : 0;

  return {
    bb_pct_b:   Math.round(bbPctB * 1000) / 1000,   // e.g. 0.85 = near upper band
    bb_width:   bbWidth,                              // e.g. 5.2 = band is 5.2% wide
    bb_position: bbPosition,                          // -1, 0, or 1
    bb_upper:   Math.round(upper * 100) / 100,
    bb_lower:   Math.round(lower * 100) / 100,
    bb_mid:     Math.round(sma * 100) / 100,
  };
}

// ── Gap detection ─────────────────────────────────────────────────────────────
// candles: [{ open, close, date }] ordered oldest → newest
// A gap occurs when today's open is significantly different from yesterday's close
// Returns:
//   gap_pct:  gap size as % (positive = gap up, negative = gap down, 0 = no gap)
//   gap_flag: 1 if gap > threshold, 0 otherwise
//   gap_direction: 1 = gap up, -1 = gap down, 0 = no gap
function computeGapFlag(candles, threshold = 0.5) {
  if (!candles || candles.length < 2) return null;
  const today     = candles[candles.length - 1];
  const yesterday = candles[candles.length - 2];
  if (!today?.open || !yesterday?.close) return null;

  const gapPct = (today.open - yesterday.close) / yesterday.close * 100;
  const gapAbs = Math.abs(gapPct);

  return {
    gap_pct:       Math.round(gapPct * 100) / 100,
    gap_flag:      gapAbs >= threshold ? 1 : 0,
    gap_direction: gapAbs >= threshold ? (gapPct > 0 ? 1 : -1) : 0,
  };
}


async function fetchPriceHistories(token, symbols) {
  const results = {};
  await Promise.all(symbols.map(async symbol => {
    try {
      const url = `${SCHWAB_BASE}/marketdata/v1/pricehistory?symbol=${encodeURIComponent(symbol)}&periodType=month&period=3&frequencyType=daily&frequency=1&needExtendedHoursData=false`;
      const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      const data = await res.json();
      if (data?.candles?.length) {
        results[symbol] = data.candles.map(c => ({
          date: new Date(c.datetime).toISOString().slice(0, 10),
          open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
        }));
      }
    } catch(e) { console.warn(`[pricehistory] ${symbol} failed:`, e.message); }
  }));
  return results;
}

// ── Fetch live chain data for a single ticker from Schwab ────────────────────
// Used at signal-fire time to ensure IV/fib/bb/gap/sr factors are always fresh,
// independent of whether chain-refresh has run recently.
async function fetchLiveChain(token, symbol) {
  try {
    const url = `${SCHWAB_BASE}/marketdata/v1/chains?symbol=${encodeURIComponent(symbol)}&contractType=ALL&strikeCount=20`;
    const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!res.ok) { console.warn(`[fetchLiveChain] ${symbol} HTTP ${res.status}`); return {}; }
    const data = await res.json();
    const calls = [], puts = [];
    for (const [, strikes] of Object.entries(data?.callExpDateMap || {}))
      for (const [, opts] of Object.entries(strikes))
        for (const o of opts) calls.push({ strikePrice: o.strikePrice, bid: o.bid, ask: o.ask, last: o.last, mark: o.mark, delta: o.delta, volatility: o.volatility, totalVolume: o.totalVolume, openInterest: o.openInterest });
    for (const [, strikes] of Object.entries(data?.putExpDateMap || {}))
      for (const [, opts] of Object.entries(strikes))
        for (const o of opts) puts.push({ strikePrice: o.strikePrice, bid: o.bid, ask: o.ask, last: o.last, mark: o.mark, delta: o.delta, volatility: o.volatility, totalVolume: o.totalVolume, openInterest: o.openInterest });
    // Return in same format getAtmIv expects: { "SYMBOL|expiry": { calls, puts } }
    // Since we just need ATM IV we can use a single key
    return { [`${symbol.toUpperCase()}|live`]: { calls, puts } };
  } catch(e) {
    console.warn(`[fetchLiveChain] ${symbol} failed:`, e.message);
    return {};
  }
}

// ── Get ATM IV for a symbol from already-loaded chain data ────────────────────
function getAtmIv(chainData, symbol, stockPrice) {
  if (!chainData || !symbol || !stockPrice) return null;
  let bestIv = null, bestDist = Infinity;
  for (const [chainKey, chain] of Object.entries(chainData)) {
    const [chainTicker] = chainKey.split("|");
    if (chainTicker !== symbol.toUpperCase()) continue;
    for (const strike of (chain.calls || [])) {
      const dist = Math.abs(strike.strikePrice - stockPrice);
      if (dist < bestDist && strike.volatility != null) { bestDist = dist; bestIv = strike.volatility; }
    }
  }
  return bestIv != null ? Math.round(bestIv * 10) / 10 : null; // Schwab volatility already in % (e.g. 46.5 = 46.5%)
}

// ── Store daily IV reading + compute IV Rank / IV Percentile ─────────────────
// Called once per market-refresh run for each ticker.
// IV Rank:       (current IV - 52w low) / (52w high - 52w low) * 100
// IV Percentile: % of past readings where IV was lower than today
// ── SMA computation ───────────────────────────────────────────────────────────
function computeSMA(candles, period) {
  const closes = candles.slice(-period).map(c => c.close ?? c.closePrice ?? c[4] ?? 0).filter(v => v > 0);
  if (closes.length < period) return null;
  return Math.round(closes.reduce((s, v) => s + v, 0) / closes.length * 100) / 100;
}

function computeTrendFeatures(candles, stockPrice) {
  if (!candles?.length || !stockPrice) return {};
  const sma20  = computeSMA(candles, 20);
  const sma50  = computeSMA(candles, 50);
  const sma200 = computeSMA(candles, 200);
  const rsi14  = computeRSI(candles);
  // SMA alignment: 3=fully bullish (price>20>50>200), 0=fully bearish
  let smaAlignment = 0;
  if (sma20  && stockPrice > sma20)  smaAlignment++;
  if (sma50  && stockPrice > sma50)  smaAlignment++;
  if (sma200 && stockPrice > sma200) smaAlignment++;
  // Price position vs 50-day: positive = above, negative = below
  const pctVsSma50  = sma50  ? Math.round((stockPrice - sma50)  / sma50  * 10000) / 100 : null;
  const pctVsSma200 = sma200 ? Math.round((stockPrice - sma200) / sma200 * 10000) / 100 : null;
  // Trend regime: bullish / neutral / bearish
  const trendRegime = smaAlignment >= 3 ? "bullish" : smaAlignment <= 1 ? "bearish" : "neutral";
  return { sma20, sma50, sma200, rsi14, sma_alignment: smaAlignment, pct_vs_sma50: pctVsSma50, pct_vs_sma200: pctVsSma200, trend_regime: trendRegime };
}

async function computeAndStoreIVRank(symbol, ivPct, stockPrice) {
  if (!ivPct || !symbol) return null;

  // 1. Upsert today's reading (one per symbol per day)
  await fetch(`${SUPABASE_URL}/rest/v1/iv_history`, {
    method:  "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ symbol: symbol.toUpperCase(), iv_pct: ivPct, stock_price: stockPrice, date: new Date().toISOString().slice(0, 10) }),
  }).catch(e => console.warn(`[iv_history] write failed for ${symbol}:`, e.message));

  // 2. Fetch up to 252 trading days of history (1 year)
  const histRes = await fetch(
    `${SUPABASE_URL}/rest/v1/iv_history?select=iv_pct,date&symbol=eq.${symbol.toUpperCase()}&order=date.desc&limit=252`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  ).then(r => r.json()).catch(() => []);

  const history = Array.isArray(histRes) ? histRes.map(r => +r.iv_pct).filter(v => !isNaN(v)) : [];
  if (history.length < 5) return { iv_rank: null, iv_percentile: null, iv_history_days: history.length };

  const ivMin   = Math.min(...history);
  const ivMax   = Math.max(...history);
  const ivRange = ivMax - ivMin;

  const ivRank       = ivRange > 0 ? Math.round((ivPct - ivMin) / ivRange * 100) : 50;
  const ivPercentile = Math.round(history.filter(v => v < ivPct).length / history.length * 100);

  return {
    iv_rank:        ivRank,        // 0-100, higher = IV near yearly high = good to sell
    iv_percentile:  ivPercentile,  // 0-100, % of days with lower IV than today
    iv_history_days: history.length,
  };
}

// ── Detect Support & Resistance levels from daily candles ─────────────────────
// Uses swing high/low detection: a candle is a swing high if N candles on each
// side are all lower. Clusters nearby levels into zones.
// Returns nearest level and metadata for the SAGE scoring model.
function computeSupportResistance(candles, stockPrice, swingPeriod = 5, clusterPct = 1.5) {
  if (!candles || candles.length < swingPeriod * 2 + 1 || !stockPrice) return null;

  const swingHighs = [];
  const swingLows  = [];

  // Detect swing highs and lows
  for (let i = swingPeriod; i < candles.length - swingPeriod; i++) {
    const c = candles[i];
    const leftHighs  = candles.slice(i - swingPeriod, i).map(x => x.high);
    const rightHighs = candles.slice(i + 1, i + swingPeriod + 1).map(x => x.high);
    const leftLows   = candles.slice(i - swingPeriod, i).map(x => x.low);
    const rightLows  = candles.slice(i + 1, i + swingPeriod + 1).map(x => x.low);

    if (c.high > Math.max(...leftHighs) && c.high > Math.max(...rightHighs)) {
      swingHighs.push({ price: c.high, date: c.date });
    }
    if (c.low < Math.min(...leftLows) && c.low < Math.min(...rightLows)) {
      swingLows.push({ price: c.low, date: c.date });
    }
  }

  // Cluster nearby levels (within clusterPct% of each other)
  function clusterLevels(points) {
    if (!points.length) return [];
    const sorted = [...points].sort((a, b) => a.price - b.price);
    const clusters = [];
    let current = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const pct = (sorted[i].price - current[0].price) / current[0].price * 100;
      if (pct <= clusterPct) {
        current.push(sorted[i]);
      } else {
        clusters.push(current);
        current = [sorted[i]];
      }
    }
    clusters.push(current);
    return clusters.map(group => ({
      price:    Math.round(group.reduce((s, p) => s + p.price, 0) / group.length * 100) / 100,
      strength: group.length,
      first:    group[0].date,
      last:     group[group.length - 1].date,
    }));
  }

  const resistanceLevels = clusterLevels(swingHighs).filter(l => l.price > stockPrice);
  const supportLevels    = clusterLevels(swingLows).filter(l => l.price < stockPrice);

  // Find nearest resistance and support
  const nearestResistance = resistanceLevels.sort((a, b) => a.price - b.price)[0] || null;
  const nearestSupport    = supportLevels.sort((a, b) => b.price - a.price)[0] || null;

  // Determine which is closer
  const resDist = nearestResistance ? (nearestResistance.price - stockPrice) / stockPrice * 100 : Infinity;
  const supDist = nearestSupport    ? (stockPrice - nearestSupport.price)    / stockPrice * 100 : Infinity;

  const nearest     = resDist <= supDist ? nearestResistance : nearestSupport;
  const nearestType = resDist <= supDist ? "resistance"      : "support";
  const nearestDist = Math.min(resDist, supDist);

  return {
    sr_nearest_type:     nearestType,                                     // 'resistance' | 'support'
    sr_nearest_price:    nearest?.price ?? null,                          // price of nearest level
    sr_nearest_dist_pct: Math.round(nearestDist * 100) / 100,            // % distance from current price
    sr_nearest_strength: nearest?.strength ?? 0,                          // times price touched this level
    sr_near_resistance:  resDist < 2.0 ? 1 : 0,                          // within 2% of resistance
    sr_near_support:     supDist < 2.0 ? 1 : 0,                          // within 2% of support
    sr_resistance_price: nearestResistance?.price ?? null,
    sr_support_price:    nearestSupport?.price ?? null,
    sr_resistance_dist:  Math.round(resDist * 100) / 100,
    sr_support_dist:     Math.round(supDist * 100) / 100,
  };
}

// ── Store S/R levels to Supabase ──────────────────────────────────────────────
async function storeSupportResistance(symbol, srResult) {
  if (!srResult || !symbol) return;

  // Delete old levels for this symbol and re-insert fresh ones
  await fetch(`${SUPABASE_URL}/rest/v1/support_resistance?symbol=eq.${symbol.toUpperCase()}`, {
    method:  "DELETE",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  }).catch(e => console.warn(`[storeSupportResistance] DELETE failed for ${symbol}:`, e.message));

  const rows = [];
  if (srResult.sr_resistance_price) {
    rows.push({ symbol: symbol.toUpperCase(), level_price: srResult.sr_resistance_price, level_type: "resistance", strength: srResult.sr_nearest_strength || 1, updated_at: new Date().toISOString() });
  }
  if (srResult.sr_support_price) {
    rows.push({ symbol: symbol.toUpperCase(), level_price: srResult.sr_support_price, level_type: "support", strength: srResult.sr_nearest_strength || 1, updated_at: new Date().toISOString() });
  }
  if (rows.length) {
    await fetch(`${SUPABASE_URL}/rest/v1/support_resistance`, {
      method:  "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(rows),
    }).catch(e => console.warn(`[sr] store failed for ${symbol}:`, e.message));
  }
}

// ── Write scoring_factor_values for a signal ──────────────────────────────────
async function writeFactorValues(sigId, factors, capturedAt) {
  if (!sigId) return;
  const rows = Object.entries(factors)
    .filter(([, v]) => v != null)
    .map(([factor_name, value]) => ({ signal_id: sigId, factor_name, value: +value, captured_at: capturedAt }));
  if (!rows.length) return;
  await fetch(`${SUPABASE_URL}/rest/v1/scoring_factor_values`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  }).catch(e => console.warn("[market-refresh] scoring_factor_values write failed:", e.message));
}

// ── Should re-notify? ─────────────────────────────────────────────────────────
// Re-notify if: level escalated, profit improved by $50+, or profit% improved by 5%+
// Never re-notify within 60 minutes of last notification for same level
const RENOTIFY_DOLLARS  = 50;
const RENOTIFY_PCT      = 5;   // percentage points
const RENOTIFY_COOLDOWN = 60;  // minutes

function shouldNotify(signal, lastNotif) {
  if (!lastNotif) return true;  // never notified
  if (signal.level !== lastNotif.level) return true; // level escalated
  // EXPIRY_WAIT / WHEEL — notify once per day only
  if (["EXPIRY_WAIT","WHEEL_OTM","WHEEL_ITM"].includes(signal.level)) {
    const sentToday = lastNotif.sentAt?.slice(0, 10) === new Date().toISOString().slice(0, 10);
    return !sentToday;
  }
  // Cooldown — don't re-notify same level within 60 minutes
  if (lastNotif.sentAt) {
    const minsSince = (Date.now() - new Date(lastNotif.sentAt).getTime()) / 60000;
    if (minsSince < RENOTIFY_COOLDOWN) return false;
  }
  const profitImproved = signal.projectedProfit - (lastNotif.projectedProfit || 0) >= RENOTIFY_DOLLARS;
  const pctImproved    = signal.profitPct - (lastNotif.profitPct || 0) >= RENOTIFY_PCT;
  return profitImproved || pctImproved;
}

// ── Skynet controls check ─────────────────────────────────────────────────────
// Returns { ok: bool, reason: string }
function checkSkynetControls({ controls, limitPrice, qty, bid, ask, projectedProfit }) {
  if (!controls?.enabled) return { ok: true };
  const orderValue = Math.abs(limitPrice || 0) * (qty || 1) * 100;
  if (controls.max_order_value && orderValue > +controls.max_order_value) {
    return { ok: false, reason: `order value $${orderValue.toFixed(0)} > max $${controls.max_order_value}` };
  }
  if (controls.max_bid_ask_deviation_pct && bid != null && ask != null && ask > 0) {
    const mid = (bid + ask) / 2;
    const devPct = Math.abs(limitPrice - mid) / mid * 100;
    if (devPct > +controls.max_bid_ask_deviation_pct) {
      return { ok: false, reason: `limit $${limitPrice} deviates ${devPct.toFixed(1)}% from mid $${mid.toFixed(2)} (max ${controls.max_bid_ask_deviation_pct}%)` };
    }
  }
  if (controls.block_if_loss && projectedProfit != null && projectedProfit < 0) {
    return { ok: false, reason: `order would result in a loss ($${projectedProfit.toFixed(2)})` };
  }
  return { ok: true };
}

// ── Log signal to signal_log table ───────────────────────────────────────────
async function logSignal(fields) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/signal_log`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(fields),
    });
    const rows = await res.json();
    return rows?.[0]?.id ?? null;
  } catch(e) { console.warn("[signal_log] write failed:", e.message); return null; }
}


// ══════════════════════════════════════════════════════════════════════════════
// ── Simulation engine (action=simulate|status|summary|toppicks) ───────────────
// Replays option_snapshots with different strategy params to find optimal settings.
// Folded into market-refresh to avoid a separate API file (Vercel 12-file limit).
// ══════════════════════════════════════════════════════════════════════════════

const SIM_PARAM_GRID = {
  otm_pct:      [1.0, 2.0, 2.5, 3.5],
  target_pct:   [50, 65, 80],
  stop_pct:     [150, 200, 300],
  entry_hour:   [10, 11, 13],        // added 1pm ET entry
  dte_max:      [2, 5],
  day_of_week:  [null, 1, 2, 3, 4],  // null=any, 1=Mon, 2=Tue, 3=Wed, 4=Thu
  vix_regime:   [null, "low", "normal", "high"], // null=any, low<15, normal 15-25, high>25
  trend_regime: [null, "bullish", "neutral", "bearish"], // null=any
};

// VIX regime classifier
function classifyVix(vix) {
  if (!vix) return null;
  if (vix < 15) return "low";
  if (vix <= 25) return "normal";
  return "high";
}

function simGetETHour(isoString) {
  const et = new Date(new Date(isoString).toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.getHours();
}

function simGroupByDay(snapshots) {
  const days = {};
  for (const s of snapshots) {
    const day = s.snapshot_at.slice(0, 10);
    if (!days[day]) days[day] = [];
    days[day].push(s);
  }
  return days;
}

function simFindEntry(snapshots, targetOtmPct, dteMax) {
  const candidates = snapshots.filter(s =>
    s.dte != null && s.dte >= 1 && s.dte <= dteMax &&
    s.otm_pct != null && s.otm_pct >= 0 &&
    s.bid > 0 && s.ask > 0 && s.mid > 0
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => Math.abs(a.otm_pct - targetOtmPct) - Math.abs(b.otm_pct - targetOtmPct));
  return candidates[0];
}

function simDay(daySnapshots, params) {
  const { otm_pct, target_pct, stop_pct, entry_hour, dte_max, day_of_week, vix_regime, trend_regime } = params;
  const sorted = [...daySnapshots].sort((a, b) => new Date(a.snapshot_at) - new Date(b.snapshot_at));

  // Filter by day of week if specified
  if (day_of_week !== null && sorted.length) {
    const dow = new Date(sorted[0].snapshot_at).getDay();
    if (dow !== day_of_week) return null;
  }

  // Filter by VIX regime if specified
  if (vix_regime !== null && sorted.length) {
    const snapVix = sorted[0].vix;
    if (!snapVix || classifyVix(snapVix) !== vix_regime) return null;
  }

  // Filter by trend regime if specified
  if (trend_regime !== null && sorted.length) {
    const snapTrend = sorted[0].trend_regime;
    if (!snapTrend || snapTrend !== trend_regime) return null;
  }

  const entrySnaps = sorted.filter(s => simGetETHour(s.snapshot_at) === entry_hour);
  if (!entrySnaps.length) return null;

  const entry = simFindEntry(entrySnaps, otm_pct, dte_max);
  if (!entry?.mid) return null;

  const entryMid   = entry.mid;
  const targetClose = entryMid * (1 - target_pct / 100);
  const stopClose   = entryMid * (stop_pct / 100);

  const subsequent = sorted.filter(s =>
    s.snapshot_at > entry.snapshot_at &&
    Math.abs(s.strike - entry.strike) < 0.01 &&
    s.expiry === entry.expiry &&
    s.mid != null
  );

  let exitSnap = null, exitReason = null;
  for (const snap of subsequent) {
    if (snap.mid <= targetClose) { exitSnap = snap; exitReason = "target_hit"; break; }
    if (snap.mid >= stopClose)   { exitSnap = snap; exitReason = "stop_hit";   break; }
    if (snap.dte <= 0)           { exitSnap = snap; exitReason = snap.stock_price > snap.strike ? "expired_itm" : "expired_otm"; break; }
  }
  if (!exitSnap && subsequent.length) { exitSnap = subsequent[subsequent.length - 1]; exitReason = "eod"; }
  if (!exitSnap) return null;

  let exitMid = exitSnap.mid;
  if (exitReason === "expired_itm") exitMid = Math.max(exitMid, Math.max(exitSnap.stock_price - exitSnap.strike, 0));
  if (exitReason === "expired_otm") exitMid = 0;

  const profitPerContract = Math.round((entryMid - exitMid) * 100 * 100) / 100;
  const profitPct         = entryMid > 0 ? Math.round((profitPerContract / (entryMid * 100)) * 10000) / 100 : 0;

  return {
    entry_at: entry.snapshot_at, entry_stock_price: entry.stock_price,
    entry_mid: entryMid, entry_iv: entry.iv, entry_delta: entry.delta,
    entry_otm_pct: entry.otm_pct, entry_dte: entry.dte,
    exit_at: exitSnap.snapshot_at, exit_stock_price: exitSnap.stock_price,
    exit_mid: exitMid, exit_reason: exitReason,
    profit_per_contract: profitPerContract, profit_pct: profitPct,
    won: profitPerContract > 0,
    entry_snapshot_id: entry.id, exit_snapshot_id: exitSnap.id,
  };
}

async function simLoadSnapshots(symbol, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/option_snapshots?select=id,symbol,expiry,strike,opt_type,snapshot_at,dte,bid,ask,mid,iv,delta,open_interest,stock_price,stock_change_pct,otm_pct,vix,sma20,sma50,rsi14,sma_alignment,trend_regime,day_of_week&symbol=eq.${encodeURIComponent(symbol)}&opt_type=eq.call&snapshot_at=gte.${since}&order=snapshot_at.asc&limit=100000`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  return res.json();
}

async function runSimulations(symbol, days) {
  const snapshots = await simLoadSnapshots(symbol, days);
  if (!snapshots.length) return { symbol, trades: 0, variants: 0, top5_by_ev: [] };

  const byDay       = simGroupByDay(snapshots);
  const tradingDays = Object.keys(byDay).sort();

  const combos = [];
  for (const otm_pct      of SIM_PARAM_GRID.otm_pct)
  for (const target_pct   of SIM_PARAM_GRID.target_pct)
  for (const stop_pct     of SIM_PARAM_GRID.stop_pct)
  for (const entry_hour   of SIM_PARAM_GRID.entry_hour)
  for (const dte_max      of SIM_PARAM_GRID.dte_max)
  for (const day_of_week  of SIM_PARAM_GRID.day_of_week)
  for (const vix_regime   of SIM_PARAM_GRID.vix_regime)
  for (const trend_regime of SIM_PARAM_GRID.trend_regime)
    combos.push({ otm_pct, target_pct, stop_pct, entry_hour, dte_max, day_of_week, vix_regime, trend_regime });

  console.log(`[simulate] ${symbol}: ${combos.length} variants × ${tradingDays.length} days`);

  const allResults = [];
  for (const params of combos) {
    const label  = `otm${params.otm_pct}_tgt${params.target_pct}_stp${params.stop_pct}_h${params.entry_hour}_dte${params.dte_max}_dow${params.day_of_week??'any'}_vix${params.vix_regime??'any'}_trend${params.trend_regime??'any'}`;
    const trades = [];
    for (const day of tradingDays) {
      const result = simDay(byDay[day], params);
      if (result) trades.push({ ...result, symbol, opt_type: "call", sim_label: label, sim_params: params, run_at: new Date().toISOString() });
    }
    if (trades.length) allResults.push({ label, params, trades });
  }

  // Write sim_results
  const allRows = allResults.flatMap(r => r.trades);
  if (allRows.length) {
    await fetch(`${SUPABASE_URL}/rest/v1/sim_results?symbol=eq.${encodeURIComponent(symbol)}`, {
      method: "DELETE", headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    }).catch(e => console.warn(`[simulate] sim_results DELETE failed for ${symbol}:`, e.message));
    const CHUNK = 200;
    for (let i = 0; i < allRows.length; i += CHUNK) {
      await fetch(`${SUPABASE_URL}/rest/v1/sim_results`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(allRows.slice(i, i + CHUNK)),
      }).catch(e => console.warn("[simulate] sim_results write failed:", e.message));
    }
    console.log(`[simulate] ${symbol}: wrote ${allRows.length} trade rows`);
  }

  // Write sim_summary
  const summaryRows = [];
  for (const { label, params, trades } of allResults) {
    if (!trades.length) continue;
    const wins   = trades.filter(t => t.won);
    const losses = trades.filter(t => !t.won);
    const wr     = wins.length / trades.length;
    const avgProfit    = wins.length   ? wins.reduce((s,t)   => s + t.profit_per_contract, 0) / wins.length   : 0;
    const avgLoss      = losses.length ? losses.reduce((s,t) => s + t.profit_per_contract, 0) / losses.length : 0;
    const avgProfitPct = wins.length   ? wins.reduce((s,t)   => s + t.profit_pct, 0)          / wins.length   : 0;
    const avgLossPct   = losses.length ? losses.reduce((s,t) => s + t.profit_pct, 0)          / losses.length : 0;
    const ev           = (wr * avgProfit) + ((1 - wr) * avgLoss);
    const ivTrades     = trades.filter(t => t.entry_iv);
    summaryRows.push({
      sim_label:      label, symbol, updated_at: new Date().toISOString(),
      trade_count:    trades.length, win_count: wins.length,
      win_rate:       Math.round(wr * 10000) / 10000,
      avg_profit:     Math.round(avgProfit * 100) / 100,
      avg_profit_pct: Math.round(avgProfitPct * 100) / 100,
      avg_loss:       Math.round(avgLoss * 100) / 100,
      avg_loss_pct:   Math.round(avgLossPct * 100) / 100,
      ev:             Math.round(ev * 100) / 100,
      max_loss:       Math.round(Math.min(...trades.map(t => t.profit_per_contract)) * 100) / 100,
      max_profit:     Math.round(Math.max(...trades.map(t => t.profit_per_contract)) * 100) / 100,
      avg_dte_entry:  Math.round(trades.reduce((s,t) => s + (t.entry_dte||0), 0) / trades.length * 10) / 10,
      avg_iv_entry:   ivTrades.length ? Math.round(ivTrades.reduce((s,t) => s + t.entry_iv, 0) / ivTrades.length * 10) / 10 : null,
      sim_params:     params,
    });
  }
  if (summaryRows.length) {
    const CHUNK = 100;
    for (let i = 0; i < summaryRows.length; i += CHUNK) {
      await fetch(`${SUPABASE_URL}/rest/v1/sim_summary`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(summaryRows.slice(i, i + CHUNK)),
      }).catch(e => console.warn("[simulate] sim_summary write failed:", e.message));
    }
    console.log(`[simulate] ${symbol}: wrote ${summaryRows.length} summary rows`);
  }

  return {
    symbol, trading_days: tradingDays.length, variants: combos.length,
    trades: allRows.length, summaries: summaryRows.length,
    top5_by_ev: summaryRows
      .filter(s => s.trade_count >= 5)
      .sort((a, b) => b.ev - a.ev)
      .slice(0, 5)
      .map(s => ({ label: s.sim_label, ev: s.ev, win_rate: (s.win_rate*100).toFixed(1)+"%", avg_profit: "$"+s.avg_profit, avg_loss: "$"+s.avg_loss, trades: s.trade_count, params: s.sim_params })),
  };
}

async function simGetStatus() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/option_snapshots?select=symbol,snapshot_at&order=snapshot_at.desc&limit=20000`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  const bySymbol = {};
  for (const r of rows) {
    const day = r.snapshot_at.slice(0, 10);
    if (!bySymbol[r.symbol]) bySymbol[r.symbol] = new Set();
    bySymbol[r.symbol].add(day);
  }
  return Object.entries(bySymbol).map(([symbol, days]) => ({
    symbol, days_collected: days.size,
    earliest: [...days].sort()[0],
    latest:   [...days].sort().reverse()[0],
  })).sort((a, b) => b.days_collected - a.days_collected);
}

async function handleSimulate(req, res) {
  const action = req.query.action;
  const days   = parseInt(req.query.days || "30", 10);

  if (action === "status") {
    const coverage = await simGetStatus();
    return res.status(200).json({ ok: true, coverage });
  }

  if (action === "summary") {
    const symbol = req.query.symbol?.toUpperCase();
    if (!symbol) return res.status(400).json({ error: "symbol required" });
    const rows = await fetch(
      `${SUPABASE_URL}/rest/v1/sim_summary?symbol=eq.${encodeURIComponent(symbol)}&order=ev.desc&limit=144`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    ).then(r => r.json());
    return res.status(200).json({ ok: true, symbol, count: rows.length, results: rows });
  }

  if (action === "toppicks") {
    const rows = await fetch(
      `${SUPABASE_URL}/rest/v1/sim_summary?order=ev.desc&limit=500`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    ).then(r => r.json());
    const bySymbol = {};
    for (const r of rows) {
      if (r.trade_count < 5) continue;
      if (!bySymbol[r.symbol] || r.ev > bySymbol[r.symbol].ev) bySymbol[r.symbol] = r;
    }
    const picks = Object.values(bySymbol).sort((a, b) => b.ev - a.ev).slice(0, 20);
    return res.status(200).json({ ok: true, picks });
  }

  if (action === "simulate") {
    const symbol = req.query.symbol?.toUpperCase();
    if (!symbol) return res.status(400).json({ error: "symbol required" });
    console.log(`[simulate] Running ${symbol} over last ${days} days...`);
    const result = await runSimulations(symbol, days);
    return res.status(200).json({ ok: true, ...result });
  }

  if (action === "simulateall") {
    const coverage = await simGetStatus();
    const symbols  = coverage.filter(s => s.days_collected >= 3).map(s => s.symbol);
    console.log(`[simulate] Running all ${symbols.length} symbols...`);
    const results = [];
    for (const symbol of symbols) {
      try   { results.push(await runSimulations(symbol, days)); }
      catch(e) { results.push({ symbol, error: e.message }); }
    }
    return res.status(200).json({ ok: true, symbols: symbols.length, total_trades: results.reduce((s,r) => s+(r.trades||0),0), results });
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}

// ── Chase loop — step down limit price on active chase orders ─────────────────
async function runChaseLoop(token, sbHeaders) {
  try {
    // Load all active chase orders that are submitted (not yet filled/cancelled)
    const chaseRes = await fetch(
      `${SUPABASE_URL}/rest/v1/trade_orders?chase_active=eq.true&status=in.(submitted,pending_approval,dry_run_approved)&order=created_at.desc`,
      { headers: sbHeaders }
    );
    const chaseOrders = await chaseRes.json();
    if (!chaseOrders?.length) return;

    console.log(`[market-refresh] chase loop: ${chaseOrders.length} active chase order(s)`);

    for (const order of chaseOrders) {
      try {
        // Fetch live bid/ask for this option
        const osi = `${order.ticker?.toUpperCase().padEnd(6)}${order.expires?.replace(/-/g,"").slice(2)}${order.type === "Call" ? "C" : "P"}${String(Math.round((+order.strike) * 1000)).padStart(8,"0")}`;
        const qRes  = await fetch(
          `${SCHWAB_BASE}/marketdata/v1/quotes?symbols=${encodeURIComponent(osi)}&fields=quote&indicative=false`,
          { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
        );
        const qData = qRes.ok ? await qRes.json() : {};
        const q     = qData?.[osi]?.quote;
        if (!q) { console.warn(`[chase] no quote for ${osi}`); continue; }

        const bid = q.bidPrice ?? 0;
        const ask = q.askPrice ?? 0;

        // If Schwab shows the order as filled, stop chasing and mark accordingly
        if (order.schwab_order_id) {
          const hash = order.account?.includes("ETrade") ? null : "757F62A9417DA1B75005EAC7370D033ABF819061E60384AA3B0F68A0AAE94961 /* TODO: fetch dynamically via getAccountHash() instead of hardcoding */";
          if (hash) {
            const statusRes = await fetch(
              `${SCHWAB_BASE}/trader/v1/accounts/${hash}/orders/${order.schwab_order_id}`,
              { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
            ).catch(() => null);
            if (statusRes?.ok) {
              const schwabOrder = await statusRes.json().catch(() => null);
              if (schwabOrder?.status === "FILLED") {
                const leg = schwabOrder.orderActivityCollection?.[0];
                await fetch(`${SUPABASE_URL}/rest/v1/trade_orders?id=eq.${order.id}`, {
                  method: "PATCH",
                  headers: { ...sbHeaders, Prefer: "return=minimal" },
                  body: JSON.stringify({
                    status:       "filled",
                    chase_active: false,
                    filled_at:    new Date().toISOString(),
                    fill_price:   leg?.executionLegs?.[0]?.price ?? null,
                    fill_qty:     schwabOrder.filledQuantity ?? order.qty,
                  }),
                });
                console.log(`[chase] order ${order.id} already FILLED at Schwab — chase stopped`);
                continue;
              }
            }
          }
        }

        // For STO (selling): target just below ask so we're most competitive
        // For BTC/BTO (buying): target just above bid
        const isSell    = ["STO","STC"].includes(order.opt_type);
        const rawTarget = isSell ? ask - 0.01 : bid + 0.01;

        // Round to nearest step
        const step      = +(order.chase_step || 0.05);
        const newPrice  = Math.round(rawTarget / step) * step;
        const floor     = +(order.chase_floor || 0);

        // Floor hit — stop chasing
        if ((isSell && newPrice <= floor) || (!isSell && newPrice >= floor)) {
          await fetch(`${SUPABASE_URL}/rest/v1/trade_orders?id=eq.${order.id}`, {
            method: "PATCH",
            headers: { ...sbHeaders, Prefer: "return=minimal" },
            body: JSON.stringify({ chase_active: false }),
          });
          await sendPushover(
            `🛑 Chase Floor Hit: ${order.ticker}`,
            `${order.opt_type} ${order.ticker} $${order.strike} ${order.type} ${order.expires} · Floor $${floor.toFixed(2)} reached · Chase stopped`,
            `${APP_URL}/?tab=contracts`, "View Orders", 1
          );
          console.log(`[chase] floor hit for order ${order.id} — chase stopped`);
          continue;
        }

        // No change needed — already at or better than target
        const currentPrice = +(order.limit_price || 0);
        if (Math.abs(newPrice - currentPrice) < 0.005) {
          console.log(`[chase] order ${order.id} already at target $${newPrice.toFixed(2)}`);
          continue;
        }

        console.log(`[chase] order ${order.id} ${order.ticker}: ${currentPrice.toFixed(2)} → ${newPrice.toFixed(2)} (bid=${bid} ask=${ask})`);

        // Cancel existing Schwab order if submitted
        if (order.schwab_order_id && order.status === "submitted") {
          const hash = order.account?.includes("ETrade") ? null : "757F62A9417DA1B75005EAC7370D033ABF819061E60384AA3B0F68A0AAE94961 /* TODO: fetch dynamically via getAccountHash() instead of hardcoding */";
          if (hash) {
            const cancelRes = await fetch(
              `${SCHWAB_BASE}/trader/v1/accounts/${hash}/orders/${order.schwab_order_id}`,
              { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
            );
            if (cancelRes.status !== 200 && cancelRes.status !== 204) {
              console.warn(`[chase] cancel failed for order ${order.id}: HTTP ${cancelRes.status}`);
              continue;
            }
          }
        }

        // Resubmit at new price
        const instruction = { STO:"SELL_TO_OPEN", BTO:"BUY_TO_OPEN", STC:"SELL_TO_CLOSE", BTC:"BUY_TO_CLOSE" }[order.opt_type];
        const payload = {
          orderType: "LIMIT", session: "NORMAL", duration: "DAY",
          price: newPrice.toFixed(2),
          orderLegCollection: [{
            instruction,
            quantity: order.qty,
            instrument: { symbol: osi, assetType: "OPTION" },
          }],
        };
        const hash = "757F62A9417DA1B75005EAC7370D033ABF819061E60384AA3B0F68A0AAE94961 /* TODO: fetch dynamically via getAccountHash() instead of hardcoding */";
        const submitRes = await fetch(
          `${SCHWAB_BASE}/trader/v1/accounts/${hash}/orders`,
          { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) }
        );
        const newSchwabOrderId = submitRes.headers.get("Location")?.split("/").pop() ?? null;
        if (submitRes.status !== 201) {
          const body = await submitRes.text().catch(()=>"");
          console.warn(`[chase] resubmit failed for order ${order.id}: ${body}`);
          continue;
        }

        // Update DB with new price + new Schwab order ID
        await fetch(`${SUPABASE_URL}/rest/v1/trade_orders?id=eq.${order.id}`, {
          method: "PATCH",
          headers: { ...sbHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({
            limit_price:     newPrice,
            schwab_order_id: newSchwabOrderId,
            submitted_at:    new Date().toISOString(),
          }),
        });
        console.log(`[chase] order ${order.id} resubmitted at $${newPrice.toFixed(2)}, new Schwab ID: ${newSchwabOrderId}`);

      } catch(e) { console.warn(`[chase] error on order ${order.id}:`, e.message); }
    }
  } catch(e) { console.warn("[chase] runChaseLoop failed:", e.message); }
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const secret   = process.env.CRON_SECRET;
  const provided = req.headers["x-cron-secret"] || req.query.secret;
  if (secret && provided !== secret) return res.status(401).json({ error: "Unauthorized" });

  // ── Simulation actions — route to handleSimulate, bypass market hours gate ──
  const simActions = ["simulate","simulateall","status","summary","toppicks"];
  if (simActions.includes(req.query.action)) return handleSimulate(req, res);

  const forceRun = req.query.force === "1";
  if (!forceRun && !isMarketHours()) return res.status(200).json({ skipped: true, reason: "Outside market hours" });

  try {
    // ── Check ETrade token age — alert if from previous day ─────────────────
    try {
      const etTokenRes = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.etrade_tokens`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
      const etToken    = (await etTokenRes.json())?.[0]?.cols;
      if (etToken?.savedAt) {
        const nowET    = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
        const savedET  = new Date(new Date(etToken.savedAt).toLocaleString("en-US", { timeZone: "America/New_York" }));
        const sameDay  = savedET.toDateString() === nowET.toDateString();
        const hourET   = nowET.getHours();
        // Alert once in the morning (9-10am ET) if token is stale
        if (!sameDay && hourET >= 9 && hourET < 10) {
          await sendPushover("⚠️ ETrade Re-Auth Required", `Token from ${savedET.toDateString()} — tap to re-authorize before market open`, `${APP_URL}/api/etrade?action=auth&secret=${process.env.CRON_SECRET}`, "Re-Authorize ETrade", 1);
        }
      }
    } catch(e) { console.warn("[market-refresh] ETrade token check failed:", e.message); }

    // ── Check Schwab refresh token expiry — warn if within 3 days ──────────
    try {
      const SCHWAB_AUTH_URL = "https://options-tracker-five.vercel.app/api/schwab-auth";
      const stRes  = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_tokens`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
      const st     = (await stRes.json())?.[0]?.cols;
      if (st?.refreshTokenExpiresAt) {
        const msTilExpiry = st.refreshTokenExpiresAt - Date.now();
        const daysTil     = msTilExpiry / 86400000;
        if (daysTil <= 3 && daysTil > 0) {
          // Notify once per day — check last warn date stored in col_prefs
          const warnRes  = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_token_warn`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
          const warnData = (await warnRes.json())?.[0]?.cols;
          const todayStr = new Date().toISOString().slice(0, 10);
          if (warnData?.lastNotified !== todayStr) {
            const daysLabel = daysTil < 1 ? "< 1 day" : `${Math.ceil(daysTil)} day${Math.ceil(daysTil) === 1 ? "" : "s"}`;
            await sendPushover("⚠️ Schwab Token Expires Soon", `Refresh token expires in ${daysLabel} — re-authorize now to avoid interruption`, SCHWAB_AUTH_URL, "Re-Authorize Schwab", 1);
            await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
              method: "POST",
              headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
              body: JSON.stringify({ id: "schwab_token_warn", cols: { lastNotified: todayStr }, updated_at: new Date().toISOString() }),
            });
            console.log(`[market-refresh] Schwab token expiry warning sent (expires in ${daysLabel})`);
          }
        }
      }
    } catch(e) { console.warn("[market-refresh] Schwab token check failed:", e.message); }

    const token = await getValidToken();

    // ── Load everything in parallel ─────────────────────────────────────────
    const [contractsRes, chainRes, notifRes, matrixRes, allPositions, signalRulesRes, momentumConfigRes, priceHistoryRes, watchlistRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/contracts?select=id,stock,type,opt_type,strike,expires,premium,qty,account,stop_loss_multiplier,time_stop_dte,delta_stop,last_exit_alert_at&status=eq.Open`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }),
      fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.last_chain_refresh`,   { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }),
      fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.notifications_sent`,   { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }),
      fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.dte_matrix`,           { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }),
      fetchAllPositions(token),
      fetch(`${SUPABASE_URL}/rest/v1/signal_rules?enabled=eq.true&order=priority.desc`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }),
      fetch(`${SUPABASE_URL}/rest/v1/sto_momentum_config?enabled=eq.true&limit=1`,      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }),
      // Load last 35 mins of price snapshots for momentum calculation
      fetch(`${SUPABASE_URL}/rest/v1/price_snapshots?captured_at=gte.${new Date(Date.now()-35*60000).toISOString()}&order=captured_at.desc`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }),
      // Load watchlist tickers so they get snapshots + DANI history
      fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.watchlist`,            { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }),
    ]);

    const contracts      = await contractsRes.json();
    const chainData      = (await chainRes.json())?.[0]?.cols?.chains || {};
    const matrix         = (await matrixRes.json())?.[0]?.cols || null;
    const signalRules    = await signalRulesRes.json();
    const momentumConfig = (await momentumConfigRes.json())?.[0] || null;
    const priceHistory   = await priceHistoryRes.json();
    const watchlistTickers = ((await watchlistRes.json())?.[0]?.cols?.tickers || []).map(t => t.toUpperCase());

    // Load Skynet controls
    let skynetControls = { max_order_value: 10000, max_bid_ask_deviation_pct: 15, block_if_loss: true, enabled: true };
    try {
      const scRes = await fetch(`${SUPABASE_URL}/rest/v1/skynet_controls?enabled=eq.true&limit=1`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
      const scRows = await scRes.json();
      if (Array.isArray(scRows) && scRows.length) skynetControls = scRows[0];
    } catch(e) { console.warn("[market-refresh] skynet_controls load failed:", e.message); }

    if (!contracts.length && !allPositions.length && !watchlistTickers.length) return res.status(200).json({ ok: true, tickers: 0 });

    const contractTickers = [...new Set(contracts.map(c => c.stock?.toUpperCase()).filter(Boolean))];
    const positionTickers = [...new Set(allPositions.map(p => p.symbol).filter(Boolean))];
    const tickers = [...new Set([...contractTickers, ...positionTickers, ...watchlistTickers])];

    // ── Fetch stock quotes ──────────────────────────────────────────────────
    const qRes = await fetch(`${SCHWAB_BASE}/marketdata/v1/quotes?symbols=${tickers.join(",")}&fields=quote&indicative=false`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const qData = await qRes.json();

    // ── Fetch daily candles for RSI + Fibonacci (all tickers in parallel) ──
    const dailyCandles = await fetchPriceHistories(token, tickers);
    console.log(`[market-refresh] daily candles: ${Object.keys(dailyCandles).join(", ")}`);

    // ── Compute + store IV rank and S/R for all tickers ──────────────────────
    // Run in background (no await) to avoid slowing the main signal path.
    // Results are stored to Supabase and used by SAGE scanner on next scan.
    const ivRankCache = {};
    const srCache     = {};
    await Promise.all(tickers.map(async sym => {
      try {
        const q2        = (await (async()=>null)()); // placeholder — quotes not yet built
        const candles   = dailyCandles[sym] || [];
        const srResult  = computeSupportResistance(candles, null); // price injected below after quotes
        srCache[sym]    = srResult;
      } catch(e) { console.warn(`[market-refresh] S/R pre-compute failed for ${sym}:`, e.message); }
    }));

    const quotes = {};
    for (const [sym, entry] of Object.entries(qData || {})) {
      const q = entry?.quote ?? entry;
      if (!q) continue;
      quotes[sym.toUpperCase()] = {
        lastPrice:   q.lastPrice  ?? q.mark       ?? null,
        bid:         q.bidPrice   ?? null,
        ask:         q.askPrice   ?? null,
        changeClose: q.netChange  ?? null,
        changePct:   q.netPercentChange != null ? q.netPercentChange / 100 : null,
        dayHigh:     q.highPrice  ?? null,
        dayLow:      q.lowPrice   ?? null,
        openPrice:   q.openPrice  ?? null,
        volume:      q.totalVolume ?? null,
      };
    }

    const lastRefresh = new Date().toISOString();

    // ── Compute IV rank + S/R now that quotes + chainData are both available ─
    await Promise.all(tickers.map(async sym => {
      try {
        const stockPrice = quotes[sym]?.lastPrice;
        if (!stockPrice) return;
        const candles = dailyCandles[sym] || [];

        // IV rank — store today's reading + compute vs history
        const ivPct = getAtmIv(chainData, sym, stockPrice);
        if (ivPct) {
          const ivRank = await computeAndStoreIVRank(sym, ivPct, stockPrice);
          if (ivRank) ivRankCache[sym] = ivRank;
        }

        // S/R detection
        const srResult = computeSupportResistance(candles, stockPrice);
        if (srResult) {
          srCache[sym] = srResult;
          await storeSupportResistance(sym, srResult);
        }
      } catch(e) { console.warn(`[iv_sr] ${sym} failed:`, e.message); }
    }));
    console.log(`[market-refresh] IV rank: ${Object.keys(ivRankCache).join(", ") || "none"}`);
    console.log(`[market-refresh] S/R: ${Object.keys(srCache).filter(k=>srCache[k]).join(", ") || "none"}`);

    // Fetch pending orders once at outer scope — used by btc_auto scanner
    let pendingContractIds = new Set();
    try {
      const pendingOrders = await fetch(
        `${SUPABASE_URL}/rest/v1/trade_orders?select=contract_id&status=in.(pending_approval,submitted)`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      ).then(r => r.json());
      pendingContractIds = new Set((Array.isArray(pendingOrders) ? pendingOrders : []).map(o => String(o.contract_id)));
    } catch(e) { console.warn("[market-refresh] pending orders fetch failed:", e.message); }

    // ── Write price snapshots for momentum tracking ─────────────────────────
    try {
      const snapshotRows = Object.entries(quotes)
        .filter(([, q]) => q.lastPrice != null || q.mark != null)
        .map(([sym, q]) => ({
          symbol:      sym,
          price:       q.lastPrice ?? q.mark,
          change_pct:  q.changePct != null ? q.changePct * 100 : null,
          day_high:    q.dayHigh,
          day_low:     q.dayLow,
          open_price:  q.openPrice,
          volume:      q.volume,
          captured_at: lastRefresh,
        }));
      if (snapshotRows.length) {
        const psRes = await fetch(`${SUPABASE_URL}/rest/v1/price_snapshots`, {
          method: "POST",
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify(snapshotRows),
        });
        if (!psRes.ok) {
          const psErr = await psRes.text();
          console.warn(`[market-refresh] price_snapshots insert failed (${psRes.status}): ${psErr}`);
        } else {
          console.log(`[market-refresh] price_snapshots: wrote ${snapshotRows.length} rows`);
        }
        // Purge snapshots older than 2 days
        await fetch(`${SUPABASE_URL}/rest/v1/price_snapshots?captured_at=lt.${new Date(Date.now() - 2*86400000).toISOString()}`, {
          method: "DELETE",
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        });
      }
    } catch(e) { console.warn("[market-refresh] price snapshot write failed:", e.message); }

    // ── Pre-compute trend features per symbol (used by snapshots + STO scanner) ──
    const trendBySymbol = {};
    for (const sym of Object.keys(dailyCandles)) {
      trendBySymbol[sym] = computeTrendFeatures(dailyCandles[sym] || [], quotes[sym]?.lastPrice);
    }

    // ── Write option chain snapshots for simulation ─────────────────────────
    // Fetches live chains for all open-position tickers, stores 8 OTM + 8 ITM
    // strikes per side (call/put) every market-refresh cycle.
    // This data feeds simulate.js for strategy backtesting against real prices.
    // Note: no market hours gate — cron schedule controls when this runs
    if (true) {
      try {
        const SNAP_STRIKES_EACH_SIDE = 8; // 8 OTM + 8 ITM per call/put side
        const optionSnapshotRows = [];
        const snapshotAt = lastRefresh;

        // Use contract tickers only (they have live positions we care about)
        // Plus any position tickers that might not have contracts yet today
        // Fall back to a default list if no open positions (e.g. outside market hours testing)
        const DEFAULT_SNAP_TICKERS = ["AAPL","AMZN","NVDA","JPM","OKLO","WDC","AMD","MSFT","TSLA","SPY","GEV"];
        // RESEARCH_TICKERS: always snapshot these regardless of open positions (BTO candidates, validation)
        const RESEARCH_TICKERS = ["GEV"];
        const snapTickers = [...new Set([...contractTickers, ...positionTickers])];
        const finalSnapTickers = [...new Set([...(snapTickers.length ? snapTickers : DEFAULT_SNAP_TICKERS), ...RESEARCH_TICKERS])];
        console.log(`[option-snapshot] scanning ${finalSnapTickers.length} tickers: ${finalSnapTickers.join(", ")}`);

        // Fetch VIX for snapshot context (hoisted vix not yet available at this point)
        let snapVix = null;
        try {
          const vixRes  = await fetch(`${SCHWAB_BASE}/marketdata/v1/quotes?symbols=%24VIX&fields=quote&indicative=false`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
          const vixData = await vixRes.json();
          snapVix = vixData?.["$VIX"]?.quote?.lastPrice ?? vixData?.["$VIX"]?.lastPrice ?? null;
        } catch(e) { console.warn("[market-refresh] VIX fetch for snapshots failed:", e.message); }

        // trendBySymbol hoisted to handler scope for STO scanner access

        await Promise.all(finalSnapTickers.map(async symbol => {
          try {
            const stockPrice = quotes[symbol]?.lastPrice;
            const changePct  = quotes[symbol]?.changePct != null ? quotes[symbol].changePct * 100 : null;
            if (!stockPrice) return;

            // Fetch live chain — strikeCount=20 gives 10 each side of ATM
            // We request 20 to ensure we get 8 OTM + 8 ITM even with gaps
            const chainUrl = `${SCHWAB_BASE}/marketdata/v1/chains?symbol=${encodeURIComponent(symbol)}&contractType=ALL&strikeCount=20`;
            const chainRes  = await fetch(chainUrl, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
            if (!chainRes.ok) return;
            const chainData2 = await chainRes.json();

            // Helper: process one side (calls or puts)
            const processside = (expDateMap, side) => {
              for (const [expDateKey, strikes] of Object.entries(expDateMap || {})) {
                // expDateKey format: "2026-05-22:1" — extract date
                const expiry = expDateKey.split(":")[0];
                const today2 = new Date().toISOString().slice(0, 10);
                if (expiry < today2) continue; // skip expired

                const dte = Math.ceil((new Date(expiry) - new Date()) / 86400000);

                // Collect all strikes for this expiry
                const allOpts = [];
                for (const [, opts] of Object.entries(strikes)) {
                  for (const o of opts) {
                    const otmPct = side === 'call'
                      ? (o.strikePrice - stockPrice) / stockPrice * 100
                      : (stockPrice - o.strikePrice) / stockPrice * 100;
                    allOpts.push({ o, otmPct });
                  }
                }

                // Sort by distance from ATM
                allOpts.sort((a, b) => Math.abs(a.otmPct) - Math.abs(b.otmPct));

                // Take 8 OTM + 8 ITM
                const otmOpts = allOpts.filter(x => x.otmPct >= 0).slice(0, SNAP_STRIKES_EACH_SIDE);
                const itmOpts = allOpts.filter(x => x.otmPct < 0).slice(0, SNAP_STRIKES_EACH_SIDE);
                const selected = [...otmOpts, ...itmOpts];

                for (const { o, otmPct } of selected) {
                  const mid = o.bid != null && o.ask != null ? Math.round(((o.bid + o.ask) / 2) * 10000) / 10000 : null;
                  optionSnapshotRows.push({
                    symbol,
                    expiry,
                    strike:           o.strikePrice,
                    opt_type:         side,
                    snapshot_at:      snapshotAt,
                    dte,
                    bid:              o.bid,
                    ask:              o.ask,
                    mid,
                    last:             o.last,
                    mark:             o.mark,
                    iv:               o.volatility,
                    delta:            o.delta,
                    gamma:            o.gamma,
                    theta:            o.theta,
                    vega:             o.vega,
                    open_interest:    o.openInterest,
                    volume:           o.totalVolume,
                    stock_price:      stockPrice,
                    stock_change_pct: changePct,
                    otm_pct:          Math.round(otmPct * 100) / 100,
                    // Trend features for DANI ML
                    vix:              snapVix,
                    sma20:            trendBySymbol[symbol]?.sma20 ?? null,
                    sma50:            trendBySymbol[symbol]?.sma50 ?? null,
                    sma200:           trendBySymbol[symbol]?.sma200 ?? null,
                    rsi14:            trendBySymbol[symbol]?.rsi14 ?? null,
                    sma_alignment:    trendBySymbol[symbol]?.sma_alignment ?? null,
                    pct_vs_sma50:     trendBySymbol[symbol]?.pct_vs_sma50 ?? null,
                    pct_vs_sma200:    trendBySymbol[symbol]?.pct_vs_sma200 ?? null,
                    trend_regime:     trendBySymbol[symbol]?.trend_regime ?? null,
                    day_of_week:      new Date(snapshotAt).getDay(),
                  });
                }
              }
            };

            processside(chainData2.callExpDateMap, 'call');
            processside(chainData2.putExpDateMap,  'put');

          } catch(e) { console.warn(`[option-snapshot] ${symbol} failed:`, e.message); }
        }));

        if (optionSnapshotRows.length) {
          // Batch insert in chunks of 500 to stay within Supabase limits
          const CHUNK = 500;
          for (let i = 0; i < optionSnapshotRows.length; i += CHUNK) {
            await fetch(`${SUPABASE_URL}/rest/v1/option_snapshots`, {
              method: "POST",
              headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
              body: JSON.stringify(optionSnapshotRows.slice(i, i + CHUNK)),
            });
          }
          console.log(`[option-snapshot] wrote ${optionSnapshotRows.length} rows for ${finalSnapTickers.join(", ")}`);
        }

        // Purge snapshots older than 90 days
        await fetch(`${SUPABASE_URL}/rest/v1/option_snapshots?snapshot_at=lt.${new Date(Date.now() - 90*86400000).toISOString()}`, {
          method: "DELETE",
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        }).catch(e => console.warn("[option-snapshot] purge failed:", e.message));

      } catch(e) { console.warn("[option-snapshot] write failed:", e.message); }
    }

    const today       = lastRefresh.slice(0, 10);

    // ── Save quotes ─────────────────────────────────────────────────────────
    const sdRes     = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.stocks_data`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    const existing  = (await sdRes.json())?.[0]?.cols || {};
    const updatedSD = { ...existing };

    // Merge position share counts — group by symbol across all accounts
    const sharesBySymbol = {}; // { AMZN: { "Schwab 3866": 700, "ETrade 6917": 300 } }
    for (const p of allPositions) {
      if (!sharesBySymbol[p.symbol]) sharesBySymbol[p.symbol] = {};
      sharesBySymbol[p.symbol][p.account] = (sharesBySymbol[p.symbol][p.account] || 0) + p.qty;
    }

    // Merge into updatedSD — update all tickers we have positions in (not just open-contract tickers)
    for (const [symbol, acctMap] of Object.entries(sharesBySymbol)) {
      const totalShares = Object.values(acctMap).reduce((s, n) => s + n, 0);
      updatedSD[symbol] = {
        ...(updatedSD[symbol] || {}),
        shares:        totalShares,
        sharesByAcct:  acctMap,
        sharesUpdatedAt: lastRefresh,
      };
    }
    // Clear shares for tickers no longer held
    for (const sym of Object.keys(updatedSD)) {
      if (updatedSD[sym]?.shares != null && !sharesBySymbol[sym]) {
        updatedSD[sym] = { ...updatedSD[sym], shares: 0, sharesByAcct: {}, sharesUpdatedAt: lastRefresh };
      }
    }

    for (const [ticker, q] of Object.entries(quotes)) {
      if (q.lastPrice != null) {
        updatedSD[ticker] = { ...(updatedSD[ticker] || {}), currentPrice: q.lastPrice, bid: q.bid, ask: q.ask, changeClose: q.changeClose, changePct: q.changePct, lastQuoteAt: lastRefresh };
      }
    }

    await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id: "last_market_refresh", cols: { quotes, lastRefresh }, updated_at: lastRefresh }),
      }),
      fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id: "stocks_data", cols: updatedSD, updated_at: lastRefresh }),
      }),
    ]);

    // ── Load notification state ─────────────────────────────────────────────
    let sentData = (await notifRes.json())?.[0]?.cols || {};
    // Reset daily — but keep per-contract state within the day
    if (sentData.date !== today) sentData = { date: today, contracts: {} };
    if (!sentData.contracts) sentData.contracts = {};

    // ── Market hours gate — no notifications before 9:35am ET ───────────────
    const etForGate  = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const etGateMins = etForGate.getHours() * 60 + etForGate.getMinutes();
    const MARKET_OPEN_MINS = 9 * 60 + 35; // 9:35am ET
    const MARKET_CLOSE_MINS = 16 * 60;    // 4:00pm ET
    const isMarketOpen = etGateMins >= MARKET_OPEN_MINS && etGateMins <= MARKET_CLOSE_MINS;

    if (!isMarketOpen) {
      console.log(`[market-refresh] outside market hours (${etForGate.toTimeString().slice(0,5)} ET) — skipping all signal notifications`);
    }

    // ── Hoist etNow and vix to top-level scope — used by all scanner blocks ──
    const etNow = etForGate; // same timestamp, reuse
    let vix = null;
    try {
      const vixRes  = await fetch(`${SCHWAB_BASE}/marketdata/v1/quotes?symbols=$VIX&fields=quote&indicative=false`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      const vixData = await vixRes.json();
      vix = vixData?.["$VIX"]?.quote?.lastPrice ?? vixData?.["$VIX"]?.lastPrice ?? null;
      if (vix) console.log(`[market-refresh] VIX: ${vix.toFixed(2)}`);
    } catch(e) { console.warn("[market-refresh] VIX fetch failed:", e.message); }

    // ── Evaluate signals ────────────────────────────────────────────────────
    const notifications = [];

    if (isMarketOpen) {
    for (const contract of contracts) {
      // Only evaluate close signals for STO contracts — never BTO/long positions
      if (contract.opt_type !== "STO") continue;
      if (!contract.stock || !contract.premium) continue;
      const stockPrice = quotes[contract.stock.toUpperCase()]?.lastPrice;
      if (!stockPrice) continue;

      // Look up chain entry for this contract's exact strike
      const chainKey   = `${contract.stock.toUpperCase()}|${contract.expires}`;
      const chain      = chainData[chainKey];
      const side       = contract.type === "Call" ? "calls" : "puts";
      const chainEntry = chain?.[side]?.find(o => Math.abs(+o.strikePrice - +contract.strike) < 0.01);

      const signal = evaluateSignal(contract, chainEntry, stockPrice, matrix, quotes);
      if (!signal) continue;

      console.log(`[signal] ${contract.stock} $${contract.strike} ${contract.type} — ask:${chainEntry?.ask} bid:${chainEntry?.bid} mid:${signal.mid?.toFixed(3)} costToClose:$${signal.costToClose} profit:${signal.profitPct?.toFixed(1)}% premium:$${contract.premium} level:${signal.level}`);

      const lastNotif = sentData.contracts[String(contract.id)];
      // CLOSE_NOW: notify at most once per 15 minutes regardless of auto rules
      // (auto-execute handles the trade — Pushover is just FYI)
      if (signal.level === "CLOSE_NOW" && lastNotif?.level === "CLOSE_NOW" && lastNotif?.sentAt) {
        const minsSince = (Date.now() - new Date(lastNotif.sentAt).getTime()) / 60000;
        if (minsSince < 15) continue;
      } else if (!shouldNotify(signal, lastNotif)) continue;

      const notif = buildNotification(contract, signal, quotes);
      notifications.push({ contract, signal, notif });

      // Update state
      sentData.contracts[String(contract.id)] = {
        level: signal.level,
        projectedProfit: signal.projectedProfit,
        profitPct: signal.profitPct,
        sentAt: lastRefresh,
      };
    }

    // ── Send notifications + log to signal_log ──────────────────────────────
    // etNow is hoisted to top-level scope above
    for (const { contract, signal, notif } of notifications) {
      const sigId = await logSignal({
        signal_type:          signal.level === "CLOSE_NOW" ? "close_now" : signal.level === "APPROACHING" ? "approaching" : "itm_warning",
        symbol:               contract.stock,
        account:              contract.account,
        contract_id:          contract.id,
        stock_price:          quotes[contract.stock?.toUpperCase()]?.lastPrice,
        change_pct:           quotes[contract.stock?.toUpperCase()]?.changePct != null ? quotes[contract.stock?.toUpperCase()].changePct * 100 : null,
        time_of_day:          etNow.toTimeString().slice(0, 8),
        day_of_week:          etNow.getDay(),
        strike:               contract.strike,
        expires:              contract.expires,
        dte:                  signal.dte,
        otm_pct:              signal.otmPct,
        profit_at_signal:     signal.projectedProfit,
        profit_pct_at_signal: signal.profitPct,
        pushed:               true,
      });
      // ── Write scoring_factor_values for close signal ─────────────────────
      const q = quotes[contract.stock?.toUpperCase()] || {};
      await writeFactorValues(sigId, {
        change_pct:           q.changePct != null ? q.changePct * 100 : null,
        vix:                  null, // vix not available in close signal context
        dte:                  signal.dte,
        otm_pct:              signal.otmPct,
        profit_pct_at_signal: signal.profitPct,
        time_of_day:          etNow.getHours() * 60 + etNow.getMinutes(),
      }, lastRefresh);
      const closeUrl = sigId
        ? `${APP_URL}/?action=close&id=${contract.id}&signal_id=${sigId}`
        : notif.url;
      await sendPushover(notif.title, notif.body, closeUrl, "View Contract", notif.priority);
    }

    } // end isMarketOpen

    // ── Exit plan checks (stop loss, time stop, delta stop) ──────────────────
    if (isMarketOpen) {
      try {
        const todayStr = lastRefresh.slice(0, 10);
        for (const contract of contracts) {
          if (contract.opt_type !== "STO") continue;
          if (!contract.stock || !contract.premium) continue;

          const ticker     = contract.stock.toUpperCase();
          const stockPrice = quotes[ticker]?.lastPrice;
          if (!stockPrice) continue;

          const chainKey   = `${ticker}|${contract.expires}`;
          const chain      = chainData[chainKey];
          const side       = contract.type === "Call" ? "calls" : "puts";
          const chainEntry = chain?.[side]?.find(o => Math.abs(+o.strikePrice - +contract.strike) < 0.01);
          const liveAsk    = chainEntry?.ask ?? null;

          // Only alert once per day per contract
          const lastAlertDate = contract.last_exit_alert_at?.slice(0, 10);
          if (lastAlertDate === todayStr) continue;

          let alertMsg = null;
          const dte = Math.ceil((new Date(contract.expires) - new Date()) / 86400000);
          const costToClose = liveAsk != null ? liveAsk * (+contract.qty || 1) * 100 : null;
          const prem = Math.abs(+contract.premium || 0);

          // Stop loss: cost-to-close > premium × multiplier
          const slMult = +(contract.stop_loss_multiplier ?? 2.0);
          if (costToClose != null && slMult > 0 && costToClose > prem * slMult) {
            alertMsg = `🛑 Stop loss triggered: ${ticker} $${contract.strike} ${contract.type} — cost to close $${costToClose.toFixed(0)} > ${slMult}× premium ($${(prem * slMult).toFixed(0)})`;
          }

          // Time stop: DTE <= time_stop_dte
          if (!alertMsg && contract.time_stop_dte != null && dte <= +contract.time_stop_dte) {
            alertMsg = `⏱ Time stop triggered: ${ticker} $${contract.strike} ${contract.type} — DTE ${dte} ≤ ${contract.time_stop_dte}`;
          }

          // Delta stop: live delta > delta_stop
          const liveDelta = Math.abs(chainEntry?.delta ?? 0);
          if (!alertMsg && contract.delta_stop != null && liveDelta > 0 && liveDelta > +(contract.delta_stop)) {
            alertMsg = `Δ Delta stop triggered: ${ticker} $${contract.strike} ${contract.type} — delta ${liveDelta.toFixed(2)} > ${contract.delta_stop}`;
          }

          if (alertMsg) {
            await sendPushover(`⚠️ Exit Plan Alert: ${ticker}`, alertMsg, `${APP_URL}/?tab=contracts`, "View Contracts", 1);
            await fetch(`${SUPABASE_URL}/rest/v1/contracts?id=eq.${contract.id}`, {
              method: "PATCH",
              headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
              body: JSON.stringify({ last_exit_alert_at: lastRefresh }),
            });
            console.log(`[exit-plan] ${alertMsg}`);
          }
        }
      } catch(e) { console.warn("[market-refresh] exit plan checks failed:", e.message); }
    }

    // ── Save notification state ─────────────────────────────────────────────
    if (notifications.length) {
      await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id: "notifications_sent", cols: sentData, updated_at: lastRefresh }),
      });
    }

    // ── STO Rules Scanner (positions-driven, rules from signal_rules table) ──
    try {
      const stoRules = (Array.isArray(signalRules) ? signalRules : []).filter(r => r.rule_type === "sto");

      if (stoRules.length && allPositions.length) {
        // vix and etNow are hoisted to top-level scope above
        // Current ET time for time-window checks
        const etNowMins = etNow.getHours() * 60 + etNow.getMinutes();

        // Fetch open STOs to calculate uncovered shares
        const openSTOs = await fetch(
          `${SUPABASE_URL}/rest/v1/contracts?select=stock,qty,account&status=eq.Open&opt_type=eq.STO`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        ).then(r => r.json());

        const coveredMap = {};
        for (const c of (Array.isArray(openSTOs) ? openSTOs : [])) {
          // Normalize account: "Schwab" → "Schwab" stays, "Schwab 3866" → "Schwab 3866"
          // But positions always come as "Schwab XXXX" — so also index plain "Schwab" under all Schwab position keys
          const acct = c.account || "";
          const keys = [acct];
          // If stored as plain "Schwab", also match any "Schwab XXXX" key
          if (acct === "Schwab") {
            allPositions.filter(p => p.account?.startsWith("Schwab")).forEach(p => keys.push(p.account));
          }
          for (const key of [...new Set(keys)]) {
            const mapKey = `${c.stock?.toUpperCase()}|${key}`;
            coveredMap[mapKey] = (coveredMap[mapKey] || 0) + (+c.qty || 0) * 100;
          }
        }

        for (const pos of allPositions) {
          const { symbol, qty, account, broker } = pos;
          if (qty < 100) continue;

          const coveredKey    = `${symbol}|${account}`;
          const coveredShares = coveredMap[coveredKey] || 0;
          const uncovered     = Math.floor((qty - coveredShares) / 100) * 100;
          if (uncovered < 100) continue;

          const suggestQty = Math.floor(uncovered / 100);
          const stockQ     = quotes[symbol];
          if (!stockQ?.lastPrice) continue;

          const stockPrice = stockQ.lastPrice;
          const changePct  = stockQ.changePct != null ? stockQ.changePct * 100 : 0;

          // Find best matching rule for this position
          const rule = stoRules.find(r =>
            (!r.broker  || r.broker  === broker) &&
            (!r.account || account.includes(r.account) || r.account.includes(account.split(" ")[0]))
          ) || stoRules[0];

          if (!rule) continue;

          // ── Time window check ──────────────────────────────────────────────
          if (rule.min_time_et) {
            const [h, m] = rule.min_time_et.split(":").map(Number);
            if (etNowMins < h * 60 + m) {
              await logSignal({ signal_type: "sto_suggestion", symbol, account, stock_price: stockPrice, change_pct: changePct, vix, time_of_day: etNow.toTimeString().slice(0, 8), day_of_week: etNow.getDay(), suggested_qty: suggestQty, pushed: false });
              continue;
            }
          }
          if (rule.max_time_et) {
            const [h, m] = rule.max_time_et.split(":").map(Number);
            if (etNowMins > h * 60 + m) {
              await logSignal({ signal_type: "sto_suggestion", symbol, account, stock_price: stockPrice, change_pct: changePct, vix, time_of_day: etNow.toTimeString().slice(0, 8), day_of_week: etNow.getDay(), suggested_qty: suggestQty, pushed: false });
              continue;
            }
          }

          // ── Stock change check ─────────────────────────────────────────────
          if (rule.min_change_pct != null && changePct < +rule.min_change_pct) continue;

          // ── Momentum check (pullback, deceleration, gap-up) ──────────────
          // Uses rule.momentum_filters — consolidated from sto_momentum_config
          const momCfg = rule.momentum_filters || momentumConfig;
          if (momCfg && !momCfg.momentum_enabled && momCfg.require_decelerating) momCfg.momentum_enabled = true;
          const momentum = evaluateMomentum(symbol, stockQ, priceHistory, momCfg);
          if (!momentum.pass) {
            console.log(`[sto] ${symbol} suppressed by momentum: ${momentum.reasons.filter(r=>!r.startsWith("✓")).join("; ")}`);
            const supSigId = await logSignal({ signal_type: "sto_suggestion", symbol, account, stock_price: stockPrice, change_pct: changePct, vix, time_of_day: etNow.toTimeString().slice(0, 8), day_of_week: etNow.getDay(), suggested_qty: suggestQty, rule_id: rule?.id ?? null, pushed: false, notes: `momentum suppressed: ${momentum.reasons.join("; ")}` });
            const liveChainSup = await fetchLiveChain(token, symbol);
            await writeFactorValues(supSigId, {
              change_pct:         changePct,
              vix:                vix,
              pullback_from_high: momentum?.indicators?.pullbackFromHigh ?? null,
              deceleration:       momentum?.indicators?.decelerating != null
                ? (momentum.indicators.changePct30m ?? 0) - (momentum.indicators.changePctNow ?? 0) : null,
              rsi_14:             computeRSI(dailyCandles[symbol] || []),
              iv_pct:             getAtmIv(liveChainSup, symbol, stockPrice),
              ...(ivRankCache[symbol] || {}),
              ...(computeFibFactors(dailyCandles[symbol] || [], stockPrice) || {}),
              ...(computeBollingerBands(dailyCandles[symbol] || []) || {}),
              ...(computeGapFlag(dailyCandles[symbol] || []) || {}),
              ...(srCache[symbol] || {}),
            }, lastRefresh);
            continue;
          }
          console.log(`[sto] ${symbol} passed momentum: ${momentum.reasons.join("; ")}`);
          if (rule.max_change_pct != null && changePct > +rule.max_change_pct) continue;

          // ── Momentum filters (RSI, trend regime, SMA alignment) ─────────
          // Driven by rule.momentum_filters jsonb column on signal_rules
          const mfRule = rule.momentum_filters;
          if (mfRule) {
            const trend = trendBySymbol[symbol];
            let mfSkip = false;
            if (trend) {
              if (mfRule.max_rsi != null && trend.rsi14 != null && trend.rsi14 > +mfRule.max_rsi) {
                console.log(`[sto] ${symbol} skipped — RSI ${trend.rsi14.toFixed(1)} > max ${mfRule.max_rsi}`);
                mfSkip = true;
              }
              if (!mfSkip && mfRule.min_rsi != null && trend.rsi14 != null && trend.rsi14 < +mfRule.min_rsi) {
                console.log(`[sto] ${symbol} skipped — RSI ${trend.rsi14.toFixed(1)} < min ${mfRule.min_rsi}`);
                mfSkip = true;
              }
              if (!mfSkip && Array.isArray(mfRule.require_trend) && mfRule.require_trend.length && trend.trend_regime) {
                if (!mfRule.require_trend.includes(trend.trend_regime)) {
                  console.log(`[sto] ${symbol} skipped — trend "${trend.trend_regime}" not in [${mfRule.require_trend.join(",")}]`);
                  mfSkip = true;
                }
              }
              if (!mfSkip && mfRule.min_sma_alignment != null && trend.sma_alignment != null && trend.sma_alignment < +mfRule.min_sma_alignment) {
                console.log(`[sto] ${symbol} skipped — sma_alignment ${trend.sma_alignment} < min ${mfRule.min_sma_alignment}`);
                mfSkip = true;
              }
            } else {
              console.log(`[sto] ${symbol} — no trend data for momentum filters, proceeding`);
            }
            if (mfSkip) continue;
          }

          // ── VIX check ─────────────────────────────────────────────────────
          if (rule.min_vix != null && vix != null && vix < +rule.min_vix) continue;
          if (rule.max_vix != null && vix != null && vix > +rule.max_vix) continue;

          const minDTE  = rule.min_dte  ?? 1;
          const maxDTE  = rule.max_dte  ?? 14;
          const baseMinOTM = rule.min_otm_pct ?? 1;
          const maxOTM  = rule.max_otm_pct ?? 10;
          const minPrem = rule.min_premium  ?? 50;

          // Find matching strikes in chain data — scan calls for covered call STOs
          const matchingOpps = [];
          for (const [chainKey, chain] of Object.entries(chainData)) {
            const [chainTicker, chainExpiry] = chainKey.split("|");
            if (chainTicker !== symbol) continue;
            const dte = Math.ceil((new Date(chainExpiry) - new Date()) / 86400000);
            if (dte < minDTE || dte > maxDTE) continue;

            // ── Table-driven OTM by DTE ────────────────────────────────
            // otm_dte_table: [{ max_dte: 3, min_otm_pct: 1.75 }, { max_dte: 7, min_otm_pct: 2.0 }, ...]
            // Falls back to rule-level min_otm_pct if no table defined
            let effectiveMinOTM = baseMinOTM;
            const otmDteTable = rule.otm_dte_table;
            if (Array.isArray(otmDteTable) && otmDteTable.length) {
              const sorted = [...otmDteTable].sort((a, b) => a.max_dte - b.max_dte);
              const match  = sorted.find(row => dte <= row.max_dte);
              if (match) effectiveMinOTM = +match.min_otm_pct;
              else effectiveMinOTM = +sorted[sorted.length - 1].min_otm_pct;
            }

            for (const strike of (chain.calls || [])) {
              // OTM% for calls: how far above current price is the strike
              const otmPct = ((strike.strikePrice - stockPrice) / stockPrice) * 100;
              if (otmPct < effectiveMinOTM || otmPct > maxOTM) continue;
              const mid = (strike.bid != null && strike.ask != null) ? (strike.bid + strike.ask) / 2 : strike.mark ?? 0;
              const premiumEst = Math.round(mid * suggestQty * 100 * 100) / 100;
              if (premiumEst < minPrem) continue;
              matchingOpps.push({ strike: strike.strikePrice, expiry: chainExpiry, dte, otmPct: Math.round(otmPct * 10) / 10, bid: strike.bid, ask: strike.ask, mid: Math.round(mid * 100) / 100, premiumEst, iv: strike.volatility, effectiveMinOTM });
            }
          }

          if (!matchingOpps.length) continue;

          matchingOpps.sort((a, b) => b.premiumEst - a.premiumEst);
          const top = matchingOpps.slice(0, 3);

          // Dedupe: one push per symbol+account per day
          const suggKey = `sto_pos_${symbol}_${account.replace(/\s+/g, "_")}`;
          if (sentData.contracts[suggKey]?.sentAt?.slice(0, 10) === today) continue;

          const sign  = changePct >= 0 ? "+" : "";
          const title = `💡 STO Opportunity — ${symbol} (${account})`;
          const lines = [
            `${qty} shares held · ${coveredShares} covered · ${uncovered} uncovered → STO ${suggestQty}`,
            `${symbol} $${stockPrice.toFixed(2)}  ${sign}${changePct.toFixed(2)}%${vix ? `  VIX: ${vix.toFixed(1)}` : ""}`,
            ``,
            ...top.map((o, i) => `${i + 1}. $${o.strike} Call ${o.expiry} (${o.dte}d, ${o.otmPct}% OTM)\n   Bid $${o.bid?.toFixed(2) ?? "—"}  Mid $${o.mid?.toFixed(2) ?? "—"}  Ask $${o.ask?.toFixed(2) ?? "—"}  Est: $${o.premiumEst.toFixed(0)}`),
            ``,
            `Account: ${account} · Qty: ${suggestQty}`,
          ];

          // Log to signal_log first — capture id for deep-link
          const sigId = await logSignal({
            signal_type:   "sto_suggestion",
            symbol,
            account,
            stock_price:   stockPrice,
            change_pct:    changePct,
            vix,
            iv:            top[0]?.iv ?? null,
            time_of_day:   etNow.toTimeString().slice(0, 8),
            day_of_week:   etNow.getDay(),
            strike:        top[0]?.strike,
            expires:       top[0]?.expiry,
            dte:           top[0]?.dte,
            otm_pct:       top[0]?.otmPct,
            suggested_qty: suggestQty,
            est_premium:   top[0]?.premiumEst,
            rule_id:       rule?.id ?? null,
            momentum_indicators: momentum?.indicators ?? null,
            pushed:        true,
          });

          const stoUrl = `${APP_URL}/?tab=stocks&ticker=${symbol}&strike=${top[0]?.strike ?? ""}&expiry=${top[0]?.expiry ?? ""}&qty=${suggestQty}&price=${top[0]?.mid?.toFixed(2) ?? ""}&account=${encodeURIComponent(account)}&action=sto${sigId ? `&signal_id=${sigId}` : ""}`;
          await sendPushover(title, lines.join("\n"), stoUrl, "Open in App", 0);
          sentData.contracts[suggKey] = { sentAt: lastRefresh, symbol, account, suggestQty };

          // ── Write scoring_factor_values for this signal ───────────────────
          if (sigId) {
            const liveChain = await fetchLiveChain(token, symbol);
            const rsi14  = computeRSI(dailyCandles[symbol] || []);
            const ivPct  = getAtmIv(liveChain, symbol, stockPrice);
            const fib    = computeFibFactors(dailyCandles[symbol] || [], stockPrice);
            const bb     = computeBollingerBands(dailyCandles[symbol] || []);
            const gap    = computeGapFlag(dailyCandles[symbol] || []);
            const ivRank = ivRankCache[symbol] || {};
            const sr     = srCache[symbol]     || {};
            await writeFactorValues(sigId, {
              change_pct:         changePct,
              vix:                vix,
              otm_pct:            top[0]?.otmPct ?? null,
              pullback_from_high: momentum?.indicators?.pullbackFromHigh ?? null,
              deceleration:       momentum?.indicators?.decelerating != null
                ? (momentum.indicators.changePct30m ?? 0) - (momentum.indicators.changePctNow ?? 0) : null,
              rsi_14:             rsi14,
              iv_pct:             ivPct,
              ...ivRank,
              ...(fib || {}),
              ...(bb  || {}),
              ...(gap || {}),
              ...sr,
            }, lastRefresh);
          }
        }

        // Save notification state
        await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
          method: "POST",
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({ id: "notifications_sent", cols: sentData, updated_at: lastRefresh }),
        });
      }
    } catch(e) { console.warn("[market-refresh] STO scanner failed:", e.message); }

    // ── Auto-STO Scanner (place covered call STOs automatically) ──────────
    // MARKET HOURS GATE — never place orders outside 9:30 AM–4:00 PM ET Mon-Fri
    if (!isMarketOpen) {
      console.log("[auto-sto] outside market hours — skipping order placement");
    } else
    try {
      const stoRuleAuto = (Array.isArray(signalRules) ? signalRules : [])
        .filter(r => r.rule_type === "sto" && r.enabled)
        .sort((a,b) => (b.priority||0)-(a.priority||0))[0];

      if (!stoRuleAuto) {
        console.log("[auto-sto] No enabled STO rule found");
      } else {
        // Build whitelist from stocksData (autoSto=true tickers)
        const autoStoWhitelist = Object.entries(updatedSD)
          .filter(([, sd]) => sd?.autoSto === true)
          .map(([sym]) => sym.toUpperCase());

        if (!autoStoWhitelist.length) {
          console.log("[auto-sto] No tickers whitelisted — enable autoSto in Stocks tab");
        } else {
          const isDryRun   = stoRuleAuto.dry_run !== false;
          const minChange  = +(stoRuleAuto.min_change_pct ?? 0.5);
          const minPrem    = +(stoRuleAuto.min_premium ?? 50);
          const minDTE     = +(stoRuleAuto.min_dte ?? 1);
          const maxDTE     = +(stoRuleAuto.max_dte ?? 14);
          const minOTM     = +(stoRuleAuto.min_otm_pct ?? 1);
          const maxOTM     = +(stoRuleAuto.max_otm_pct ?? 5);

          // Time gate
          const etNowAuto  = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
          const etAutoMins = etNowAuto.getHours() * 60 + etNowAuto.getMinutes();
          const minTimeMins = stoRuleAuto.min_time_et ? +stoRuleAuto.min_time_et.split(":")[0]*60 + +stoRuleAuto.min_time_et.split(":")[1] : 9*60+45;
          if (etAutoMins < minTimeMins) {
            console.log(`[auto-sto] Too early (${etNowAuto.toTimeString().slice(0,5)} ET) — waiting until ${stoRuleAuto.min_time_et || "09:45"}`);
          } else {

            // Load ticker_risk_config for all whitelisted tickers (task #22)
            let tickerRiskConfig = {};
            try {
              const trcRes = await fetch(
                `${SUPABASE_URL}/rest/v1/ticker_risk_config?select=symbol,min_otm_pct,max_dte,min_iv_pct,max_iv_pct,action`,
                { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
              );
              const trcRows = await trcRes.json();
              if (Array.isArray(trcRows)) trcRows.forEach(r => { tickerRiskConfig[r.symbol.toUpperCase()] = r; });
            } catch(e) { console.warn("[auto-sto] ticker_risk_config load failed:", e.message); }

            const globalMinIV = +(momentumConfig?.min_iv_pct ?? 25); // task #18 IV floor

            console.log(`[auto-sto] Scanning ${autoStoWhitelist.length} whitelisted tickers — ${isDryRun ? "DRY RUN" : "LIVE"}`);

            for (const symbol of autoStoWhitelist) {
              try {
                const stockQ = quotes[symbol];
                if (!stockQ?.lastPrice) continue;

                const stockPrice = stockQ.lastPrice;
                const changePct  = (stockQ.changePct ?? 0) * 100;

                // Task #22: ticker_risk_config check — skip if action=avoid
                const trc = tickerRiskConfig[symbol];
                if (trc?.action === 'avoid') {
                  console.log(`[Scanner] Skipping ${symbol} — ticker_risk_config action=avoid`);
                  continue;
                }

                // Task #18: IV floor gate
                const tickerIV = getAtmIv(chainData, symbol, stockPrice);
                const minIVFloor = trc?.min_iv_pct != null ? +trc.min_iv_pct : globalMinIV;
                if (tickerIV != null && tickerIV < minIVFloor) {
                  console.log(`[Scanner] Skipping ${symbol} — IV ${tickerIV.toFixed(1)}% below ${minIVFloor}% floor`);
                  continue;
                }

                // Stock must be up by min_change_pct
                if (changePct < minChange) {
                  console.log(`[auto-sto] ${symbol} skipped — change ${changePct.toFixed(2)}% < ${minChange}%`);
                  continue;
                }

                // Momentum check
                const autoMomCfg = stoRuleAuto?.momentum_filters || momentumConfig;
                if (autoMomCfg && !autoMomCfg.momentum_enabled && autoMomCfg.require_decelerating) autoMomCfg.momentum_enabled = true;
                const momentum = evaluateMomentum(symbol, stockQ, priceHistory, autoMomCfg);
                if (!momentum.pass) {
                  console.log(`[auto-sto] ${symbol} suppressed by momentum: ${momentum.reasons.filter(r=>!r.startsWith("✓")).join("; ")}`);
                  continue;
                }

                // ── Snapshot-based filters (RSI, trend, SMA alignment) ─────────────
                // Driven by stoRuleAuto.momentum_filters:
                // {
                //   max_rsi:            70,          // skip if RSI overbought
                //   min_rsi:            30,          // skip if RSI oversold (optional)
                //   require_trend:      ["bullish","neutral"],  // allowed trend regimes
                //   min_sma_alignment:  1            // 1=price>SMA20>SMA50, 2=all three aligned
                // }
                const mf = stoRuleAuto.momentum_filters;
                if (mf) {
                  const trend = trendBySymbol[symbol];
                  if (trend) {
                    if (mf.max_rsi != null && trend.rsi14 != null && trend.rsi14 > +mf.max_rsi) {
                      console.log(`[auto-sto] ${symbol} skipped — RSI ${trend.rsi14.toFixed(1)} > max ${mf.max_rsi}`);
                      continue;
                    }
                    if (mf.min_rsi != null && trend.rsi14 != null && trend.rsi14 < +mf.min_rsi) {
                      console.log(`[auto-sto] ${symbol} skipped — RSI ${trend.rsi14.toFixed(1)} < min ${mf.min_rsi}`);
                      continue;
                    }
                    if (Array.isArray(mf.require_trend) && mf.require_trend.length && trend.trend_regime) {
                      if (!mf.require_trend.includes(trend.trend_regime)) {
                        console.log(`[auto-sto] ${symbol} skipped — trend_regime "${trend.trend_regime}" not in [${mf.require_trend.join(",")}]`);
                        continue;
                      }
                    }
                    if (mf.min_sma_alignment != null && trend.sma_alignment != null && trend.sma_alignment < +mf.min_sma_alignment) {
                      console.log(`[auto-sto] ${symbol} skipped — sma_alignment ${trend.sma_alignment} < min ${mf.min_sma_alignment}`);
                      continue;
                    }
                  } else {
                    console.log(`[auto-sto] ${symbol} — no trend data for momentum filters, proceeding`);
                  }
                }

                // Get uncovered shares per account for this ticker
                const sdTicker = updatedSD[symbol] || {};
                const sharesByAcct = sdTicker.sharesByAcct || {};

                // Build covered map for this ticker
                const openSTOsForTicker = (Array.isArray(contracts) ? contracts : [])
                  .filter(c => c.stock?.toUpperCase() === symbol && c.opt_type === "STO" && c.type === "Call");

                const coveredByAcct = {};
                for (const c of openSTOsForTicker) {
                  coveredByAcct[c.account] = (coveredByAcct[c.account] || 0) + (+c.qty || 0) * 100;
                }

                // Find best strike from chain data
                // Strategy:
                //   1. Prefer nearest valid expiry (lowest DTE within min/max window)
                //   2. Within that expiry, pick strike by best score:
                //      score = (mid / stockPrice * 100) / otmPct
                //      This rewards premium yield relative to risk taken
                //      e.g. $2.00 mid at 3% OTM scores higher than $2.50 mid at 6% OTM
                //   3. Min OTM scales with DTE: short DTE allows closer strikes,
                //      longer DTE requires more cushion
                const today2 = new Date().toISOString().slice(0,10);

                // Task #22: override min_otm_pct from ticker_risk_config if available
                const effectiveBaseMinOTM = trc?.min_otm_pct != null ? +trc.min_otm_pct : minOTM;
                const effectiveMaxDTE     = trc?.max_dte     != null ? +trc.max_dte     : maxDTE;

                // Group valid candidates by expiry, pick nearest expiry first
                const candidatesByExpiry = {};
                for (const [chainKey, chain] of Object.entries(chainData)) {
                  const [chainTicker, chainExpiry] = chainKey.split("|");
                  if (chainTicker !== symbol) continue;
                  if (chainExpiry <= today2) continue;
                  const dte = Math.ceil((new Date(chainExpiry) - new Date()) / 86400000);
                  if (dte < minDTE || dte > effectiveMaxDTE) continue;

                  // Effective min OTM — table-driven via stoRuleAuto.otm_dte_table
                  // Table format: [{ max_dte: 3, min_otm_pct: 1.75 }, { max_dte: 7, min_otm_pct: 2.00 }, ...]
                  // Rows sorted ascending by max_dte; first row where dte <= max_dte wins.
                  // Falls back to minOTM (rule-level) if no table defined.
                  let effectiveMinOTM = effectiveBaseMinOTM; // task #22: use ticker config if available
                  const otmDteTable = stoRuleAuto.otm_dte_table;
                  if (Array.isArray(otmDteTable) && otmDteTable.length) {
                    const sorted = [...otmDteTable].sort((a, b) => a.max_dte - b.max_dte);
                    const match  = sorted.find(row => dte <= row.max_dte);
                    if (match) effectiveMinOTM = +match.min_otm_pct;
                    else effectiveMinOTM = +sorted[sorted.length - 1].min_otm_pct;
                  }

                  for (const strike of (chain.calls || [])) {
                    const otmPct = ((strike.strikePrice - stockPrice) / stockPrice) * 100;
                    if (otmPct < effectiveMinOTM || otmPct > maxOTM) continue;
                    const mid = strike.bid > 0 && strike.ask > 0 ? (strike.bid + strike.ask) / 2 : strike.bid ?? 0;
                    if (mid <= 0) continue;
                    // Score = premium yield / OTM risk (higher = better risk-adjusted premium)
                    const score = (mid / stockPrice * 100) / otmPct;
                    if (!candidatesByExpiry[chainExpiry]) candidatesByExpiry[chainExpiry] = [];
                    candidatesByExpiry[chainExpiry].push({ strike: strike.strikePrice, mid, ask: strike.ask, dte, otmPct, score, expiry: chainExpiry });
                  }
                }

                // Build sorted per-expiry best candidates — enables cascade when min_premium gate fails
                const sortedExpiryCandidates = Object.keys(candidatesByExpiry).sort()
                  .map(expiry => {
                    const cands = candidatesByExpiry[expiry];
                    return cands.length ? cands.reduce((a, b) => b.score > a.score ? b : a) : null;
                  }).filter(Boolean);

                if (!sortedExpiryCandidates.length) {
                  console.log(`[auto-sto] ${symbol} — no suitable strike found in chain`);
                  continue;
                }

                // Process each account separately
                for (const [account, totalShares] of Object.entries(sharesByAcct)) {
                  if (totalShares < 100) continue;
                  const covered   = coveredByAcct[account] || 0;
                  const uncovered = Math.floor((totalShares - covered) / 100);
                  if (uncovered < 1) continue;

                  // Cascade through expiries until min_premium gate passes
                  let _sel = null;
                  for (const cand of sortedExpiryCandidates) {
                    const est = Math.round(cand.mid * uncovered * 100 * 100) / 100;
                    if (est >= minPrem) { _sel = cand; break; }
                    console.log(`[auto-sto] ${symbol} ${account} ${cand.expiry} — est $${est} < min $${minPrem}, trying next expiry`);
                  }
                  if (!_sel) {
                    console.log(`[auto-sto] ${symbol} ${account} — no expiry meets min premium $${minPrem}`);
                    continue;
                  }
                  const bestStrike  = _sel.strike;
                  const bestExpiry  = _sel.expiry;
                  const bestPremium = _sel.mid;
                  const bestAsk     = _sel.ask;
                  const bestDTE     = _sel.dte;
                  const estPremium  = Math.round(bestPremium * uncovered * 100 * 100) / 100;
                  console.log(`[auto-sto] ${symbol} best strike: $${bestStrike} ${bestExpiry} (${bestDTE}d, ${_sel.otmPct.toFixed(1)}% OTM, mid $${bestPremium.toFixed(2)}, score ${_sel.score.toFixed(3)})`);

                  // Check for existing pending STO order for this ticker+account today
                  const alreadyPending = [...pendingContractIds].some(id => {
                    // Can't check ticker here without extra lookup — skip duplicate check for now
                    // The sentData check below handles same-day dedup
                    return false;
                  });

                  const autoStoKey = `auto_sto|${symbol}|${account}|${bestStrike}|${bestExpiry}`;
                  if (sentData.contracts[autoStoKey]?.sentAt?.slice(0,10) === today2) {
                    console.log(`[auto-sto] ${symbol} ${account} — already placed today, skipping`);
                    continue;
                  }

                  if (!bestAsk || bestAsk <= 0) {
                    console.log(`[auto-sto] ${symbol} — no valid ask price, skipping`);
                    continue;
                  }
                  const limitPrice = Math.round(bestAsk * 100) / 100;
                  const isSchwab   = account?.startsWith("Schwab");

                  console.log(`[auto-sto] ${isDryRun?"DRY RUN":"PLACING"} STO ${symbol} $${bestStrike} Call ${bestExpiry} × ${uncovered} @ $${limitPrice} — ${account}`);

                  // Log signal
                  const sigId = await logSignal({
                    signal_type:  "sto_auto",
                    symbol,
                    account,
                    stock_price:  stockPrice,
                    change_pct:   changePct,
                    vix,
                    strike:       bestStrike,
                    expires:      bestExpiry,
                    dte:          bestDTE,
                    otm_pct:      Math.round(((bestStrike - stockPrice) / stockPrice) * 1000) / 10,
                    suggested_qty: uncovered,
                    est_premium:  estPremium,
                    rule_id:      stoRuleAuto?.id ?? null,
                    momentum_indicators: momentum?.indicators ?? null,
                    pushed:       true,
                  });

                  // ── Write scoring_factor_values for this auto-sto signal ──────────
                  if (sigId) {
                    try {
                      const liveChainAuto = await fetchLiveChain(token, symbol);
                      const rsi14  = computeRSI(dailyCandles[symbol] || []);
                      const ivPct  = getAtmIv(liveChainAuto, symbol, stockPrice);
                      const fib    = computeFibFactors(dailyCandles[symbol] || [], stockPrice);
                      const bb     = computeBollingerBands(dailyCandles[symbol] || []);
                      const gap    = computeGapFlag(dailyCandles[symbol] || []);
                      const factors = {
                        change_pct:  changePct,
                        vix:         vix ?? null,
                        dte:         bestDTE,
                        otm_pct:     Math.round(((bestStrike - stockPrice) / stockPrice) * 1000) / 10,
                        rsi_14:      rsi14,
                        iv_pct:      ivPct,
                        ...(ivRankCache[symbol] || {}),
                        ...(fib || {}),
                        ...(bb  || {}),
                        ...(gap || {}),
                        ...(srCache[symbol] || {}),
                      };
                      const factorRows = Object.entries(factors)
                        .filter(([, v]) => v !== null && v !== undefined)
                        .map(([factor_name, value]) => ({ signal_id: sigId, factor_name, value }));
                      if (factorRows.length) {
                        await fetch(`${SUPABASE_URL}/rest/v1/scoring_factor_values`, {
                          method: "POST",
                          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
                          body: JSON.stringify(factorRows),
                        }).catch(e => console.warn("[auto-sto] factor write failed:", e.message));
                        console.log(`[auto-sto] wrote ${factorRows.length} factors for signal ${sigId}`);
                      }
                    } catch(e) { console.warn(`[auto-sto] factor capture failed for ${symbol}:`, e.message); }
                  }

                  // Skynet controls check before live placement
                  if (!contractDryRun) {
                    const scCheck = checkSkynetControls({ controls: skynetControls, limitPrice, qty: uncovered, bid: bestAsk, ask: bestAsk, projectedProfit: estPremium });
                    if (!scCheck.ok) {
                      console.log(`[auto-sto] ${symbol} ${account} blocked by Skynet controls: ${scCheck.reason}`);
                      continue;
                    }
                  }

                  if (isDryRun) {
                    // Dry run — notify with full order JSON so you can review before going live
                    const deepLink = `${APP_URL}/?tab=stocks&ticker=${symbol}&strike=${bestStrike}&expiry=${bestExpiry}&qty=${uncovered}&price=${limitPrice.toFixed(2)}&account=${encodeURIComponent(account)}&action=sto${sigId ? `&signal_id=${sigId}` : ""}`;
                    const dryRunOrderJson = JSON.stringify({
                      ticker:      symbol,
                      type:        "Call",
                      opt_type:    "STO",
                      strike:      bestStrike,
                      expiry:      bestExpiry,
                      dte:         bestDTE,
                      qty:         uncovered,
                      limit_price: limitPrice,
                      est_premium: estPremium,
                      account,
                      otm_pct:     Math.round(((bestStrike - stockPrice) / stockPrice) * 1000) / 10,
                      stock_price: stockPrice,
                      change_pct:  changePct,
                      vix:         vix ?? null,
                    }, null, 2);
                    await sendPushover(
                      `🤖 [DRY RUN] Auto-STO: ${symbol} $${bestStrike} Call`,
                      `${symbol} $${bestStrike} Call ${bestExpiry} (${bestDTE}d)\nQty: ${uncovered} × $${limitPrice.toFixed(2)} = est $${estPremium.toFixed(0)}\nOTM: ${Math.round(((bestStrike-stockPrice)/stockPrice)*1000)/10}%  DTE: ${bestDTE}\nStock: $${stockPrice.toFixed(2)} (+${changePct.toFixed(1)}%)  VIX: ${vix?.toFixed(1) ?? "—"}\nAccount: ${account}\n\n${dryRunOrderJson}`,
                      deepLink,
                      "Review & Place", 0
                    );
                  } else {
                    // Live — route to correct broker
                    const isSchwab = account?.startsWith("Schwab");
                    const isEtrade = account?.startsWith("ETrade") || account?.startsWith("Etrade");
                    try {
                      let orderResult = null;

                      if (isSchwab) {
                        const previewRes = await fetch(`${APP_URL}/api/schwab-orders?action=preview-new&secret=${process.env.CRON_SECRET}`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            ticker: symbol, strike: bestStrike, expires: bestExpiry,
                            type: "Call", opt_type: "STO", qty: uncovered,
                            limit_price: limitPrice, account, order_type: "LIMIT", duration: "DAY",
                          }),
                        }).then(r => r.json());

                        if (!previewRes?.ok) { console.warn(`[auto-sto] Schwab preview failed for ${symbol}:`, previewRes?.error || JSON.stringify(previewRes)); continue; }

                        orderResult = await fetch(`${APP_URL}/api/schwab-orders?action=approve-new&secret=${process.env.CRON_SECRET}`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ orderId: previewRes.order?.id, dry_run: false, limit_price: limitPrice, approved_by: "skynet_auto_sto" }),
                        }).then(r => r.json());

                      } else if (isEtrade) {
                        const previewRes = await fetch(`${APP_URL}/api/schwab-orders?action=etrade-preview-new&secret=${process.env.CRON_SECRET}`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            ticker: symbol, strike: bestStrike, expires: bestExpiry,
                            type: "Call", opt_type: "STO", qty: uncovered,
                            limit_price: limitPrice, account, order_type: "LIMIT", duration: "DAY",
                          }),
                        }).then(r => r.json());

                        if (!previewRes?.ok) { console.warn(`[auto-sto] ETrade preview failed for ${symbol}:`, previewRes?.error || JSON.stringify(previewRes)); continue; }

                        orderResult = await fetch(`${APP_URL}/api/schwab-orders?action=etrade-place-new&secret=${process.env.CRON_SECRET}`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ orderId: previewRes.order?.id, dry_run: false, limit_price: limitPrice, approved_by: "skynet_auto_sto" }),
                        }).then(r => r.json());

                      } else {
                        console.warn(`[auto-sto] Unknown broker for account ${account} — skipping`);
                        continue;
                      }

                      if (orderResult?.ok) {
                        // Auto-start chase: placed at ask, chase down to mid
                        const tradeOrderId = orderResult?.order?.id;
                        if (tradeOrderId) {
                          const chaseFloor = Math.round(bestPremium * 100) / 100; // mid = floor
                          await fetch(`${SUPABASE_URL}/rest/v1/trade_orders?id=eq.${tradeOrderId}`, {
                            method: "PATCH",
                            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
                            body: JSON.stringify({ chase_active: true, chase_floor: chaseFloor, chase_step: 0.05 }),
                          });
                          console.log(`[auto-sto] chase started on order ${tradeOrderId} — ask $${limitPrice} → floor (mid) $${chaseFloor}`);
                        }
                        // Tag newly created contract with open_method=auto
                        // The contract was just created by schwab-orders — find it by matching
                        // stock + strike + expires + account + status=Open, created in last 60s
                        try {
                          const recentRes = await fetch(
                            `${SUPABASE_URL}/rest/v1/contracts?select=id&stock=eq.${symbol}&strike=eq.${bestStrike}&expires=eq.${bestExpiry}&account=eq.${encodeURIComponent(account)}&status=eq.Open&order=id.desc&limit=1`,
                            { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
                          );
                          const recentRows = await recentRes.json();
                          if (recentRows?.[0]?.id) {
                            await fetch(`${SUPABASE_URL}/rest/v1/contracts?id=eq.${recentRows[0].id}`, {
                              method: "PATCH",
                              headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
                              body: JSON.stringify({
                              open_method: "auto",
                              stop_loss_multiplier: bestDTE <= 3 ? null : 2.0, // task #15: no stop loss for DTE≤3
                            }),
                            });
                            console.log(`[auto-sto] tagged contract ${recentRows[0].id} open_method=auto stop_loss=${bestDTE<=3?"null (DTE≤3)":"2.0"}`);
                          }
                        } catch(e) { console.warn(`[auto-sto] open_method tag failed:`, e.message); }

                        await sendPushover(
                          `🤖 Auto-STO PLACED: ${symbol} $${bestStrike} Call`,
                          `${symbol} $${bestStrike} Call ${bestExpiry} (${bestDTE}d)\nQty: ${uncovered} × $${limitPrice} = est $${estPremium.toFixed(0)}\nStock: $${stockPrice.toFixed(2)} (+${changePct.toFixed(1)}%)\nAccount: ${account}`,
                          sigId ? `${APP_URL}/?tab=contracts` : APP_URL,
                          "View Contracts", 1
                        );
                      } else {
                        console.warn(`[auto-sto] Order placement failed for ${symbol} ${account}:`, orderResult?.error);
                      }
                    } catch(e) { console.warn(`[auto-sto] order placement failed for ${symbol}:`, e.message); }
                  }

                  // Mark as sent to prevent same-expiry duplicate today
                  sentData.contracts[autoStoKey] = { sentAt: lastRefresh, symbol, account };

                  // Write factor values
                  await writeFactorValues(sigId, {
                    change_pct:         changePct,
                    vix,
                    dte:                bestDTE,
                    otm_pct:            Math.round(((bestStrike - stockPrice) / stockPrice) * 1000) / 10,
                    pullback_from_high: momentum?.indicators?.pullbackFromHigh ?? null,
                    deceleration:       momentum?.indicators?.decelerating != null
                      ? (momentum.indicators.changePct30m ?? 0) - (momentum.indicators.changePctNow ?? 0) : null,
                    time_of_day:        etNowAuto.getHours() * 60 + etNowAuto.getMinutes(),
                  }, lastRefresh);

                } // end per-account loop
              } catch(e) { console.warn(`[auto-sto] error on ${symbol}:`, e.message); }
            } // end ticker loop
          } // end time gate
        } // end whitelist check
      } // end rule check
    } catch(e) { console.warn("[market-refresh] auto-sto scanner failed:", e.message); }

    // ── Auto-BTC Scanner (close STOs at profit threshold) ─────────────────
    // MARKET HOURS GATE — never place orders outside 9:30 AM–4:00 PM ET Mon-Fri
    if (!isMarketOpen) {
      console.log("[btc_auto] outside market hours — skipping order placement");
    } else
    try {
      const btcRules = (Array.isArray(signalRules) ? signalRules : [])
        .filter(r => r.rule_type === "btc_auto" && r.enabled)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0)); // highest priority first

      if (btcRules.length) {
        // Pick the best matching rule for current ET time
        const etNowForBtc = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
        const etTimeStr   = `${String(etNowForBtc.getHours()).padStart(2,"0")}:${String(etNowForBtc.getMinutes()).padStart(2,"0")}`;
        const timeToMins  = t => { if (!t) return -1; const [h,m] = t.split(":").map(Number); return h*60+m; };
        const currentMins = timeToMins(etTimeStr);

        // Helper: find best rule for a given ticker (ticker-specific rules have priority)
        const findRuleForTicker = (tickerSym) => {
          // 1. Ticker-specific rule (has tickers array containing this symbol)
          const specific = btcRules.find(r => {
            if (!Array.isArray(r.tickers) || !r.tickers.includes(tickerSym?.toUpperCase())) return false;
            if (r.min_time_et && timeToMins(r.min_time_et) > currentMins) return false;
            if (r.max_time_et && timeToMins(r.max_time_et) < currentMins) return false;
            if (r.min_dte != null || r.max_dte != null) return true; // DTE check deferred to contract loop
            return true;
          });
          if (specific) return specific;
          // 2. Generic rule (no tickers filter)
          return btcRules.find(r => {
            if (Array.isArray(r.tickers) && r.tickers.length > 0) return false; // skip ticker-specific
            if (r.min_time_et && timeToMins(r.min_time_et) > currentMins) return false;
            if (r.max_time_et && timeToMins(r.max_time_et) < currentMins) return false;
            return true;
          });
        };

        // Check if any rule exists for any time
        const rule = findRuleForTicker(null);

        if (!rule) {
          console.log(`[btc_auto] No matching rule for current time ${etTimeStr}`);
        } else {
          // rule/isDryRun/minProfit resolved per-contract inside loop using findRuleForTicker
          const isDryRun  = rule.dry_run !== false;
          const minProfit = +(rule.min_profit_pct ?? 70);
          console.log(`[btc_auto] Active rules: ${btcRules.map(r=>`"${r.name}"(${r.tickers?.join(",")||"all"})`).join(", ")} — time ${etTimeStr}`);

        // Fetch all open STO Call contracts with full details
        const openSTOs = await fetch(
          `${SUPABASE_URL}/rest/v1/contracts?select=id,stock,type,opt_type,strike,expires,premium,qty,account,status&status=eq.Open&opt_type=eq.STO`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        ).then(r => r.json());

        // Only Calls
        const callSTOs = (Array.isArray(openSTOs) ? openSTOs : []).filter(c => c.type === "Call");
        if (!callSTOs.length) {
          console.log("[btc_auto] No open STO Calls found");
        }

        // pendingContractIds is defined at outer scope above

        const token = await getValidToken();

        for (const contract of callSTOs) {
          try {
            // Skip if already has a pending order
            if (pendingContractIds.has(String(contract.id))) {
              console.log(`[btc_auto] Skipping ${contract.stock} — pending order exists`);
              continue;
            }

            const ticker  = String(contract.stock || "").toUpperCase();
            const expires = String(contract.expires || "").slice(0, 10);

            // Resolve per-ticker rule — ticker-specific rules (e.g. AAPL 85%) override generic
            const contractRule = findRuleForTicker(ticker) || rule;
            const contractDryRun  = contractRule.dry_run !== false;
            const contractMinProfit = +(contractRule.min_profit_pct ?? 70);
            // DTE filter check for ticker-specific rules
            const contractDte = Math.ceil((new Date(expires) - new Date()) / 86400000);
            if (contractRule.min_dte != null && contractDte < +contractRule.min_dte) continue;
            if (contractRule.max_dte != null && contractDte > +contractRule.max_dte && contractRule.tickers?.length) {
              // Ticker-specific DTE restriction — fall back to generic rule
              const genericRule = btcRules.find(r => !Array.isArray(r.tickers) || !r.tickers.length);
              if (!genericRule) continue;
            }

            // Task #10: skip BTC if expires today and stock is 2%+ below strike (let it expire worthless)
            if (contractDte === 0) {
              const liveStockPrice = quotes[ticker]?.lastPrice;
              if (liveStockPrice != null && liveStockPrice < +contract.strike * 0.98) {
                console.log(`[BTC] Skipping ${ticker} — expires today, stock $${liveStockPrice.toFixed(2)} vs strike $${contract.strike}, letting expire worthless`);
                continue;
              }
            }

            // Fetch live bid/ask for this contract
            const livePrice = await fetch(
              `${SCHWAB_BASE}/marketdata/v1/chains?symbol=${ticker}&contractType=${contract.type.toUpperCase()}&strike=${contract.strike}&fromDate=${expires}&toDate=${expires}&includeUnderlyingQuote=false`,
              { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
            ).then(r => r.json()).catch(() => null);

            // Extract bid/ask from chain response
            const expKey = Object.keys(livePrice?.callExpDateMap || livePrice?.putExpDateMap || {}).find(k => k.startsWith(expires));
            const strikeMap = expKey ? (livePrice?.callExpDateMap?.[expKey] || livePrice?.putExpDateMap?.[expKey]) : null;
            const strikeKey = strikeMap ? Object.keys(strikeMap)[0] : null;
            const optData   = strikeKey ? strikeMap[strikeKey]?.[0] : null;

            if (!optData) {
              console.warn(`[btc_auto] No live price for ${ticker} $${contract.strike} ${contract.type} ${expires}`);
              continue;
            }

            const bid = optData.bid ?? 0;
            const ask = optData.ask ?? 0;
            const mid = ask > 0 && bid > 0 ? (bid + ask) / 2 : bid;

            // Calculate current profit %
            const premium    = +contract.premium;
            if (!premium) continue;
            const currentVal = mid * contract.qty * 100;
            const openedVal  = premium; // premium already stored as total (e.g. $1000)
            const profitPct  = ((openedVal - currentVal) / openedVal) * 100;

            console.log(`[btc_auto] ${ticker} $${contract.strike} ${contract.type} — bid:${bid} mid:${mid.toFixed(3)} profit:${profitPct.toFixed(1)}% — rule:"${contractRule.name}" threshold:${contractMinProfit}%`);

            if (profitPct < contractMinProfit) continue;

            // Use mid if available, fall back to bid
            const limitPrice = mid > 0 ? Math.round(mid * 100) / 100 : Math.round(bid * 100) / 100;
            if (!limitPrice) continue;

            const isSchwab = contract.account?.startsWith("Schwab");
            const isEtrade = contract.account?.startsWith("ETrade") || contract.account?.startsWith("Etrade");

            console.log(`[btc_auto] ${contractDryRun ? "[DRY RUN] " : ""}Placing BTC — ${ticker} $${contract.strike} ${contract.type} ${expires} @ $${limitPrice.toFixed(2)} (${profitPct.toFixed(1)}% ≥ ${contractMinProfit}%) — ${contract.account}`);

            // ── Log signal first ───────────────────────────────────────────
            const sigId = await logSignal({
              signal_type:          "btc_auto",
              symbol:               ticker,
              account:              contract.account,
              contract_id:          contract.id,
              stock_price:          quotes[ticker]?.lastPrice,
              change_pct:           quotes[ticker]?.changePct != null ? quotes[ticker].changePct * 100 : null,
              strike:               contract.strike,
              expires:              contract.expires,
              dte:                  Math.ceil((new Date(contract.expires) - new Date()) / 86400000),
              profit_at_signal:     openedVal - currentVal,
              profit_pct_at_signal: profitPct,
              rule_id:              rule?.id ?? null,
              pushed:               true,
            });
            // ── Write scoring_factor_values for btc_auto signal ─────────────
            await writeFactorValues(sigId, {
              change_pct:           quotes[ticker]?.changePct != null ? quotes[ticker].changePct * 100 : null,
              dte:                  Math.ceil((new Date(contract.expires) - new Date()) / 86400000),
              profit_pct_at_signal: profitPct,
              time_of_day:          etNowForBtc.getHours() * 60 + etNowForBtc.getMinutes(),
            }, lastRefresh);

            // ── Place order via internal API ───────────────────────────────
            let orderResult = null;
            if (isSchwab) {
              // Step 1: preview (creates trade_order row)
              const previewRes = await fetch(`${APP_URL}/api/schwab-orders?action=preview&secret=${process.env.CRON_SECRET}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contract_id: contract.id, limit_price: limitPrice, order_type: "LIMIT", duration: "DAY", auto_close: true }),
              }).then(r => r.json());

              if (!previewRes?.ok) {
                console.warn(`[btc_auto] Schwab preview failed for ${ticker}:`, previewRes?.error);
                continue;
              }

              const orderId = previewRes.order?.id;
              if (!orderId) continue;

              // Step 2: approve (dry_run controlled by rule)
              const approveRes = await fetch(`${APP_URL}/api/schwab-orders?action=approve&secret=${process.env.CRON_SECRET}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ orderId, dry_run: contractDryRun, limit_price: limitPrice, approved_by: "auto" }),
              }).then(r => r.json());

              orderResult = approveRes;

            } else if (isEtrade) {
              // Step 1: preview
              const previewRes = await fetch(`${APP_URL}/api/schwab-orders?action=order-preview&secret=${process.env.CRON_SECRET}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contract_id: contract.id, limit_price: limitPrice, order_type: "LIMIT", duration: "DAY" }),
              }).then(r => r.json());

              if (!previewRes?.ok) {
                console.warn(`[btc_auto] ETrade preview failed for ${ticker}:`, previewRes?.error);
                continue;
              }

              const orderId = previewRes.order?.id;
              if (!orderId) continue;

              // Step 2: place
              const placeRes = await fetch(`${APP_URL}/api/schwab-orders?action=order-place&secret=${process.env.CRON_SECRET}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ orderId, dry_run: contractDryRun, limit_price: limitPrice, approved_by: "auto" }),
              }).then(r => r.json());

              orderResult = placeRes;
            }

            // ── Update contract close_method ───────────────────────────────
            console.log(`[btc_auto] orderResult for ${contract.stock}:`, JSON.stringify(orderResult));
            if (!contractDryRun) {
              // Mark close_method=auto regardless of orderResult.ok — order may have
              // succeeded even if the response parsing failed
              await fetch(`${SUPABASE_URL}/rest/v1/contracts?id=eq.${contract.id}`, {
                method: "PATCH",
                headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
                body: JSON.stringify({ close_method: "auto" }),
              });
            }

            // ── Log decision ───────────────────────────────────────────────
            if (sigId) {
              await fetch(`${SUPABASE_URL}/rest/v1/decision_log`, {
                method: "POST",
                headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
                body: JSON.stringify({ signal_id: sigId, decision: contractDryRun ? "dry_run" : "traded", notes: `auto-btc @ $${limitPrice.toFixed(2)}`, created_at: new Date().toISOString() }),
              });
            }

            // ── Send Pushover ──────────────────────────────────────────────
            const dryTag    = contractDryRun ? "[DRY RUN] " : "";
            const profitStr = profitPct.toFixed(1);
            const profitDollar = Math.round((openedVal - currentVal) * 100) / 100;
            const profitDollarStr = (profitDollar >= 0 ? "+" : "-") + "$" + Math.abs(profitDollar).toFixed(2);
            const costStr   = `$${(limitPrice * contract.qty * 100).toFixed(2)}`;
            const jsonPreview = contractDryRun ? `\n\nOrder JSON:\n${JSON.stringify({ contract_id: contract.id, ticker, strike: contract.strike, type: contract.type, expires, qty: contract.qty, limit_price: limitPrice, order_type: "LIMIT", duration: "DAY", account: contract.account, approved_by: "auto" }, null, 2)}` : "";
            await sendPushover(
              `🤖 ${dryTag}Auto-BTC: ${ticker} ${contract.type}`,
              `${dryTag}Bought back ${ticker} $${contract.strike} ${contract.type} ${expires}\nLimit: $${limitPrice.toFixed(2)} · Cost: ${costStr} · Profit: ${profitDollarStr} (${profitStr}%)\nAccount: ${contract.account}${jsonPreview}`,
              sigId ? `${APP_URL}/?action=close&id=${contract.id}&signal_id=${sigId}` : `${APP_URL}/?tab=contracts`,
              "View Contract",
              contractDryRun ? 0 : 1
            );

          } catch(e) { console.warn(`[btc_auto] Error on contract ${contract.id}:`, e.message); }
        }
        } // end if (rule)
      }
    } catch(e) { console.warn("[market-refresh] btc_auto scanner failed:", e.message); }

    // ── Portfolio snapshot (once per day) ──────────────────────────────────
    try {
      const snapDate = today;
      const existing = await fetch(`${SUPABASE_URL}/rest/v1/portfolio_snapshots?snapshot_date=eq.${snapDate}&select=id`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }).then(r => r.json());

      if (!existing?.length) {
        // Schwab account value
        let schwabValue = null, schwabCash = null;
        try {
          const acctRes  = await fetch(`${SCHWAB_BASE}/trader/v1/accounts/accountNumbers`, { headers: { Authorization: `Bearer ${token}` } });
          const accounts = await acctRes.json();
          schwabValue = 0; schwabCash = 0;
          for (const acct of (Array.isArray(accounts) ? accounts : [])) {
            const d = await fetch(`${SCHWAB_BASE}/trader/v1/accounts/${acct.hashValue}?fields=positions`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
            schwabValue += d?.securitiesAccount?.currentBalances?.liquidationValue || 0;
            schwabCash  += d?.securitiesAccount?.currentBalances?.cashBalance || 0;
          }
        } catch(e) { console.warn("[snapshot] Schwab value failed:", e.message); }

        // ETrade account value
        let etradeValue = null, etradeCash = null;
        try {
          const etRes  = await fetch(`${APP_URL}/api/etrade?action=positions&secret=${process.env.CRON_SECRET}`);
          const etData = await etRes.json();
          etradeValue  = etData?.accountValue || null;
          etradeCash   = etData?.cash || null;
        } catch(e) { console.warn("[snapshot] ETrade value failed:", e.message); }

        // Open contracts value (sum of premiums on open STOs — money we'd owe to close)
        const openContractValue = contracts
          .filter(c => c.opt_type === "STO")
          .reduce((s, c) => s + Math.abs(+c.premium || 0), 0);

        const totalCash  = (schwabCash || 0) + (etradeCash || 0);
        const totalValue = (schwabValue || 0) + (etradeValue || 0);

        // Get yesterday's snapshot for daily change
        const yest = await fetch(`${SUPABASE_URL}/rest/v1/portfolio_snapshots?order=snapshot_date.desc&limit=1&select=total_value`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }).then(r => r.json());
        const prevValue    = yest?.[0]?.total_value ? +yest[0].total_value : null;
        const dailyChange  = prevValue ? Math.round((totalValue - prevValue) * 100) / 100 : null;
        const dailyChangePct = prevValue ? Math.round((dailyChange / prevValue) * 10000) / 100 : null;

        await fetch(`${SUPABASE_URL}/rest/v1/portfolio_snapshots`, {
          method: "POST",
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({
            snapshot_date:        snapDate,
            schwab_value:         schwabValue,
            etrade_value:         etradeValue,
            schwab_cash:          schwabCash,
            etrade_cash:          etradeCash,
            total_cash:           totalCash,
            total_positions:      (schwabValue || 0) + (etradeValue || 0) - totalCash,
            open_contracts_value: Math.round(openContractValue * 100) / 100,
            total_value:          totalValue,
            daily_change:         dailyChange,
            daily_change_pct:     dailyChangePct,
          }),
        });
        console.log(`[snapshot] saved for ${snapDate}: total=${totalValue}`);
      }
    } catch(e) { console.warn("[snapshot] failed:", e.message); }

    let filledCount = 0, cancelledCount = 0;
    try {
      const ordersRes  = await fetch(
        `${SUPABASE_URL}/rest/v1/trade_orders?status=eq.submitted&select=id,ticker,type,strike,expires,qty,account,schwab_order_id,opt_type`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const pendingOrders = await ordersRes.json();

      if (Array.isArray(pendingOrders) && pendingOrders.length) {
        // Fetch live option quotes for all pending order strikes
        const optionSymbols = pendingOrders
          .filter(o => o.ticker && o.strike && o.expires && o.type)
          .map(o => {
            const exp   = o.expires.replace(/-/g,"").slice(2); // YYMMDD
            const side  = o.type === "Call" ? "C" : "P";
            const stk   = ((+o.strike) * 1000).toFixed(0).padStart(8,"0");
            return `${o.ticker.toUpperCase().padEnd(6)}${exp}${side}${stk}`;
          });

        let optionQuotes = {};
        if (optionSymbols.length) {
          try {
            const oqRes = await fetch(
              `${SCHWAB_BASE}/marketdata/v1/quotes?symbols=${optionSymbols.join(",")}&fields=quote&indicative=false`,
              { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
            );
            optionQuotes = await oqRes.json();
          } catch(e) { console.warn("[market-refresh] option quotes failed:", e.message); }
        }

        // For each submitted order — check status + update live quote
        for (const order of pendingOrders) {
          try {
            // Build OSI symbol to look up quote
            const exp  = order.expires?.replace(/-/g,"").slice(2);
            const side = order.type === "Call" ? "C" : "P";
            const stk  = ((+order.strike) * 1000).toFixed(0).padStart(8,"0");
            const osi  = `${order.ticker?.toUpperCase().padEnd(6)}${exp}${side}${stk}`;
            const oq   = optionQuotes?.[osi]?.quote ?? optionQuotes?.[osi] ?? null;

            const liveQuote = oq ? {
              bid:  oq.bidPrice  ?? oq.bid  ?? null,
              ask:  oq.askPrice  ?? oq.ask  ?? null,
              last: oq.lastPrice ?? oq.last ?? null,
              mark: oq.mark      ?? null,
              mid:  (oq.bidPrice != null && oq.askPrice != null)
                    ? Math.round(((oq.bidPrice + oq.askPrice) / 2) * 100) / 100
                    : null,
              updatedAt: lastRefresh,
            } : null;

            // Check Schwab order status if submitted
            if (order.schwab_order_id) {
              const isETrade = order.account?.startsWith("ETrade");

              if (isETrade) {
                // ETrade status check via schwab-orders API
                const sr = await fetch(
                  `${APP_URL}/api/schwab-orders?action=status&orderId=${order.id}&secret=${process.env.CRON_SECRET}`,
                  { headers: { Accept: "application/json" } }
                );
                if (sr.ok) {
                  const data = await sr.json();
                  if (data.order?.status === "filled")    filledCount++;
                  if (data.order?.status === "cancelled") cancelledCount++;
                  if (liveQuote && !["filled","cancelled"].includes(data.order?.status)) {
                    await fetch(`${SUPABASE_URL}/rest/v1/trade_orders?id=eq.${order.id}`, {
                      method: "PATCH",
                      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
                      body: JSON.stringify({ live_quote: liveQuote }),
                    });
                  }
                }
                continue;
              }

              const hash = await getAccountHash(token, order.account).catch(() => null);
              if (hash) {
                const sr = await fetch(
                  `${SCHWAB_BASE}/trader/v1/accounts/${hash}/orders/${order.schwab_order_id}`,
                  { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
                );
                if (sr.ok) {
                  const schwabOrder = await sr.json();
                  const patch = { raw_response: schwabOrder, ...(liveQuote ? { live_quote: liveQuote } : {}) };

                  if (schwabOrder.status === "FILLED") {
                    const leg = schwabOrder.orderActivityCollection?.[0];
                    Object.assign(patch, {
                      status:       "filled",
                      chase_active: false,
                      filled_at:    lastRefresh,
                      fill_price:   leg?.executionLegs?.[0]?.price ?? null,
                      fill_qty:     schwabOrder.filledQuantity ?? order.qty,
                    });
                    filledCount++;
                    sendPushover(
                      `✅ Order Filled: ${order.ticker}`,
                      `${order.opt_type} ${order.ticker} $${order.strike} ${order.type} ${order.expires}\nqty ${order.qty} · ${order.account}\nFill: $${patch.fill_price?.toFixed(2) ?? "—"}`,
                      `${APP_URL}/?tab=contracts`, "View in App", 1
                    ).catch(()=>{});
                  } else if (["CANCELED","REJECTED","EXPIRED","REPLACED"].includes(schwabOrder.status)) {
                    Object.assign(patch, { status: "cancelled", cancelled_at: lastRefresh });
                    cancelledCount++;
                    sendPushover(
                      `❌ Order ${schwabOrder.status}: ${order.ticker}`,
                      `${order.opt_type} ${order.ticker} $${order.strike} ${order.type} ${order.expires}\n${order.account}`,
                      `${APP_URL}/?tab=contracts`, "View in App", 0
                    ).catch(()=>{});
                  }

                  await fetch(`${SUPABASE_URL}/rest/v1/trade_orders?id=eq.${order.id}`, {
                    method: "PATCH",
                    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
                    body: JSON.stringify(patch),
                  });
                }
              }
            } else if (liveQuote) {
              // No Schwab order ID yet — just update the live quote
              await fetch(`${SUPABASE_URL}/rest/v1/trade_orders?id=eq.${order.id}`, {
                method: "PATCH",
                headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ live_quote: liveQuote }),
              });
            }
          } catch(e) { console.warn(`[market-refresh] order ${order.id}:`, e.message); }
        }
      }
    } catch(e) { console.warn("[market-refresh] pending orders poll failed:", e.message); }

    // ── Ecosystem heartbeat ──────────────────────────────────────────────────────
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/ecosystem_heartbeat`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ agent_name: "market-refresh", last_run_at: lastRefresh, status: "ok", notes: `${tickers.length} tickers, ${notifications.length} signals`, updated_at: lastRefresh }),
      });
    } catch(e) { console.warn("[heartbeat] write failed:", e.message); }

    // ── Auto-close ITM contracts at 3:30 PM ET on expiration day ────────────
    // MARKET HOURS GATE — only runs during market hours
    if (!isMarketOpen) {
      console.log("[expiry] outside market hours — skipping expiry protection checks");
    } else
    try {
      const etForExpiry = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
      const etMinsForExpiry = etForExpiry.getHours() * 60 + etForExpiry.getMinutes();
      const todayET = etForExpiry.toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);
      const WARN_MINS  = 15 * 60;      // 3:00 PM = 900 mins
      const CLOSE_MINS = 15 * 60 + 30; // 3:30 PM = 930 mins

      if (etMinsForExpiry >= WARN_MINS) {
        // Find open STOs expiring today
        const expiringRes = await fetch(
          `${SUPABASE_URL}/rest/v1/contracts?select=id,stock,type,opt_type,strike,expires,premium,qty,account,close_method&status=eq.Open&opt_type=eq.STO&expires=eq.${todayET}`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        const expiringContracts = await expiringRes.json();

        for (const contract of (Array.isArray(expiringContracts) ? expiringContracts : [])) {
          const ticker     = String(contract.stock || "").toUpperCase();
          const stockPrice = quotes[ticker]?.lastPrice;
          if (!stockPrice) continue;

          const strike = +contract.strike;
          const isCall = contract.type === "Call";
          const isITM  = isCall ? stockPrice > strike : stockPrice < strike;
          if (!isITM) continue;

          // Task #16: LEAP exclusion — skip if DTE > 30
          const expiryDte = Math.ceil((new Date(contract.expires) - new Date()) / 86400000);
          if (expiryDte > 30) {
            console.log(`[ExpiryProtection] Skipping ${ticker} — LEAP position (DTE ${expiryDte}), not closing`);
            continue;
          }

          // 3:00 PM warning
          if (etMinsForExpiry >= WARN_MINS && etMinsForExpiry < CLOSE_MINS) {
            await sendPushover(
              `⚠️ ${ticker} Expires Today ITM`,
              `${contract.type} $${strike} — stock at $${stockPrice.toFixed(2)} — will auto-close at 3:30 PM ET`,
              `${APP_URL}/?tab=contracts`, "View Contract", 1
            );
            console.log(`[expiry] warned ITM: ${ticker} $${strike} ${contract.type} stock=${stockPrice}`);
            continue;
          }

          // 3:30 PM auto-close — respects dry_run flag from signal_rules expiry_protection row
          if (etMinsForExpiry >= CLOSE_MINS && contract.close_method !== "auto") {
            const expiryRule  = (Array.isArray(signalRules) ? signalRules : []).find(r => r.rule_type === "expiry_protection" && r.enabled);
            const expiryDryRun = expiryRule ? expiryRule.dry_run !== false : true; // default to dry-run if no rule found
            const isSchwab = contract.account?.startsWith("Schwab");
            const isEtrade = contract.account?.startsWith("ETrade") || contract.account?.startsWith("Etrade");
            let orderResult = null;
            console.log(`[expiry] ${expiryDryRun ? "[DRY RUN]" : "[LIVE]"} auto-close for ${ticker} $${strike} ${contract.type} (rule: ${expiryRule?.id ?? "none"})`);
            try {
              if (isSchwab) {
                const previewRes = await fetch(`${APP_URL}/api/schwab-orders?action=preview&secret=${process.env.CRON_SECRET}`, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ contract_id: contract.id, order_type: "MARKET", duration: "DAY", auto_close: true }),
                }).then(r => r.json());
                if (previewRes?.ok) {
                  orderResult = await fetch(`${APP_URL}/api/schwab-orders?action=approve&secret=${process.env.CRON_SECRET}`, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ orderId: previewRes.order?.id, dry_run: expiryDryRun, approved_by: "expiry_protection" }),
                  }).then(r => r.json());
                }
              } else if (isEtrade) {
                const previewRes = await fetch(`${APP_URL}/api/schwab-orders?action=order-preview&secret=${process.env.CRON_SECRET}`, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ contract_id: contract.id, order_type: "MARKET", duration: "DAY" }),
                }).then(r => r.json());
                if (previewRes?.ok) {
                  orderResult = await fetch(`${APP_URL}/api/schwab-orders?action=order-place&secret=${process.env.CRON_SECRET}`, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ orderId: previewRes.order?.id, dry_run: expiryDryRun, approved_by: "expiry_protection" }),
                  }).then(r => r.json());
                }
              }
              if (orderResult?.ok) {
                if (!expiryDryRun) {
                  await fetch(`${SUPABASE_URL}/rest/v1/contracts?id=eq.${contract.id}`, {
                    method: "PATCH",
                    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
                    body: JSON.stringify({ close_method: "auto" }),
                  });
                  const itmProfit = Math.round((Math.abs(+contract.premium||0) - (mid * (+contract.qty||1) * 100)) * 100) / 100;
                  const itmProfitStr = (itmProfit >= 0 ? "+" : "") + "$" + Math.abs(itmProfit).toFixed(2);
                  await sendPushover(`✅ ${ticker} Auto-Closed — ITM at Expiry`, `Bought back ${contract.type} $${strike} to prevent assignment\nProfit: ${itmProfitStr} · Stock: $${stockPrice.toFixed(2)} · ${contract.account}`, `${APP_URL}/?tab=contracts`, "View Contracts", 1);
                  console.log(`[expiry] auto-closed ITM: ${ticker} $${strike} ${contract.type}`);
                } else {
                  await sendPushover(`🧪 [DRY RUN] ${ticker} Would Auto-Close — ITM`, `${contract.type} $${strike} · Stock: $${stockPrice.toFixed(2)} · ${contract.account}\nSet expiry_protection rule dry_run=false to enable real orders`, `${APP_URL}/?tab=contracts`, "View Contracts", 0);
                  console.log(`[ExpiryProtection] DRY RUN — would close ${ticker} ITM contract $${strike} ${contract.type} (stock $${stockPrice.toFixed(2)})`);
                }
              }
            } catch(e) { console.warn(`[expiry] auto-close failed for ${ticker}:`, e.message); }
          }
        }
      }
    } catch(e) { console.warn("[market-refresh] ITM expiry check failed:", e.message); }

    // ── Run chase loop on every market refresh ──────────────────────────────
    await runChaseLoop(token, { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });

    res.status(200).json({
      ok: true, time: lastRefresh,
      tickers: tickers.length,
      quotes: Object.keys(quotes).length,
      signals: notifications.length,
      filled: filledCount,
      cancelled: cancelledCount,
      notified: notifications.map(n => ({ id: n.contract.id, stock: n.contract.stock, level: n.signal.level, profit: n.signal.projectedProfit })),
    });

  } catch (err) {
    console.error("[market-refresh]", err.message);
    // Write error heartbeat
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/ecosystem_heartbeat`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ agent_name: "market-refresh", last_run_at: new Date().toISOString(), status: "error", notes: err.message, updated_at: new Date().toISOString() }),
      });
    } catch(e2) {}
    res.status(500).json({ error: err.message });
  }
}
