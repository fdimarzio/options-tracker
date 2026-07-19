// api/chase-step.js
// Stateless, idempotent chase engine. One call processes every trade_orders row with
// chase_status='active' that is due, taking exactly one step per order. No timers, no
// in-memory state — safe to call repeatedly and concurrently from multiple drivers
// (GitHub Actions chase-runner, browser fast-path poll).
//
// Governance: signal_rules row rule_type='chase' — its `enabled` and `dry_run` columns
// are the master switch and dry-run gate. dry_run=true means every step is logged to
// price_history but the broker is never called. This mirrors sto/btc_auto/expiry_protection.
//
// Usage: GET or POST /api/chase-step?secret=CRON_SECRET

const SUPABASE_URL     = process.env.VITE_SUPABASE_URL;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const SCHWAB_BASE      = "https://api.schwabapi.com";
const APP_URL          = "https://options-tracker-five.vercel.app";

const SB_HEADERS = { apikey: SUPABASE_SVC_KEY, Authorization: `Bearer ${SUPABASE_SVC_KEY}`, "Content-Type": "application/json" };

// ── Market hours gate (same window as market-refresh.js) ─────────────────────
// Accepts an optional reference Date for deterministic testing; defaults to now.
function isMarketHours(referenceDate = new Date()) {
  const et   = new Date(referenceDate.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day  = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960; // 9:30am–4:00pm ET
}

// ── Schwab token / account helpers (self-contained, same pattern as market-refresh.js) ──
async function getValidToken() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_tokens`, { headers: SB_HEADERS });
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
    headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: "schwab_tokens", cols: { ...t, accessToken: n.access_token, refreshToken: n.refresh_token || t.refreshToken, accessTokenExpiresAt: Date.now() + (n.expires_in * 1000) }, updated_at: new Date().toISOString() }),
  });
  return n.access_token;
}

let _acctHashCache = {};
async function getAccountHash(token, accountName) {
  if (_acctHashCache[accountName]) return _acctHashCache[accountName];
  const r = await fetch(`${SCHWAB_BASE}/trader/v1/accounts/accountNumbers`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const accounts = await r.json();
  if (!Array.isArray(accounts) || !accounts.length) throw new Error("No Schwab accounts");
  const suffix = accountName?.replace(/\D/g, "").slice(-4);
  const match = suffix ? accounts.find(a => a.accountNumber?.slice(-4) === suffix) : null;
  const hash = match?.hashValue || accounts[0].hashValue;
  _acctHashCache[accountName] = hash;
  return hash;
}

function buildOSI(ticker, expires, type, strike) {
  const exp = expires?.replace(/-/g, "").slice(2);
  const cp  = type === "Call" ? "C" : "P";
  const strikePad = (Math.round((+strike) * 1000)).toString().padStart(8, "0");
  return `${ticker?.toUpperCase().padEnd(6)}${exp}${cp}${strikePad}`;
}

// ── Pure decision functions — mirrored 1:1 in tests/chase.test.js ────────────

function isDue(order, nowMs, minIntervalSecs) {
  if (!order.chase_last_step_at) return true;
  return nowMs >= new Date(order.chase_last_step_at).getTime() + minIntervalSecs * 1000;
}

function isExpired(order, nowMs) {
  if (!order.chase_expires_at) return false;
  return nowMs > new Date(order.chase_expires_at).getTime();
}

// Resolve step size: explicit order.chase_step → ticker_steps[ticker] → spread-proportional → default_step
function resolveStep(order, chaseParams, bid, ask) {
  if (order.chase_step != null) return +order.chase_step;
  const ticker = order.ticker?.toUpperCase();
  if (chaseParams.ticker_steps && chaseParams.ticker_steps[ticker] != null) return +chaseParams.ticker_steps[ticker];
  if (chaseParams.step_mode === "spread_proportional" && ask != null && bid != null && ask > bid) {
    const frac = chaseParams.spread_step_frac ?? 0.25;
    const min  = chaseParams.min_step ?? 0.05;
    const max  = chaseParams.max_step ?? 0.25;
    const raw  = (ask - bid) * frac;
    return Math.min(Math.max(Math.round(raw * 100) / 100, min), max);
  }
  return +(chaseParams.default_step ?? 0.05);
}

// Next limit price: SELL steps down toward bid, BUY steps up toward ask. Never overshoots the market.
function computeNextPrice(order, step, bid, ask) {
  const isSell = ["STO", "STC"].includes(order.opt_type);
  const cur = +order.limit_price;
  let target = isSell ? cur - step : cur + step;
  if (isSell && bid != null) target = Math.max(target, bid);
  if (!isSell && ask != null) target = Math.min(target, ask);
  return Math.round(target * 100) / 100;
}

// Clamp to chase_bound: SELL floor, BUY ceiling. Returns { price, clamped }.
function clampToBound(order, price) {
  const bound = order.chase_bound;
  if (bound == null) return { price, clamped: false };
  const isSell = ["STO", "STC"].includes(order.opt_type);
  if (isSell) {
    if (price < bound) return { price: +bound, clamped: true };
  } else {
    if (price > bound) return { price: +bound, clamped: true };
  }
  return { price, clamped: false };
}

// Market-context guards: spread / adverse underlying move / VIX bounds.
function evaluateMarketGuards({ order, bid, ask, mid, underlyingNow, underlyingStart, vix, guards }) {
  if (!guards) return { tripped: false, reasons: [] };
  const isSell = ["STO", "STC"].includes(order.opt_type);
  const reasons = [];

  if (guards.max_spread_pct != null && mid > 0 && bid != null && ask != null) {
    const spreadPct = (ask - bid) / mid;
    if (spreadPct > guards.max_spread_pct) reasons.push(`spread ${(spreadPct * 100).toFixed(1)}% > max ${(guards.max_spread_pct * 100).toFixed(1)}%`);
  }
  if (guards.adverse_move_pct != null && underlyingStart != null && underlyingNow != null) {
    const movePct = ((underlyingNow - underlyingStart) / underlyingStart) * 100;
    const adverse = isSell ? movePct < -guards.adverse_move_pct : movePct > guards.adverse_move_pct;
    if (adverse) reasons.push(`underlying moved ${movePct.toFixed(2)}% since chase start (adverse for ${isSell ? "SELL" : "BUY"})`);
  }
  if (guards.min_vix != null && vix != null && vix < guards.min_vix) reasons.push(`VIX ${vix} < min ${guards.min_vix}`);
  if (guards.max_vix != null && vix != null && vix > guards.max_vix) reasons.push(`VIX ${vix} > max ${guards.max_vix}`);

  return { tripped: reasons.length > 0, reasons, onTrip: guards.on_guard_trip || "pause" };
}

// Interpret a fresh broker status payload into a normalized fill state.
// full: order fully filled. partial: some qty filled, remainder still open.
// cancelled: order no longer live at the broker. none: still working, unchanged.
function interpretFillState(brokerStatus, orderQty) {
  const filledQty = +(brokerStatus?.filledQty ?? 0);
  if (brokerStatus?.cancelled) return { state: "cancelled" };
  if (brokerStatus?.filled || (filledQty > 0 && filledQty >= orderQty)) {
    return { state: "full", fillQty: filledQty || orderQty, fillPrice: brokerStatus?.fillPrice ?? null };
  }
  if (filledQty > 0 && filledQty < orderQty) {
    return { state: "partial", fillQty: filledQty, fillPrice: brokerStatus?.fillPrice ?? null, remainingQty: orderQty - filledQty };
  }
  return { state: "none" };
}

function applyOnBound(onBound) {
  return onBound === "cancel" ? "cancel" : "rest"; // default rest
}

// ── Broker mechanics ──────────────────────────────────────────────────────────
// Fresh broker status check — THE RACE GUARD. Queries the live broker directly (not
// cached DB state) so a fill that beat us is caught before any cancel/replace.
async function fetchBrokerStatus(order, token) {
  const isEtrade = order.account?.startsWith("ETrade") || order.account?.startsWith("Etrade");
  if (!order.schwab_order_id) return { state: "none" };

  if (isEtrade) {
    // ETrade's OAuth1 client lives only in schwab-orders.js — delegate the raw status
    // fetch there (proven, working), then interpret the raw response ourselves so we
    // get correct partial-fill detection (the shared action=status endpoint doesn't
    // distinguish partial from full for ETrade).
    try {
      const r = await fetch(`${APP_URL}/api/schwab-orders?action=status&orderId=${order.id}&secret=${process.env.CRON_SECRET}`, { headers: { Accept: "application/json" } });
      if (!r.ok) return { state: "none" };
      const data = await r.json();
      const detail = data?.order?.raw_response?.OrderDetail?.[0];
      const inst   = detail?.Instrument?.[0];
      const status = detail?.status;
      const filledQty = +(inst?.filledQuantity ?? (status === "EXECUTED" ? order.qty : 0));
      const fillPrice = inst?.averageExecutionPrice ?? null;
      if (["CANCELLED", "REJECTED", "EXPIRED", "CANCELLED_BY_EXCHANGE"].includes(status)) return { state: "cancelled" };
      return interpretFillState({ filled: status === "EXECUTED", filledQty, fillPrice }, order.qty);
    } catch (e) {
      console.warn(`[chase-step] ETrade status check failed for order ${order.id}:`, e.message);
      return { state: "none" };
    }
  }

  // Schwab — direct status check for accurate PARTIALLY_FILLED detection.
  try {
    const hash = await getAccountHash(token, order.account);
    const r = await fetch(`${SCHWAB_BASE}/trader/v1/accounts/${hash}/orders/${order.schwab_order_id}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) return { state: "none" };
    const schwabOrder = await r.json();
    if (["CANCELED", "REJECTED", "EXPIRED", "REPLACED"].includes(schwabOrder.status)) return { state: "cancelled" };
    const leg = schwabOrder.orderActivityCollection?.[0];
    const filledQty = +(schwabOrder.filledQuantity ?? 0);
    const fillPrice = leg?.executionLegs?.[0]?.price ?? null;
    if (schwabOrder.status === "FILLED") return interpretFillState({ filled: true, filledQty: filledQty || order.qty, fillPrice }, order.qty);
    if (schwabOrder.status === "PARTIALLY_FILLED" || (filledQty > 0 && filledQty < order.qty)) {
      return interpretFillState({ filledQty, fillPrice }, order.qty);
    }
    return { state: "none" };
  } catch (e) {
    console.warn(`[chase-step] Schwab status check failed for order ${order.id}:`, e.message);
    return { state: "none" };
  }
}

