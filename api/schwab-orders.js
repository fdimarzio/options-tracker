// api/schwab-orders.js
// Places, cancels, and checks status of Schwab option orders.
// All orders require manual approval before submission.
// Dry run mode logs the order without submitting to Schwab.
//
// Actions:
//   POST ?action=preview    — build order preview, save as pending_approval (always dry run first)
//   POST ?action=approve    — approve a pending_approval order and submit to Schwab
//   POST ?action=cancel     — cancel a pending or submitted order
//   GET  ?action=status&orderId=X — check status of a submitted order
//   GET  ?action=list       — list recent trade_orders

import crypto from "crypto";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SCHWAB_BASE  = "https://api.schwabapi.com";
const APP_URL      = "https://options-tracker-five.vercel.app";

// ── Safety controls ───────────────────────────────────────────────────────────
const SAFETY = {
  maxPremiumPerTrade:   5000,   // max cost to close a position in $
  maxContractsPerOrder: 20,     // max contracts in a single order
  allowedTickers: null,         // null = all tickers allowed; or Set of allowed tickers
  dryRunByDefault:      true,   // always dry run unless explicitly overridden
  requireApproval:      true,   // always require manual approval
};

// ── Token helper ──────────────────────────────────────────────────────────────
async function getValidToken() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_tokens`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const t = (await r.json())?.[0]?.cols;
  if (!t?.accessToken) throw new Error("No Schwab tokens — visit /api/schwab-auth to authorize");
  if (t.accessTokenExpiresAt > Date.now() + 120000) return t.accessToken;
  if (!t.refreshToken || t.refreshTokenExpiresAt < Date.now()) throw new Error("Refresh token expired");
  const creds = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString("base64");
  const tr = await fetch("https://api.schwabapi.com/v1/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken }),
  });
  const n = await tr.json();
  if (!n.access_token) throw new Error("Token refresh failed");
  await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: "schwab_tokens", cols: { ...t, accessToken: n.access_token, refreshToken: n.refresh_token || t.refreshToken, accessTokenExpiresAt: Date.now() + (n.expires_in * 1000) }, updated_at: new Date().toISOString() }),
  });
  return n.access_token;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function dbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  return r.json();
}

async function dbInsert(table, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`DB insert failed: ${JSON.stringify(data)}`);
  return Array.isArray(data) ? data[0] : data;
}

async function dbUpdate(table, id, patch) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: "PATCH",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`DB update failed: ${JSON.stringify(data)}`);
  return Array.isArray(data) ? data[0] : data;
}

// ── Build OSI option symbol for Schwab ───────────────────────────────────────
// Format: AAPL  260516C00185000
function buildOSI(ticker, expires, type, strike) {
  if (!ticker || !expires || !type || !strike) throw new Error(`Invalid option params: ticker=${ticker} expires=${expires} type=${type} strike=${strike}`);
  const exp      = expires.replace(/-/g, "").slice(2); // YYMMDD
  const cp       = type === "Call" ? "C" : "P";
  const strikePad = (strike * 1000).toFixed(0).padStart(8, "0");
  return `${ticker.toUpperCase().padEnd(6)}${exp}${cp}${strikePad}`;
}

// ── Safety checks ─────────────────────────────────────────────────────────────
function runSafetyChecks(order) {
  const errors = [];

  if (order.qty > SAFETY.maxContractsPerOrder) {
    errors.push(`Qty ${order.qty} exceeds max ${SAFETY.maxContractsPerOrder} contracts per order`);
  }

  if (order.limit_price && order.limit_price * order.qty * 100 > SAFETY.maxPremiumPerTrade) {
    errors.push(`Estimated cost $${(order.limit_price * order.qty * 100).toFixed(2)} exceeds max $${SAFETY.maxPremiumPerTrade} per trade`);
  }

  if (SAFETY.allowedTickers && !SAFETY.allowedTickers.has(order.ticker?.toUpperCase())) {
    errors.push(`Ticker ${order.ticker} is not in the allowed list`);
  }

  // Only allow closing existing open contracts for BTC/STC safety check
  // (opening orders STO/BTO are handled separately in preview-new/etrade-preview-new)
  // if (!["BTC", "STC"].includes(order.opt_type)) {
  //   errors.push(`Only closing orders (BTC/STC) are allowed at this time`);
  // }

  return errors;
}

// ── Get Schwab account hash — in-memory cache to reduce API calls ─────────────
let _accountHashCache = null;
async function getAccountHash(token, accountName) {
  if (_accountHashCache) return _accountHashCache;

  const r = await fetch(`${SCHWAB_BASE}/trader/v1/accounts/accountNumbers`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const accounts = await r.json();
  if (!Array.isArray(accounts) || !accounts.length) throw new Error("Failed to load Schwab accounts");

  const suffix = accountName?.replace(/\D/g, "").slice(-4);
  if (suffix) {
    const match = accounts.find(a => a.accountNumber?.slice(-4) === suffix);
    if (match) { _accountHashCache = match.hashValue; return match.hashValue; }
  }

  console.log("[schwab-orders] using first account hash");
  _accountHashCache = accounts[0].hashValue;
  return _accountHashCache;
}

// ── Get live mid price for an option ─────────────────────────────────────────
async function getLivePrice(token, ticker, expires, type, strike) {
  const osi = buildOSI(ticker, expires, type, strike);
  const r   = await fetch(
    `${SCHWAB_BASE}/marketdata/v1/quotes?symbols=${encodeURIComponent(osi)}&fields=quote`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
  );
  const data = await r.json();
  const q    = data?.[osi]?.quote ?? data?.[osi];
  if (!q) return null;
  const bid = q.bidPrice ?? q.bid ?? null;
  const ask = q.askPrice ?? q.ask ?? null;
  if (bid == null || ask == null) return null;
  const mid = Math.round(((bid + ask) / 2) * 100) / 100;
  return { bid, ask, mid };
}

// ── Build Schwab order payload ─────────────────────────────────────────────────
function buildOrderPayload(order) {
  const osi         = buildOSI(order.ticker, order.expires, order.type, order.strike);
  const instruction = order.opt_type === "BTC" ? "BUY_TO_CLOSE" : "SELL_TO_CLOSE";

  // duration: DAY = good till end of day, GTC = good till cancelled
  const duration    = order.duration    || "DAY";
  // orderType: LIMIT or MARKET
  const orderType   = order.order_type  || "LIMIT";
  // specialInstruction: NONE or ALL_OR_NONE
  const special     = order.special_instruction === "ALL_OR_NONE" ? "ALL_OR_NONE" : "NONE";

  const payload = {
    orderType,
    session:            "NORMAL",
    duration,
    orderStrategyType:  "SINGLE",
    orderLegCollection: [{
      instruction,
      quantity: order.qty,
      instrument: {
        symbol:    osi,
        assetType: "OPTION",
      },
    }],
  };

  // Only include price for LIMIT orders
  if (orderType === "LIMIT") {
    payload.price = Number(order.limit_price).toFixed(2);
  }

  // Only include specialInstruction if not default
  if (special && special !== "NONE") {
    payload.specialInstruction = special;
  }

  return payload;
}

// ── Send Pushover notification ────────────────────────────────────────────────
async function sendPushover(title, message, url, priority = 0) {
  const token = process.env.PUSHOVER_API_TOKEN;
  const user  = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return;
  await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, user, title, message, url, url_title: "Open in App", priority, sound: priority >= 1 ? "cashregister" : "pushover" }),
  });
}

function orderSummary(order) {
  const price = order.order_type === "MARKET" ? "MKT" : order.limit_price != null ? `$${Number(order.limit_price).toFixed(2)}` : "—";
  return `${order.opt_type} ${order.qty}x ${order.ticker} $${order.strike} ${order.type} ${order.expires} · ${price} · ${order.account}`;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Auth — require cron secret for all order actions
  const secret   = process.env.CRON_SECRET;
  const provided = req.headers["x-cron-secret"] || req.query.secret;
  if (secret && provided !== secret) return res.status(401).json({ error: "Unauthorized" });

  const { action } = req.query;

  try {

    // ── GET: list recent orders ───────────────────────────────────────────────
    if (req.method === "GET" && action === "list") {
      const orders = await dbGet("trade_orders?order=created_at.desc&limit=50");
      return res.status(200).json({ ok: true, orders });
    }

    // ── GET: check order status ───────────────────────────────────────────────
    if (req.method === "GET" && action === "status") {
      const { orderId } = req.query;
      if (!orderId) return res.status(400).json({ error: "Missing orderId" });

      const rows = await dbGet(`trade_orders?id=eq.${orderId}`);
      const order = rows?.[0];
      if (!order) return res.status(404).json({ error: "Order not found" });

      if (order.schwab_order_id && !order.filled_at && !order.cancelled_at) {
        const isETrade = order.account?.startsWith("ETrade");

        if (isETrade) {
          // ── ETrade status check ───────────────────────────────────────────
          try {
            const acctData  = await etradeRequest("GET", "/v1/accounts/list");
            const eAccounts = acctData?.AccountListResponse?.Accounts?.Account || [];
            const acct      = eAccounts.find(a => String(a.accountId) === ETRADE_ACCOUNTS[order.account]);
            if (!acct) return res.status(200).json({ ok: true, order, etradeStatus: null, message: "ETrade account not found" });

            const orderRes   = await etradeRequest("GET", `/v1/accounts/${acct.accountIdKey}/orders/${order.schwab_order_id}`);
            const eOrder     = orderRes?.OrdersResponse?.Order?.[0];
            if (!eOrder) return res.status(200).json({ ok: true, order, etradeStatus: null, message: "Order not found at ETrade" });

            const eStatus = eOrder.OrderDetail?.[0]?.status || eOrder.status;
            let patch = { raw_response: eOrder };

            if (eStatus === "EXECUTED" || eStatus === "PARTIALLY_EXECUTED") {
              const leg = eOrder.OrderDetail?.[0]?.Instrument?.[0];
              patch = { ...patch, status: "filled", filled_at: new Date().toISOString(), fill_price: leg?.averageExecutionPrice ?? null, fill_qty: order.qty };
              sendPushover(`✅ ETrade Order Filled: ${order.ticker}`, `${orderSummary(order)}\nFill: $${patch.fill_price?.toFixed(2) ?? "—"}`, `${APP_URL}/?tab=contracts`, 1).catch(()=>{});
            } else if (["CANCELLED","REJECTED","EXPIRED","CANCELLED_BY_EXCHANGE"].includes(eStatus)) {
              patch = { ...patch, status: "cancelled", cancelled_at: new Date().toISOString() };
              sendPushover(`❌ ETrade Order ${eStatus}: ${order.ticker}`, orderSummary(order), `${APP_URL}/?tab=contracts`, 0).catch(()=>{});
            }

            const updated = await dbUpdate("trade_orders", orderId, patch);
            return res.status(200).json({ ok: true, order: updated, etradeStatus: eStatus });
          } catch(e) {
            return res.status(200).json({ ok: true, order, etradeStatus: null, message: e.message });
          }
        }

        // ── Schwab status check ─────────────────────────────────────────────
        const token = await getValidToken();
        const hash  = await getAccountHash(token, order.account);
        const r     = await fetch(
          `${SCHWAB_BASE}/trader/v1/accounts/${hash}/orders/${order.schwab_order_id}`,
          { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
        );

        if (r.status === 404) {
          return res.status(200).json({ ok: true, order, schwabStatus: null, message: "Order not found at Schwab — may not have been provisioned." });
        }

        const schwabOrder = r.ok ? await r.json() : null;
        if (!schwabOrder) {
          return res.status(200).json({ ok: true, order, schwabStatus: null, message: `Schwab returned HTTP ${r.status}` });
        }

        let patch = { raw_response: schwabOrder };
        if (schwabOrder.status === "FILLED") {
          const leg = schwabOrder.orderActivityCollection?.[0];
          patch = { ...patch, status: "filled", filled_at: new Date().toISOString(), fill_price: leg?.executionLegs?.[0]?.price ?? null, fill_qty: schwabOrder.filledQuantity ?? order.qty };
          sendPushover(`✅ Order Filled: ${order.ticker}`, `${orderSummary(order)}\nFill price: $${patch.fill_price?.toFixed(2) ?? "—"} · ${patch.fill_qty} contracts`, `${APP_URL}/?tab=contracts`, 1).catch(()=>{});
        } else if (["CANCELED","REJECTED","EXPIRED","REPLACED"].includes(schwabOrder.status)) {
          patch = { ...patch, status: "cancelled", cancelled_at: new Date().toISOString() };
          sendPushover(`❌ Order ${schwabOrder.status}: ${order.ticker}`, orderSummary(order), `${APP_URL}/?tab=contracts`, 0).catch(()=>{});
        }
        const updated = await dbUpdate("trade_orders", orderId, patch);
        return res.status(200).json({ ok: true, order: updated, schwabStatus: schwabOrder.status });
      }

      return res.status(200).json({ ok: true, order });
    }

    // ── POST: preview NEW opening order via Schwab (STO/BTO) ─────────────────
    if (req.method === "POST" && action === "preview-new") {
      const { ticker, type, strike, expires, opt_type, qty, limit_price: overridePrice, order_type = "LIMIT", duration = "DAY", special_instruction = "NONE", account } = req.body;
      if (!ticker || !type || !strike || !expires || !opt_type || !qty || !account) {
        return res.status(400).json({ error: "Missing required fields: ticker, type, strike, expires, opt_type, qty, account" });
      }

      const token     = await getValidToken();
      const livePrice = await getLivePrice(token, ticker, expires, type, strike);
      if (!livePrice) return res.status(400).json({ error: `Could not fetch live price for ${ticker} $${strike} ${type} ${expires}` });

      const limitPrice    = overridePrice != null ? +overridePrice : livePrice.mid;
      const instruction   = opt_type === "STO" ? "SELL_TO_OPEN" : "BUY_TO_OPEN";
      const osi           = buildOSI(ticker, expires, type, strike);

      const payload = {
        orderType: order_type,
        session: "NORMAL",
        duration,
        orderStrategyType: "SINGLE",
        ...(order_type === "LIMIT" ? { price: Number(limitPrice).toFixed(2) } : {}),
        orderLegCollection: [{
          instruction,
          quantity: +qty,
          instrument: { symbol: osi, assetType: "OPTION" },
        }],
      };

      const saved = await dbInsert("trade_orders", {
        account, ticker, opt_type, type, strike: +strike, expires,
        qty: +qty, order_type, duration, special_instruction,
        limit_price: order_type !== "MARKET" ? limitPrice : null,
        side: opt_type === "STO" ? "SELL" : "BUY",
        status: "pending_approval", dry_run: true,
        raw_request: payload,
      });

      return res.status(200).json({
        ok: true, order: saved, livePrice,
        preview: {
          action:        `${opt_type} ${qty} × ${ticker} $${strike} ${type} ${expires}`,
          limitPrice:    `$${limitPrice.toFixed(2)} (mid)`,
          estimatedCost: `$${(limitPrice * qty * 100).toFixed(2)}`,
          account,
          message: "Order saved. Approve to submit to Schwab.",
        },
      });
    }

    // ── POST: approve-new — submit Schwab opening order ───────────────────────
    if (req.method === "POST" && action === "approve-new") {
      const { orderId, dry_run, limit_price: overridePrice, order_type, duration } = req.body;
      if (!orderId) return res.status(400).json({ error: "Missing orderId" });

      const rows  = await dbGet(`trade_orders?id=eq.${parseInt(orderId, 10)}`);
      const order = rows?.[0];
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.status !== "pending_approval") return res.status(400).json({ error: `Order is ${order.status}` });

      if (overridePrice != null) order.limit_price = +overridePrice;
      if (order_type)            order.order_type   = order_type;
      if (duration)              order.duration      = duration;

      if (dry_run !== false) {
        const updated = await dbUpdate("trade_orders", orderId, { status: "dry_run_approved", dry_run: true, approved_at: new Date().toISOString(), notes: "Dry run — not submitted to Schwab" });
        sendPushover("🧪 Schwab Dry Run Approved", orderSummary(order), `${APP_URL}/?tab=contracts`, 0).catch(()=>{});
        return res.status(200).json({ ok: true, dryRun: true, order: updated });
      }

      const token   = await getValidToken();
      const hash    = await getAccountHash(token, order.account);
      const payload = order.raw_request;

      // Refresh limit price if changed
      if (overridePrice != null || order_type) {
        payload.price     = order.order_type !== "MARKET" ? Number(order.limit_price).toFixed(2) : undefined;
        payload.orderType = order.order_type || "LIMIT";
        payload.duration  = order.duration   || "DAY";
      }

      const submitRes = await fetch(
        `${SCHWAB_BASE}/trader/v1/accounts/${hash}/orders`,
        { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload) }
      );

      if (submitRes.status === 429) {
        return res.status(429).json({ error: "Schwab rate limit (429). Wait 60s and retry.", retryable: true });
      }

      const schwabOrderId = submitRes.headers.get("Location")?.split("/").pop() ?? null;
      if (submitRes.status !== 201) {
        const body = await submitRes.text();
        await dbUpdate("trade_orders", orderId, { status: "error", error_msg: body });
        return res.status(500).json({ error: `Schwab rejected order: ${body}` });
      }

      const updated = await dbUpdate("trade_orders", orderId, {
        status: "submitted", dry_run: false,
        schwab_order_id: schwabOrderId,
        submitted_at: new Date().toISOString(),
        approved_at:  new Date().toISOString(),
        limit_price:  order.limit_price,
        raw_request:  payload,
      });
      sendPushover(`✅ Order Submitted: ${order.ticker}`, orderSummary(order), `${APP_URL}/?tab=contracts`, 1).catch(()=>{});
      return res.status(200).json({ ok: true, dryRun: false, order: updated, schwabOrderId });
    }

    // ── POST: preview order ───────────────────────────────────────────────────
    if (req.method === "POST" && action === "preview") {
      const body = req.body;
      const { contract_id, qty, approved_by, limit_price: overridePrice, order_type, duration, special_instruction, auto_close } = body;

      if (!contract_id) return res.status(400).json({ error: "Missing contract_id" });

      // Load contract from DB
      const contracts = await dbGet(`contracts?id=eq.${contract_id}&select=*`);
      const contract  = contracts?.[0];
      if (!contract) return res.status(404).json({ error: "Contract not found" });
      if (contract.status !== "Open") return res.status(400).json({ error: "Contract is not open" });

      // Prevent duplicate BTC/STC orders for same contract
      const existingOrders = await dbGet(`trade_orders?contract_id=eq.${contract_id}&status=in.(pending_approval,dry_run_approved,submitted)`);
      if (Array.isArray(existingOrders) && existingOrders.length > 0) {
        return res.status(400).json({ error: `A ${existingOrders[0].opt_type} order already exists for this contract (status: ${existingOrders[0].status}). Cancel it first.` });
      }

      // Get live price — coerce fields to strings defensively
      const token     = await getValidToken();
      const ticker    = String(contract.stock || "").toUpperCase();
      const expires   = String(contract.expires || "").slice(0, 10);
      const optType   = contract.opt_type === "STO" ? "BTC" : contract.opt_type === "BTO" ? "STC" : contract.opt_type;
      const optType2  = optType; // alias for clarity below

      console.log("[schwab-orders] getLivePrice params:", { ticker, expires, type: contract.type, strike: contract.strike });
      const livePrice = await getLivePrice(token, ticker, expires, contract.type, contract.strike);
      if (!livePrice) return res.status(400).json({ error: `Could not fetch live price for ${ticker} $${contract.strike} ${contract.type} ${expires}` });

      const orderQty    = qty || contract.qty;
      const limitPrice  = overridePrice != null ? +overridePrice : livePrice.mid;
      const orderType   = order_type           || "LIMIT";
      const orderDuration = duration           || "DAY";
      const specialInstr  = special_instruction || "NONE";

      const order = {
        contract_id,
        account:              contract.account,
        ticker,
        opt_type:             optType2,
        type:                 contract.type,
        strike:               contract.strike,
        expires,
        qty:                  orderQty,
        order_type:           orderType,
        duration:             orderDuration,
        special_instruction:  specialInstr,
        limit_price:          orderType === "MARKET" ? null : limitPrice,
        side:                 optType2 === "BTC" ? "BUY" : "SELL",
        status:               "pending_approval",
        dry_run:              true,
        approved_by:          approved_by || null,
        auto_close:           auto_close || false,
        raw_request:          buildOrderPayload({ ticker, opt_type: optType2, type: contract.type, strike: contract.strike, expires, qty: orderQty, limit_price: limitPrice, order_type: orderType, duration: orderDuration, special_instruction: specialInstr }),
      };

      // Run safety checks
      const safetyErrors = runSafetyChecks(order);
      if (safetyErrors.length) {
        return res.status(400).json({ error: "Safety check failed", details: safetyErrors });
      }

      // Save to trade_orders
      const saved = await dbInsert("trade_orders", order);

      return res.status(200).json({
        ok: true,
        order: saved,
        livePrice,
        preview: {
          action:        `${optType2} ${orderQty} × ${ticker} $${contract.strike} ${contract.type} ${expires}`,
          limitPrice:    `$${limitPrice.toFixed(2)} (mid)`,
          estimatedCost: `$${(limitPrice * orderQty * 100).toFixed(2)}`,
          account:       contract.account,
          message:       "Order saved. Approve to submit to Schwab.",
        },
      });
    }

    // ── POST: approve and submit order ────────────────────────────────────────
    if (req.method === "POST" && action === "approve") {
      const { orderId, approved_by, dry_run, limit_price: overridePrice, order_type, duration, special_instruction } = req.body;
      if (!orderId) return res.status(400).json({ error: "Missing orderId" });

      const rows  = await dbGet(`trade_orders?id=eq.${orderId}`);
      const order = rows?.[0];
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.status !== "pending_approval") {
        return res.status(400).json({ error: `Order is ${order.status}, not pending_approval` });
      }

      const isDryRun = dry_run !== false; // default to dry run unless explicitly false

      // Apply overrides from approval request to order object
      if (overridePrice != null)   order.limit_price          = +overridePrice;
      if (order_type)              order.order_type            = order_type;
      if (duration)                order.duration              = duration;
      if (special_instruction)     order.special_instruction   = special_instruction;

      if (isDryRun) {
        // Dry run — log approval with final controls but don't submit
        const updated = await dbUpdate("trade_orders", orderId, {
          status:               "dry_run_approved",
          dry_run:              true,
          approved_by:          approved_by || "user",
          approved_at:          new Date().toISOString(),
          limit_price:          order.limit_price,
          order_type:           order.order_type,
          duration:             order.duration,
          special_instruction:  order.special_instruction,
          notes:                "Dry run — order not submitted to Schwab",
        });
        sendPushover("🧪 Dry Run Approved", orderSummary({...order}), `${APP_URL}/?tab=contracts`, 0).catch(()=>{});
        return res.status(200).json({
          ok: true, dryRun: true, order: updated,
          message: "Dry run approved. Set dry_run: false to submit a real order.",
        });
      }

      // Real submission — build payload with final controls
      const token   = await getValidToken();
      const hash    = await getAccountHash(token, order.account);

      // Use override price if provided — avoids a second Schwab API call
      // which can trigger rate limiting immediately after preview
      if (!overridePrice) {
        try {
          const livePrice = await getLivePrice(token, order.ticker, order.expires, order.type, order.strike);
          if (livePrice) order.limit_price = livePrice.mid;
        } catch (e) {
          console.warn("[schwab-orders] getLivePrice in approve failed, using stored price:", e.message);
        }
      }

      const payload = buildOrderPayload(order);

      console.log("[schwab-orders] Submitting order:", JSON.stringify(payload));

      // Submit with retries on 429 — Schwab burst limit requires 60s backoff
      // but Vercel times out at 10s so we can only do a short retry here.
      // If still 429 after retries, return retryable error to UI.
      let submitRes;
      const delays = [2000, 3000];
      for (let attempt = 1; attempt <= 3; attempt++) {
        submitRes = await fetch(
          `${SCHWAB_BASE}/trader/v1/accounts/${hash}/orders`,
          {
            method:  "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
            body:    JSON.stringify(payload),
          }
        );
        if (submitRes.status !== 429) break;
        if (attempt < 3) {
          const wait = delays[attempt - 1];
          console.log(`[schwab-orders] 429 burst limit on attempt ${attempt}, waiting ${wait/1000}s...`);
          await new Promise(r => setTimeout(r, wait));
        }
      }

      // If still 429, return a user-friendly retryable error
      if (submitRes.status === 429) {
        return res.status(429).json({
          error: "Schwab rate limit hit (429). Please wait 60 seconds and try again. Your order has NOT been submitted.",
          retryable: true,
        });
      }

      // Schwab returns 201 with Location header on success, no body
      const schwabOrderId = submitRes.headers.get("Location")?.split("/").pop() ?? null;
      const submitBody    = submitRes.status !== 201 ? await submitRes.text() : null;

      if (submitRes.status !== 201) {
        await dbUpdate("trade_orders", orderId, {
          status:       "error",
          error_msg:    submitBody,
          raw_response: { status: submitRes.status, body: submitBody },
        });
        return res.status(500).json({ error: `Schwab rejected order: ${submitBody}` });
      }

      const updated = await dbUpdate("trade_orders", orderId, {
        status:         "submitted",
        dry_run:        false,
        schwab_order_id: schwabOrderId,
        submitted_at:   new Date().toISOString(),
        approved_by:    approved_by || "user",
        approved_at:    new Date().toISOString(),
        limit_price:    order.limit_price,
        raw_request:    payload,
      });

      await sendPushover(
        `✅ Order Submitted: ${order.ticker}`,
        orderSummary({...order, limit_price: order.limit_price}),
        `${APP_URL}/?tab=contracts`,
        1
      );

      return res.status(200).json({ ok: true, dryRun: false, order: updated, schwabOrderId });
    }

    // ── POST: cancel order ────────────────────────────────────────────────────
    if (req.method === "POST" && action === "cancel") {
      const { orderId } = req.body;
      if (!orderId) return res.status(400).json({ error: "Missing orderId" });
      const orderIdInt = parseInt(orderId, 10);
      if (isNaN(orderIdInt)) return res.status(400).json({ error: "Invalid orderId" });

      const rows  = await dbGet(`trade_orders?id=eq.${orderIdInt}`);
      const order = rows?.[0];
      if (!order) return res.status(404).json({ error: `Order ${orderIdInt} not found` });

      // If pending_approval — just mark cancelled, no Schwab call needed
      if (order.status === "pending_approval" || order.status === "dry_run_approved") {
        const updated = await dbUpdate("trade_orders", orderIdInt, {
          status:       "cancelled",
          cancelled_at: new Date().toISOString(),
        });
        sendPushover("❌ Order Cancelled", orderSummary(order), `${APP_URL}/?tab=contracts`, 0).catch(()=>{});
        return res.status(200).json({ ok: true, order: updated });
      }

      if (order.status === "submitted" && order.schwab_order_id) {
        const token = await getValidToken();
        const hash  = await getAccountHash(token, order.account);
        const r     = await fetch(
          `${SCHWAB_BASE}/trader/v1/accounts/${hash}/orders/${order.schwab_order_id}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
        );
        // Schwab returns 200 or 204 on success
        // 400 with REJECTED means Schwab already rejected it — just clean up our DB
        if (r.status !== 200 && r.status !== 204) {
          const body = await r.text().catch(()=>"");
          const isRejected = body.includes("REJECTED") || body.includes("cannot be canceled");
          if (!isRejected) {
            console.error("[schwab-orders] cancel failed:", r.status, body);
            return res.status(500).json({ error: `Schwab cancel failed: HTTP ${r.status} ${body}` });
          }
          console.log("[schwab-orders] Order was REJECTED at Schwab, cleaning up DB");
        }
        const updated = await dbUpdate("trade_orders", orderIdInt, {
          status:       "cancelled",
          cancelled_at: new Date().toISOString(),
        });
        sendPushover("❌ Order Cancelled at Schwab", orderSummary(order), `${APP_URL}/?tab=contracts`, 0).catch(()=>{});
        return res.status(200).json({ ok: true, order: updated });
      }

      return res.status(400).json({ error: `Cannot cancel order with status: ${order.status}` });
    }

    // ── ETrade: order-preview ─────────────────────────────────────────────────
    if (req.method === "POST" && action === "order-preview") {
      const { contract_id, qty, limit_price: overridePrice, order_type = "LIMIT", duration = "DAY", special_instruction = "NONE" } = req.body;
      if (!contract_id) return res.status(400).json({ error: "Missing contract_id" });

      const contracts = await dbGet(`contracts?id=eq.${contract_id}&select=*`);
      const contract  = contracts?.[0];
      if (!contract) return res.status(404).json({ error: "Contract not found" });
      if (contract.status !== "Open") return res.status(400).json({ error: "Contract is not open" });

      const existing = await dbGet(`trade_orders?contract_id=eq.${contract_id}&status=in.(pending_approval,dry_run_approved,submitted)`);
      if (existing?.length > 0) return res.status(400).json({ error: `A ${existing[0].opt_type} order already exists. Cancel it first.` });

      // Use Schwab for live quotes
      let livePrice = null;
      try {
        const token = await getValidToken();
        livePrice   = await getLivePrice(token, contract.stock, contract.expires, contract.type, contract.strike);
      } catch (e) { console.warn("[etrade order-preview] Schwab quote failed:", e.message); }

      const acctData  = await etradeRequest("GET", "/v1/accounts/list");
      const eAccounts = acctData?.AccountListResponse?.Accounts?.Account || [];
      const accountId = ETRADE_ACCOUNTS[contract.account];
      const acct      = eAccounts.find(a => String(a.accountId) === String(accountId));
      if (!acct) return res.status(400).json({ error: `ETrade account not found for ${contract.account}` });

      const closingAction = contract.opt_type === "STO" ? "BUY_CLOSE" : "SELL_CLOSE";
      const orderQty      = qty || contract.qty;
      const limitPrice    = overridePrice ?? livePrice?.mid ?? null;
      const expires       = new Date(contract.expires);

      const previewPayload = {
        PreviewOrderRequest: {
          orderType: "OPTN", clientOrderId: `app_${Date.now()}`,
          Order: [{
            allOrNone: special_instruction === "ALL_OR_NONE" ? "true" : "false",
            priceType: order_type === "MARKET" ? "MARKET" : "LIMIT",
            ...(order_type !== "MARKET" && limitPrice != null ? { limitPrice } : {}),
            orderTerm: duration === "GTC" ? "GOOD_UNTIL_CANCEL" : "GOOD_FOR_DAY",
            marketSession: "REGULAR",
            Instrument: [{
              Product: {
                securityType: "OPTN", symbol: contract.stock,
                callPut: contract.type.toUpperCase(),
                expiryYear: expires.getFullYear(), expiryMonth: expires.getMonth() + 1, expiryDay: expires.getDate(),
                strikePrice: contract.strike,
              },
              orderAction: closingAction, quantityType: "QUANTITY", quantity: orderQty,
            }],
          }],
        },
      };

      const previewRes = await etradeRequest("POST", `/v1/accounts/${acct.accountIdKey}/orders/preview.json`, previewPayload);
      const previewId  = previewRes?.PreviewOrderResponse?.PreviewIds?.[0]?.previewId;
      if (!previewId) return res.status(500).json({ error: "ETrade preview failed — no previewId", details: previewRes });

      const saved = await dbInsert("trade_orders", {
        contract_id, account: contract.account, ticker: contract.stock,
        opt_type: closingAction === "BUY_CLOSE" ? "BTC" : "STC",
        type: contract.type, strike: contract.strike, expires: contract.expires,
        qty: orderQty, order_type, duration, special_instruction,
        limit_price: order_type !== "MARKET" ? limitPrice : null,
        side: closingAction.startsWith("BUY") ? "BUY" : "SELL",
        status: "pending_approval", dry_run: true,
        raw_request: { ...previewPayload, previewId, accountIdKey: acct.accountIdKey },
      });

      return res.status(200).json({
        ok: true, previewId, order: saved, livePrice,
        preview: {
          action: `${closingAction === "BUY_CLOSE" ? "BTC" : "STC"} ${orderQty} × ${contract.stock} $${contract.strike} ${contract.type} ${contract.expires}`,
          limitPrice: limitPrice != null ? `$${Number(limitPrice).toFixed(2)} (mid)` : "MARKET",
          estimatedCost: limitPrice != null ? `$${(limitPrice * orderQty * 100).toFixed(2)}` : "—",
          account: contract.account,
        },
      });
    }

    // ── ETrade: order-place ───────────────────────────────────────────────────
    if (req.method === "POST" && action === "order-place") {
      const { orderId, dry_run, limit_price: overridePrice, order_type, duration, special_instruction } = req.body;
      if (!orderId) return res.status(400).json({ error: "Missing orderId" });

      const rows  = await dbGet(`trade_orders?id=eq.${parseInt(orderId,10)}`);
      const order = rows?.[0];
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.status !== "pending_approval") return res.status(400).json({ error: `Order is ${order.status}` });

      if (overridePrice != null) order.limit_price        = +overridePrice;
      if (order_type)            order.order_type          = order_type;
      if (duration)              order.duration            = duration;
      if (special_instruction)   order.special_instruction = special_instruction;

      if (dry_run !== false) {
        const updated = await dbUpdate("trade_orders", orderId, { status: "dry_run_approved", dry_run: true, approved_at: new Date().toISOString(), limit_price: order.limit_price, notes: "Dry run — not submitted to ETrade" });
        sendPushover("🧪 ETrade Dry Run Approved", orderSummary(order), `${APP_URL}/?tab=contracts`, 0).catch(()=>{});
        return res.status(200).json({ ok: true, dryRun: true, order: updated });
      }

      const previewId    = order.raw_request?.previewId;
      const accountIdKey = order.raw_request?.accountIdKey;
      if (!previewId || !accountIdKey) return res.status(400).json({ error: "Missing previewId — re-preview the order" });

      const expires       = new Date(order.expires);
      const closingAction = order.opt_type === "BTC" ? "BUY_CLOSE" : "SELL_CLOSE";

      const placePayload = {
        PlaceOrderRequest: {
          orderType: "OPTN", clientOrderId: `app_${Date.now()}`,
          PreviewIds: [{ previewId }],
          Order: [{
            allOrNone: order.special_instruction === "ALL_OR_NONE" ? "true" : "false",
            priceType: order.order_type === "MARKET" ? "MARKET" : "LIMIT",
            ...(order.order_type !== "MARKET" && order.limit_price != null ? { limitPrice: order.limit_price } : {}),
            orderTerm: order.duration === "GTC" ? "GOOD_UNTIL_CANCEL" : "GOOD_FOR_DAY",
            marketSession: "REGULAR",
            Instrument: [{
              Product: {
                securityType: "OPTN", symbol: order.ticker,
                callPut: order.type.toUpperCase(),
                expiryYear: expires.getFullYear(), expiryMonth: expires.getMonth() + 1, expiryDay: expires.getDate(),
                strikePrice: order.strike,
              },
              orderAction: closingAction, quantityType: "QUANTITY", quantity: order.qty,
            }],
          }],
        },
      };

      const placeRes      = await etradeRequest("POST", `/v1/accounts/${accountIdKey}/orders/place.json`, placePayload);
      const etradeOrderId = placeRes?.PlaceOrderResponse?.OrderIds?.[0]?.orderId;
      if (!etradeOrderId) {
        await dbUpdate("trade_orders", orderId, { status: "error", error_msg: JSON.stringify(placeRes) });
        return res.status(500).json({ error: "ETrade order failed", details: placeRes });
      }

      const updated = await dbUpdate("trade_orders", orderId, { status: "submitted", dry_run: false, schwab_order_id: String(etradeOrderId), submitted_at: new Date().toISOString(), limit_price: order.limit_price, raw_request: { ...placePayload, accountIdKey } });
      sendPushover(`✅ ETrade Order Submitted: ${order.ticker}`, orderSummary(order), `${APP_URL}/?tab=contracts`, 1).catch(()=>{});
      return res.status(200).json({ ok: true, dryRun: false, order: updated, etradeOrderId });
    }

    // ── ETrade: order-cancel ──────────────────────────────────────────────────
    if (req.method === "POST" && action === "order-cancel") {
      const { orderId } = req.body;
      if (!orderId) return res.status(400).json({ error: "Missing orderId" });
      const orderIdInt = parseInt(orderId, 10);

      const rows  = await dbGet(`trade_orders?id=eq.${orderIdInt}`);
      const order = rows?.[0];
      if (!order) return res.status(404).json({ error: `Order ${orderIdInt} not found` });

      if (["pending_approval","dry_run_approved"].includes(order.status)) {
        await dbUpdate("trade_orders", orderIdInt, { status: "cancelled", cancelled_at: new Date().toISOString() });
        sendPushover("❌ ETrade Order Cancelled", orderSummary(order), `${APP_URL}/?tab=contracts`, 0).catch(()=>{});
        return res.status(200).json({ ok: true });
      }

      if (order.status === "submitted" && order.schwab_order_id) {
        const accountIdKey = order.raw_request?.accountIdKey;
        if (!accountIdKey) return res.status(400).json({ error: "Missing accountIdKey — cannot cancel at ETrade" });

        const cancelRes = await etradeRequest("PUT", `/v1/accounts/${accountIdKey}/orders/cancel.json`, {
          CancelOrderRequest: { orderId: parseInt(order.schwab_order_id, 10) }
        });
        console.log("[etrade order-cancel] response:", JSON.stringify(cancelRes));

        // Check if cancel succeeded
        const cancelledId = cancelRes?.CancelOrderResponse?.orderId;
        if (!cancelledId) {
          // ETrade may have rejected — report back but still let user force-cancel in DB
          console.warn("[etrade order-cancel] no orderId in response:", JSON.stringify(cancelRes));
        }

        await dbUpdate("trade_orders", orderIdInt, { status: "cancelled", cancelled_at: new Date().toISOString(), raw_response: cancelRes });
        sendPushover("❌ ETrade Order Cancelled", orderSummary(order), `${APP_URL}/?tab=contracts`, 0).catch(()=>{});
        return res.status(200).json({ ok: true, etradeResponse: cancelRes });
      }

      return res.status(400).json({ error: `Cannot cancel order with status: ${order.status}` });
    }

    // ── ETrade: preview new opening order (STO/BTO) ───────────────────────────
    if (req.method === "POST" && action === "etrade-preview-new") {
      const { ticker, type, strike, expires, opt_type, qty, limit_price: overridePrice, order_type = "LIMIT", duration = "DAY", special_instruction = "NONE", account } = req.body;
      if (!ticker || !type || !strike || !expires || !opt_type || !qty || !account) {
        return res.status(400).json({ error: "Missing required fields: ticker, type, strike, expires, opt_type, qty, account" });
      }

      // Use Schwab for live price
      let livePrice = null;
      try {
        const token = await getValidToken();
        livePrice   = await getLivePrice(token, ticker, expires, type, strike);
      } catch(e) { console.warn("[etrade-preview-new] Schwab quote failed:", e.message); }

      // Find ETrade account
      const acctData  = await etradeRequest("GET", "/v1/accounts/list");
      const eAccounts = acctData?.AccountListResponse?.Accounts?.Account || [];
      const accountId = ETRADE_ACCOUNTS[account];
      const acct      = eAccounts.find(a => String(a.accountId) === String(accountId));
      if (!acct) return res.status(400).json({ error: `ETrade account not found for ${account}` });

      const openingAction = opt_type === "STO" ? "SELL_OPEN" : "BUY_OPEN";
      const limitPrice    = overridePrice ?? livePrice?.mid ?? null;
      const expDate       = new Date(expires);

      const previewPayload = {
        PreviewOrderRequest: {
          orderType: "OPTN", clientOrderId: `app_${Date.now()}`,
          Order: [{
            allOrNone: special_instruction === "ALL_OR_NONE" ? "true" : "false",
            priceType: order_type === "MARKET" ? "MARKET" : "LIMIT",
            ...(order_type !== "MARKET" && limitPrice != null ? { limitPrice } : {}),
            orderTerm: duration === "GTC" ? "GOOD_UNTIL_CANCEL" : "GOOD_FOR_DAY",
            marketSession: "REGULAR",
            Instrument: [{
              Product: {
                securityType: "OPTN", symbol: ticker,
                callPut: type.toUpperCase(),
                expiryYear: expDate.getFullYear(), expiryMonth: expDate.getMonth() + 1, expiryDay: expDate.getDate(),
                strikePrice: +strike,
              },
              orderAction: openingAction, quantityType: "QUANTITY", quantity: +qty,
            }],
          }],
        },
      };

      const previewRes = await etradeRequest("POST", `/v1/accounts/${acct.accountIdKey}/orders/preview.json`, previewPayload);
      const previewId  = previewRes?.PreviewOrderResponse?.PreviewIds?.[0]?.previewId;
      if (!previewId) return res.status(500).json({ error: "ETrade preview failed — no previewId", details: previewRes });

      const saved = await dbInsert("trade_orders", {
        account, ticker, opt_type, type, strike: +strike, expires,
        qty: +qty, order_type, duration, special_instruction,
        limit_price: order_type !== "MARKET" ? limitPrice : null,
        side: opt_type === "STO" ? "SELL" : "BUY",
        status: "pending_approval", dry_run: true,
        raw_request: { ...previewPayload, previewId, accountIdKey: acct.accountIdKey },
      });

      return res.status(200).json({
        ok: true, previewId, order: saved, livePrice,
        preview: {
          action:        `${opt_type} ${qty} × ${ticker} $${strike} ${type} ${expires}`,
          limitPrice:    limitPrice != null ? `$${Number(limitPrice).toFixed(2)} (mid)` : "MARKET",
          estimatedCost: limitPrice != null ? `$${(limitPrice * qty * 100).toFixed(2)}` : "—",
          account,
          message: "Order saved. Approve to submit to ETrade.",
        },
      });
    }

    // ── ETrade: place new opening order (STO/BTO) ─────────────────────────────
    if (req.method === "POST" && action === "etrade-place-new") {
      const { orderId, dry_run, limit_price: overridePrice, order_type, duration } = req.body;
      if (!orderId) return res.status(400).json({ error: "Missing orderId" });

      const rows  = await dbGet(`trade_orders?id=eq.${parseInt(orderId, 10)}`);
      const order = rows?.[0];
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.status !== "pending_approval") return res.status(400).json({ error: `Order is ${order.status}` });

      if (overridePrice != null) order.limit_price = +overridePrice;
      if (order_type)            order.order_type   = order_type;
      if (duration)              order.duration      = duration;

      if (dry_run !== false) {
        const updated = await dbUpdate("trade_orders", orderId, { status: "dry_run_approved", dry_run: true, approved_at: new Date().toISOString(), limit_price: order.limit_price, notes: "Dry run — not submitted to ETrade" });
        sendPushover("🧪 ETrade Dry Run Approved", orderSummary(order), `${APP_URL}/?tab=contracts`, 0).catch(()=>{});
        return res.status(200).json({ ok: true, dryRun: true, order: updated });
      }

      const previewId    = order.raw_request?.previewId;
      const accountIdKey = order.raw_request?.accountIdKey;
      if (!previewId || !accountIdKey) return res.status(400).json({ error: "Missing previewId — re-preview the order" });

      const openingAction = order.opt_type === "STO" ? "SELL_OPEN" : "BUY_OPEN";
      const expDate       = new Date(order.expires);

      const placePayload = {
        PlaceOrderRequest: {
          orderType: "OPTN", clientOrderId: `app_${Date.now()}`,
          PreviewIds: [{ previewId }],
          Order: [{
            allOrNone: order.special_instruction === "ALL_OR_NONE" ? "true" : "false",
            priceType: order.order_type === "MARKET" ? "MARKET" : "LIMIT",
            ...(order.order_type !== "MARKET" && order.limit_price != null ? { limitPrice: order.limit_price } : {}),
            orderTerm: order.duration === "GTC" ? "GOOD_UNTIL_CANCEL" : "GOOD_FOR_DAY",
            marketSession: "REGULAR",
            Instrument: [{
              Product: {
                securityType: "OPTN", symbol: order.ticker,
                callPut: order.type.toUpperCase(),
                expiryYear: expDate.getFullYear(), expiryMonth: expDate.getMonth() + 1, expiryDay: expDate.getDate(),
                strikePrice: order.strike,
              },
              orderAction: openingAction, quantityType: "QUANTITY", quantity: order.qty,
            }],
          }],
        },
      };

      const placeRes      = await etradeRequest("POST", `/v1/accounts/${accountIdKey}/orders/place.json`, placePayload);
      const etradeOrderId = placeRes?.PlaceOrderResponse?.OrderIds?.[0]?.orderId;
      if (!etradeOrderId) {
        await dbUpdate("trade_orders", orderId, { status: "error", error_msg: JSON.stringify(placeRes) });
        return res.status(500).json({ error: "ETrade order failed", details: placeRes });
      }

      const updated = await dbUpdate("trade_orders", orderId, {
        status: "submitted", dry_run: false,
        schwab_order_id: String(etradeOrderId),
        submitted_at: new Date().toISOString(),
        limit_price: order.limit_price,
        raw_request: { ...placePayload, accountIdKey },
      });
      sendPushover(`✅ ETrade Order Submitted: ${order.ticker}`, orderSummary(order), `${APP_URL}/?tab=contracts`, 1).catch(()=>{});
      return res.status(200).json({ ok: true, dryRun: false, order: updated, etradeOrderId });
    }

    // ── GET: transactions (absorbed from schwab-transactions.js) ─────────────
    // Called by ImportPage.jsx as: /api/schwab-orders?action=transactions&days=30
    // Also accepts: startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
    if (req.method === "GET" && action === "transactions") {
      const txToken = await getValidToken();
      return await handleTransactions(req, res, txToken);
    }

    // ── POST: reprice — change limit price on a submitted order ─────────────────
    if (req.method === "POST" && action === "reprice") {
      const { orderId, newPrice, reason = "manual" } = req.body;
      if (!orderId || newPrice == null) return res.status(400).json({ error: "Missing orderId or newPrice" });
      const rows  = await dbGet(`trade_orders?id=eq.${parseInt(orderId,10)}`);
      const order = rows?.[0];
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (!["submitted","pending_approval","dry_run_approved"].includes(order.status)) {
        return res.status(400).json({ error: `Cannot reprice order with status: ${order.status}` });
      }

      // Track price history
      const history = Array.isArray(order.price_history) ? order.price_history : [];
      history.push({ price: +(order.limit_price||0), at: new Date().toISOString(), reason: "before_reprice" });

      let newSchwabOrderId = order.schwab_order_id;

      // If submitted to Schwab, cancel + resubmit
      if (order.status === "submitted" && order.schwab_order_id && !order.account?.includes("ETrade")) {
        const hash = "757F62A9417DA1B75005EAC7370D033ABF819061E60384AA3B0F68A0AAE94961";
        const cancelRes = await fetch(
          `${SCHWAB_BASE}/trader/v1/accounts/${hash}/orders/${order.schwab_order_id}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${await getValidToken()}` } }
        );
        if (cancelRes.status !== 200 && cancelRes.status !== 204) {
          return res.status(500).json({ error: `Cancel failed: HTTP ${cancelRes.status}` });
        }
        const token = await getValidToken();
        const osi = order.raw_request?.orderLegCollection?.[0]?.instrument?.symbol;
        const instruction = { STO:"SELL_TO_OPEN", BTO:"BUY_TO_OPEN", STC:"SELL_TO_CLOSE", BTC:"BUY_TO_CLOSE" }[order.opt_type];
        const payload = {
          orderType:"LIMIT", session:"NORMAL", duration:"DAY",
          price: (+newPrice).toFixed(2),
          orderLegCollection: [{ instruction, quantity: order.qty, instrument: { symbol: osi, assetType:"OPTION" } }],
        };
        const submitRes = await fetch(`${SCHWAB_BASE}/trader/v1/accounts/${hash}/orders`, {
          method:"POST", headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json" }, body:JSON.stringify(payload)
        });
        if (submitRes.status !== 201) {
          const body = await submitRes.text().catch(()=>"");
          return res.status(500).json({ error: `Resubmit failed: ${body}` });
        }
        newSchwabOrderId = submitRes.headers.get("Location")?.split("/").pop() ?? order.schwab_order_id;
      }

      history.push({ price: +newPrice, at: new Date().toISOString(), reason });
      const updated = await dbUpdate("trade_orders", parseInt(orderId,10), {
        limit_price:     +newPrice,
        schwab_order_id: newSchwabOrderId,
        submitted_at:    new Date().toISOString(),
        price_history:   history,
      });
      return res.status(200).json({ ok: true, order: updated });
    }

    // ── POST: chase-start — activate price chasing on a submitted order ────────
    if (req.method === "POST" && action === "chase-start") {
      const { orderId, chaseFloor, chaseStep = 0.05 } = req.body;
      if (!orderId) return res.status(400).json({ error: "Missing orderId" });
      if (chaseFloor == null) return res.status(400).json({ error: "Missing chaseFloor" });
      const rows  = await dbGet(`trade_orders?id=eq.${parseInt(orderId, 10)}`);
      const order = rows?.[0];
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (!["submitted","pending_approval","dry_run_approved"].includes(order.status)) {
        return res.status(400).json({ error: `Cannot chase order with status: ${order.status}` });
      }
      const updated = await dbUpdate("trade_orders", parseInt(orderId, 10), {
        chase_active: true,
        chase_floor:  +chaseFloor,
        chase_step:   +chaseStep,
      });
      sendPushover(`🎯 Chase Started: ${order.ticker}`, `${orderSummary(order)} · Floor $${(+chaseFloor).toFixed(2)} · Step $${(+chaseStep).toFixed(2)}`, `${APP_URL}/?tab=contracts`, 0).catch(()=>{});
      return res.status(200).json({ ok: true, order: updated });
    }

    // ── POST: chase-stop — deactivate price chasing ──────────────────────────
    if (req.method === "POST" && action === "chase-stop") {
      const { orderId } = req.body;
      if (!orderId) return res.status(400).json({ error: "Missing orderId" });
      const updated = await dbUpdate("trade_orders", parseInt(orderId, 10), { chase_active: false });
      return res.status(200).json({ ok: true, order: updated });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error("[schwab-orders]", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── Transactions handler (absorbed from schwab-transactions.js) ──────────────
// Fetches option transactions from Schwab, parses them, fetches stock prices,
// and auto-matches closing trades to their opening counterparts in Supabase.

async function schwabFetchTx(path, params = {}, token) {
  const qs  = Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`${SCHWAB_BASE}${path}${qs}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Schwab ${res.status} ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

const TX_TYPE_MAP = { "Bought To Open": "BTO", "Sold To Open": "STO", "Bought To Close": "BTC", "Sold To Close": "STC" };

function parseSchwabTransaction(tx) {
  const items   = tx.transferItems ?? [];
  const optItem = items.find(i => i.instrument?.assetType === "OPTION");
  if (!optItem) return null;

  const inst           = optItem.instrument;
  const positionEffect = optItem.positionEffect?.toUpperCase();
  const itemAmount     = optItem.amount ?? 0;
  const isBuy          = itemAmount > 0;
  const isSell         = itemAmount < 0;

  let optType = null;
  if      (isBuy  && positionEffect === "OPENING") optType = "BTO";
  else if (isSell && positionEffect === "OPENING") optType = "STO";
  else if (isBuy  && positionEffect === "CLOSING") optType = "BTC";
  else if (isSell && positionEffect === "CLOSING") optType = "STC";
  if (!optType) return null;

  const isOpen    = optType === "BTO" || optType === "STO";
  const callOrPut = inst.putCall?.toUpperCase();
  const qty       = Math.abs(itemAmount);
  const premium   = tx.netAmount ?? 0;
  const tradeDate = tx.tradeDate ? tx.tradeDate.slice(0, 10) : tx.time?.slice(0, 10);
  const expires   = inst.expirationDate ? inst.expirationDate.slice(0, 10) : null;

  return {
    schwabTransactionId: tx.activityId ?? tx.transactionId ?? null,
    stock:   (inst.underlyingSymbol?.toUpperCase() ?? inst.symbol?.trim().split(/\s+/)[0]?.replace(/\d.*$/, "").trim().toUpperCase() ?? null),
    type:    callOrPut === "PUT" ? "Put" : "Call",
    optType, strike: inst.strikePrice ?? null, qty, expires, premium,
    priceAtExecution: null, dateExec: tradeDate, account: "Schwab",
    status: isOpen ? "Open" : "Closed", strategy: null, notes: null, createdVia: "Schwab Import", _raw: tx,
  };
}

async function fetchTxClosingPrice(symbol, date, token) {
  try {
    const target = new Date(date);
    const start  = new Date(target); start.setDate(start.getDate() - 1);
    const end    = new Date(target); end.setDate(end.getDate() + 1);
    const data = await schwabFetchTx("/marketdata/v1/pricehistory", {
      symbol, periodType: "month", frequencyType: "daily", frequency: 1,
      startDate: start.getTime(), endDate: end.getTime(), needExtendedHoursData: false,
    }, token);
    const candles = data?.candles;
    if (!candles?.length) return null;
    const targetMs = target.getTime();
    return candles.reduce((best, c) => Math.abs(c.datetime - targetMs) < Math.abs(best.datetime - targetMs) ? c : best).close ?? null;
  } catch { return null; }
}

async function fetchTxLivePrice(symbol, token) {
  try {
    const data = await schwabFetchTx("/marketdata/v1/quotes", { symbols: symbol, fields: "quote", indicative: false }, token);
    const q = data?.[symbol]?.quote ?? data?.[symbol];
    return q?.lastPrice ?? q?.mark ?? null;
  } catch { return null; }
}

async function loadExistingOpens() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/contracts?select=id,stock,opt_type,strike,expires,qty,account,status&status=eq.Open&order=id.desc&limit=1000`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  return rows.filter(r => r.opt_type === "BTO" || r.opt_type === "STO");
}

function autoMatchTx(closer, dbOpeners, batchOpeners = []) {
  const validOpenerTypes = { BTC: ["BTO", "STO"], STC: ["STO", "BTO"] };
  const targetTypes = validOpenerTypes[closer.optType];
  if (!targetTypes) return null;

  const normalizedBatch = batchOpeners
    .filter(o => targetTypes.includes(o.optType))
    .map(o => ({ id: o._batchIdx, stock: o.stock, opt_type: o.optType, strike: o.strike, expires: o.expires, qty: o.qty, account: o.account, _isBatch: true }));
  const normalizedDB = dbOpeners.filter(o => targetTypes.includes(o.opt_type));

  for (const pool of [normalizedDB, normalizedBatch]) {
    const matches = pool.filter(o => {
      return o.stock?.toUpperCase() === closer.stock?.toUpperCase()
          && Number(o.strike)        === Number(closer.strike)
          && o.expires?.slice(0, 10) === closer.expires;
    });
    if (!matches.length) continue;

    const sameAccount = (o) => o.account?.toLowerCase() === closer.account?.toLowerCase();
    const sameAcctExact = matches.find(o => sameAccount(o) && Number(o.qty) === Number(closer.qty));
    if (sameAcctExact) return { parentId: sameAcctExact.id, matchedContract: sameAcctExact, confidence: "exact" };

    const exactQtyMatches = matches.filter(o => Number(o.qty) === Number(closer.qty));
    if (exactQtyMatches.length === 1) return { parentId: exactQtyMatches[0].id, matchedContract: exactQtyMatches[0], confidence: "exact" };

    const sameAcctMatches = matches.filter(o => sameAccount(o));
    if (sameAcctMatches.length) {
      const best = sameAcctMatches.reduce((a, b) => Math.abs(Number(a.qty) - Number(closer.qty)) < Math.abs(Number(b.qty) - Number(closer.qty)) ? a : b);
      return { parentId: best.id, matchedContract: best, confidence: "partial" };
    }

    const best = matches.reduce((a, b) => Math.abs(Number(a.qty) - Number(closer.qty)) < Math.abs(Number(b.qty) - Number(closer.qty)) ? a : b);
    return { parentId: best.id, matchedContract: best, confidence: "partial" };
  }
  return { parentId: null, matchedContract: null, confidence: "unmatched" };
}

async function handleTransactions(req, res, token) {
  try {
    const today    = new Date();
    const todayStr = new Date(today.getTime() - 5 * 3600000).toISOString().slice(0, 10);
    let startDate, endDate;

    if (req.query.startDate) {
      startDate = req.query.startDate;
      endDate   = req.query.endDate || todayStr;
    } else {
      const days = parseInt(req.query.days ?? "30", 10);
      startDate = new Date(today.getTime() - (days + 1) * 86400000 - 5 * 3600000).toISOString().slice(0, 10);
      endDate   = todayStr;
    }

    const startUTC = startDate + "T05:00:00.000Z";
    const endUTC   = endDate === todayStr
      ? today.toISOString()
      : new Date(new Date(endDate + "T05:00:00.000Z").getTime() + 86400000).toISOString();

    const acctData = await schwabFetchTx("/trader/v1/accounts/accountNumbers", {}, token);
    const accounts = Array.isArray(acctData) ? acctData : [acctData];
    if (!accounts.length) throw new Error("No Schwab accounts found");

    const allRaw = [];
    for (const acct of accounts) {
      const hash = acct.hashValue;
      if (!hash) continue;
      const txData = await schwabFetchTx(`/trader/v1/accounts/${hash}/transactions`, { types: "TRADE", startDate: startUTC, endDate: endUTC }, token);
      const txList = Array.isArray(txData) ? txData : (txData?.transactions ?? []);
      allRaw.push(...txList);
    }

    if (req.query.debug === "1") {
      const debugInfo = allRaw.slice(0, 3).map(tx => {
        const items   = tx.transferItems ?? [];
        const optItem = items.find(i => i.instrument?.assetType === "OPTION");
        const parsed  = parseSchwabTransaction(tx);
        return {
          activityId: tx.activityId, netAmount: tx.netAmount,
          transferItemCount: items.length, assetTypes: items.map(i => i.instrument?.assetType),
          optItemFound: !!optItem, optItemEffect: optItem?.positionEffect, optItemAmount: optItem?.amount,
          parsedResult: parsed ? { optType: parsed.optType, stock: parsed.stock, strike: parsed.strike } : null,
          parseFailReason: !optItem ? "no OPTION in transferItems" : !parsed ? "optType could not be determined" : "ok",
        };
      });
      return res.status(200).json({ debug: debugInfo, rawTotal: allRaw.length });
    }

    const parsed = allRaw.map(parseSchwabTransaction).filter(Boolean);

    // ── Parse + store EQUITY transactions ──────────────────────────────────
    const equityTxs = allRaw.map(tx => {
      const items  = tx.transferItems ?? [];
      const eqItem = items.find(i => i.instrument?.assetType === "EQUITY");
      if (!eqItem) return null;
      const qty = eqItem.amount ?? 0;
      if (qty === 0) return null;
      const tradeDate = tx.tradeDate ? tx.tradeDate.slice(0, 10) : tx.time?.slice(0, 10);
      return {
        schwab_transaction_id: String(tx.activityId ?? tx.transactionId ?? ""),
        symbol:           eqItem.instrument?.symbol?.toUpperCase() ?? null,
        transaction_type: qty > 0 ? "BUY" : "SELL",
        asset_type:       "EQUITY",
        quantity:         Math.abs(qty),
        price:            eqItem.price ?? null,
        net_amount:       tx.netAmount ?? 0,
        trade_date:       tradeDate ? new Date(tradeDate + "T16:00:00Z").toISOString() : null,
        account:          "Schwab",
      };
    }).filter(Boolean);

    if (equityTxs.length) {
      await fetch(`${SUPABASE_URL}/rest/v1/stock_transactions`, {
        method:  "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
        body:    JSON.stringify(equityTxs),
      }).catch(e => console.warn("[transactions] equity upsert failed:", e.message));
      console.log(`[transactions] stored ${equityTxs.length} equity transactions`);
    }

    // Fetch stock prices
    const priceMap    = {};
    const symbolDates = [...new Set(parsed.map(c => `${c.stock}|${c.dateExec}`))];
    for (const key of symbolDates) {
      const [symbol, date] = key.split("|");
      if (!symbol || !date) continue;
      priceMap[key] = date === todayStr
        ? await fetchTxLivePrice(symbol, token)
        : await fetchTxClosingPrice(symbol, date, token);
    }
    for (const c of parsed) {
      const key = `${c.stock}|${c.dateExec}`;
      c.priceAtExecution     = priceMap[key] ?? null;
      c.priceAtExecutionAuto = priceMap[key] !== null;
      c.priceAtExecutionType = c.dateExec === todayStr ? "live" : "closing";
    }

    // Detect split fills
    const orderGroups = {};
    for (const c of parsed) {
      const orderId = c._raw?.orderId;
      if (!orderId) continue;
      const key = `${orderId}|${c.stock}|${c.strike}|${c.expires}|${c.optType}`;
      if (!orderGroups[key]) orderGroups[key] = [];
      orderGroups[key].push(c);
    }
    for (const group of Object.values(orderGroups)) {
      if (group.length < 2) continue;
      const orderId    = group[0]._raw?.orderId;
      const splitTotal = group.reduce((s, c) => s + Number(c.qty), 0);
      for (let i = 0; i < group.length; i++) {
        group[i].splitGroup = String(orderId);
        group[i].splitIndex = i + 1;
        group[i].splitCount = group.length;
        group[i].splitTotal = splitTotal;
      }
    }

    // Auto-link closers to openers
    const existingOpens  = await loadExistingOpens();
    const batchOpeners   = parsed.filter(c => c.optType === "BTO" || c.optType === "STO").map((c, i) => ({ ...c, _batchIdx: `batch_${i}` }));
    for (const c of parsed) {
      if (c.optType === "BTC" || c.optType === "STC") {
        const qtyForMatch = c.splitTotal ?? c.qty;
        const match = autoMatchTx({ ...c, qty: qtyForMatch }, existingOpens, batchOpeners);
        c.parentId        = match?.parentId ?? null;
        c.matchedContract = match?.matchedContract ?? null;
        c.matchConfidence = c.splitGroup && match?.confidence !== "unmatched" ? "split" : (match?.confidence ?? "unmatched");
      } else {
        c.parentId = null; c.matchedContract = null; c.matchConfidence = null;
      }
    }

    return res.status(200).json({
      transactions: parsed,
      openContracts: existingOpens,
      meta: { startDate, endDate, total: parsed.length, rawTotal: allRaw.length },
    });
  } catch (err) {
    console.error("[schwab-orders/transactions]", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── ETrade OAuth helper ───────────────────────────────────────────────────────
const ETRADE_BASE     = "https://api.etrade.com";
const ETRADE_ACCOUNTS = { "ETrade 6917": "227156917", "ETrade 8222": "227418222" };

function pctEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g,"%21").replace(/'/g,"%27").replace(/\(/g,"%28").replace(/\)/g,"%29").replace(/\*/g,"%2A");
}

async function etradeRequest(method, path, body = null, queryParams = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.etrade_tokens`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const t = (await r.json())?.[0]?.cols;
  if (!t?.accessToken) throw new Error("No ETrade token — re-authorize at /api/etrade?action=auth");

  const urlBase = `${ETRADE_BASE}${path}`;
  const oauthParams = {
    oauth_consumer_key:     process.env.ETRADE_CONSUMER_KEY,
    oauth_token:            t.accessToken,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_nonce:            crypto.randomBytes(16).toString("hex"),
    oauth_version:          "1.0",
  };
  const allParams   = method === "GET" ? { ...oauthParams, ...queryParams } : oauthParams;
  const paramString = Object.keys(allParams).sort().map(k => `${pctEncode(k)}=${pctEncode(allParams[k])}`).join("&");
  const baseString  = [method, pctEncode(urlBase), pctEncode(paramString)].join("&");
  const signingKey  = `${pctEncode(process.env.ETRADE_CONSUMER_SECRET)}&${pctEncode(t.accessTokenSecret)}`;
  oauthParams.oauth_signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
  const authHeader  = "OAuth " + Object.keys(oauthParams).map(k => `${pctEncode(k)}="${pctEncode(oauthParams[k])}"`).join(", ");

  const qs   = Object.keys(queryParams).length ? "?" + new URLSearchParams(queryParams).toString() : "";
  const opts = { method, headers: { Authorization: authHeader, Accept: "application/json" } };
  if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }

  const res  = await fetch(urlBase + qs, opts);
  const text = await res.text();
  if (!text || text.trim() === "") return {};
  if (text.trim().startsWith("<")) throw new Error(`ETrade returned XML (${res.status})`);
  const data = JSON.parse(text);
  if (!res.ok) throw new Error(`ETrade ${res.status}: ${data?.Error?.message || text.slice(0,200)}`);
  return data;
}