// Live option quote (bid/ask/mid) — Schwab market data covers both brokers' listings.
async function fetchQuote(order, token) {
  const osi = buildOSI(order.ticker, order.expires, order.type, order.strike);
  const r = await fetch(`${SCHWAB_BASE}/marketdata/v1/quotes?symbols=${encodeURIComponent(osi)}&fields=quote&indicative=false`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) return null;
  const data = await r.json();
  const q = data?.[osi]?.quote;
  if (!q) return null;
  const bid = q.bidPrice ?? null, ask = q.askPrice ?? null;
  const mid = bid != null && ask != null ? Math.round(((bid + ask) / 2) * 100) / 100 : null;
  return { bid, ask, mid };
}

// Apply a step at the broker. dry_run: log only, never call the broker.
async function applyStep(order, toPrice, dryRun) {
  if (dryRun) return { ok: true, dryRun: true };
  const isEtrade = order.account?.startsWith("ETrade") || order.account?.startsWith("Etrade");
  if (isEtrade) {
    // ETrade supports a native atomic replace (PUT /orders/change.json) — use it.
    const r = await fetch(`${APP_URL}/api/schwab-orders?action=etrade-change-order&secret=${process.env.CRON_SECRET}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: order.id, new_price: toPrice }),
    });
    return r.json();
  }
  // Schwab: no verified atomic replace in this codebase — use the proven cancel-then-place
  // path (reprice), which already treats "cancel rejected because filled" as a fill.
  const r = await fetch(`${APP_URL}/api/schwab-orders?action=reprice&secret=${process.env.CRON_SECRET}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId: order.id, newPrice: toPrice, reason: "chase_step" }),
  });
  return r.json();
}

async function appendHistory(order, entry) {
  const history = Array.isArray(order.price_history) ? order.price_history : [];
  history.push(entry);
  await fetch(`${SUPABASE_URL}/rest/v1/trade_orders?id=eq.${order.id}`, {
    method: "PATCH", headers: { ...SB_HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify({ price_history: history }),
  });
  return history;
}

// ── Per-order engine step ─────────────────────────────────────────────────────
async function processOrder(order, { token, chaseParams, dryRun, stocksData, vix, nowMs }) {
  const minIntervalSecs = +(chaseParams.min_interval_secs ?? 20);

  // a. Interval gate
  if (!isDue(order, nowMs, minIntervalSecs)) {
    return { orderId: order.id, action: "skip", reason: "interval_gate" };
  }

  // b. Fresh broker status check — THE RACE GUARD
  const brokerStatus = await fetchBrokerStatus(order, token);
  if (brokerStatus.state === "full") {
    await fetch(`${SUPABASE_URL}/rest/v1/trade_orders?id=eq.${order.id}`, {
      method: "PATCH", headers: { ...SB_HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify({ chase_status: "filled", status: "filled", fill_qty: brokerStatus.fillQty, fill_price: brokerStatus.fillPrice, filled_at: new Date().toISOString() }),
    });
    await appendHistory(order, { ts: new Date().toISOString(), reason: "filled", from_price: order.limit_price, to_price: brokerStatus.fillPrice, fill_qty: brokerStatus.fillQty });
    return { orderId: order.id, action: "filled" };
  }
  if (brokerStatus.state === "cancelled") {
    await fetch(`${SUPABASE_URL}/rest/v1/trade_orders?id=eq.${order.id}`, {
      method: "PATCH", headers: { ...SB_HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify({ chase_status: "cancelled" }),
    });
    return { orderId: order.id, action: "cancelled_at_broker" };
  }
  let remainingQty = order.qty;
  if (brokerStatus.state === "partial") {
    remainingQty = brokerStatus.remainingQty;
    await fetch(`${SUPABASE_URL}/rest/v1/trade_orders?id=eq.${order.id}`, {
      method: "PATCH", headers: { ...SB_HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify({ qty: remainingQty, fill_qty: brokerStatus.fillQty, fill_price: brokerStatus.fillPrice }),
    });
    await appendHistory(order, { ts: new Date().toISOString(), reason: "partial_fill", from_price: order.limit_price, to_price: order.limit_price, fill_qty: brokerStatus.fillQty, remaining_qty: remainingQty });
    order = { ...order, qty: remainingQty };
  }

  // c. Expiry
  if (isExpired(order, nowMs)) {
    const onBound = applyOnBound(order.chase_on_bound);
    await fetch(`${SUPABASE_URL}/rest/v1/trade_orders?id=eq.${order.id}`, {
      method: "PATCH", headers: { ...SB_HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify({ chase_status: "expired" }),
    });
    await appendHistory(order, { ts: new Date().toISOString(), reason: "expired", from_price: order.limit_price, to_price: order.limit_price, on_bound: onBound });
    if (onBound === "cancel" && !dryRun) {
      await fetch(`${APP_URL}/api/schwab-orders?action=cancel&secret=${process.env.CRON_SECRET}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: order.id }) }).catch(() => {});
    }
    return { orderId: order.id, action: "expired", onBound };
  }

  // d. Live quote
  const quote = await fetchQuote(order, token);
  if (!quote || quote.bid == null || quote.ask == null) {
    return { orderId: order.id, action: "skip", reason: "no_quote" };
  }
  const { bid, ask, mid } = quote;

  // e. Market-context guards
  const startEntry = (order.price_history || []).find(h => h.reason === "chase_started");
  const underlyingStart = startEntry?.underlying_price ?? null;
  const underlyingNow = stocksData?.[order.ticker?.toUpperCase()]?.currentPrice ?? null;
  const guardResult = evaluateMarketGuards({ order, bid, ask, mid, underlyingNow, underlyingStart, vix, guards: chaseParams.market_guards });
  if (guardResult.tripped) {
    if (guardResult.onTrip === "exit") {
      const onBound = applyOnBound(order.chase_on_bound);
      await fetch(`${SUPABASE_URL}/rest/v1/trade_orders?id=eq.${order.id}`, {
        method: "PATCH", headers: { ...SB_HEADERS, Prefer: "return=minimal" },
        body: JSON.stringify({ chase_status: "hit_bound" }),
      });
      await appendHistory(order, { ts: new Date().toISOString(), reason: "guard_pause", from_price: order.limit_price, to_price: order.limit_price, bid, ask, mid, guard_reasons: guardResult.reasons, on_bound: onBound });
      return { orderId: order.id, action: "guard_exit", reasons: guardResult.reasons };
    }
    await appendHistory(order, { ts: new Date().toISOString(), reason: "guard_pause", from_price: order.limit_price, to_price: order.limit_price, bid, ask, mid, guard_reasons: guardResult.reasons });
    return { orderId: order.id, action: "guard_pause", reasons: guardResult.reasons };
  }

  // f. Resolve step, g. next price, h. clamp to bound
  const step = resolveStep(order, chaseParams, bid, ask);
  const rawNext = computeNextPrice(order, step, bid, ask);
  const { price: toPrice, clamped } = clampToBound(order, rawNext);

  if (Math.abs(toPrice - +order.limit_price) < 0.005 && !clamped) {
    return { orderId: order.id, action: "skip", reason: "no_change" };
  }

  // i. Apply
  const historyEntry = { ts: new Date().toISOString(), from_price: order.limit_price, to_price: toPrice, bid, ask, mid, reason: dryRun ? "dry_run_step" : "step" };

  if (clamped) {
    // Terminal price reached — rest at bound or cancel, per chase_on_bound.
    const onBound = applyOnBound(order.chase_on_bound);
    if (!dryRun) await applyStep(order, toPrice, false).catch(e => console.warn(`[chase-step] apply failed for order ${order.id}:`, e.message));
    await fetch(`${SUPABASE_URL}/rest/v1/trade_orders?id=eq.${order.id}`, {
      method: "PATCH", headers: { ...SB_HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify({ chase_status: "hit_bound", limit_price: toPrice, chase_last_step_at: new Date().toISOString() }),
    });
    await appendHistory(order, { ...historyEntry, reason: dryRun ? "dry_run_step" : "hit_bound", on_bound: onBound });
    if (onBound === "cancel" && !dryRun) {
      await fetch(`${APP_URL}/api/schwab-orders?action=cancel&secret=${process.env.CRON_SECRET}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: order.id }) }).catch(() => {});
    }
    return { orderId: order.id, action: "hit_bound", toPrice, onBound };
  }

  if (dryRun) {
    await appendHistory(order, historyEntry);
    return { orderId: order.id, action: "dry_run_step", fromPrice: order.limit_price, toPrice };
  }

  const applyResult = await applyStep(order, toPrice, false);
  if (!applyResult?.ok) {
    console.warn(`[chase-step] broker apply failed for order ${order.id}:`, JSON.stringify(applyResult));
    return { orderId: order.id, action: "apply_failed", error: applyResult?.error };
  }
  await fetch(`${SUPABASE_URL}/rest/v1/trade_orders?id=eq.${order.id}`, {
    method: "PATCH", headers: { ...SB_HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify({ limit_price: toPrice, chase_last_step_at: new Date().toISOString() }),
  });
  await appendHistory(order, historyEntry);
  return { orderId: order.id, action: "step", fromPrice: historyEntry.from_price, toPrice };
}

// ── Handler ────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const secret   = process.env.CRON_SECRET;
  const provided = req.headers["x-cron-secret"] || req.query.secret;
  if (secret && provided !== secret) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Rule gate: load the chase governance row regardless of enabled so we can report why we're a no-op.
    const chaseRuleRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_rules?rule_type=eq.chase&limit=1`, { headers: SB_HEADERS });
    const chaseRule = (await chaseRuleRes.json())?.[0] || null;

    if (!chaseRule?.enabled) {
      return res.status(200).json({ ok: true, skipped: true, reason: "chase rule disabled" });
    }

    // Global Skynet master kill-switch — same single flag that gates auto-STO/auto-BTC/
    // expiry_protection in market-refresh.js. Checked here too since chase runs as its own
    // endpoint/cron, not through market-refresh's request cycle.
    const scRows = await fetch(`${SUPABASE_URL}/rest/v1/skynet_controls?limit=1`, { headers: SB_HEADERS }).then(r => r.json()).catch(() => []);
    const masterEnabled = (scRows?.[0]?.master_enabled) !== false;
    if (!masterEnabled) {
      return res.status(200).json({ ok: true, skipped: true, reason: "Skynet master switch off" });
    }

    // Market-hours gate — no steps outside RTH.
    if (!isMarketHours()) {
      return res.status(200).json({ ok: true, skipped: true, reason: "outside market hours" });
    }

    const dryRun = chaseRule.dry_run !== false;
    const chaseParams = chaseRule.chase_params || {};

    const [ordersRes, stocksDataRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/trade_orders?chase_status=eq.active&order=created_at.asc`, { headers: SB_HEADERS }),
      fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.stocks_data`, { headers: SB_HEADERS }),
    ]);
    const orders = await ordersRes.json();
    const stocksData = (await stocksDataRes.json())?.[0]?.cols || {};

    if (!Array.isArray(orders) || !orders.length) {
      return res.status(200).json({ ok: true, processed: 0, dryRun });
    }

    const token = await getValidToken();

    let vix = null;
    try {
      const vixRes = await fetch(`${SCHWAB_BASE}/marketdata/v1/quotes?symbols=%24VIX&fields=quote&indicative=false`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      const vixData = vixRes.ok ? await vixRes.json() : null;
      vix = vixData?.["$VIX"]?.quote?.lastPrice ?? null;
    } catch (e) { console.warn("[chase-step] VIX fetch failed:", e.message); }

    const nowMs = Date.now();
    const results = [];
    for (const order of orders) {
      try {
        results.push(await processOrder(order, { token, chaseParams, dryRun, stocksData, vix, nowMs }));
      } catch (e) {
        console.warn(`[chase-step] order ${order.id} failed:`, e.message);
        results.push({ orderId: order.id, action: "error", error: e.message });
      }
    }

    return res.status(200).json({ ok: true, processed: results.length, dryRun, results });
  } catch (err) {
    console.error("[chase-step]", err.message);
    return res.status(500).json({ error: err.message });
  }
}

export {
  isDue, isExpired, resolveStep, computeNextPrice, clampToBound,
  evaluateMarketGuards, interpretFillState, applyOnBound, buildOSI, isMarketHours,
};
