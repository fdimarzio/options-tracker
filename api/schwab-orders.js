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

  // Only allow closing existing open contracts for now
  if (!["BTC", "STC"].includes(order.opt_type)) {
    errors.push(`Only closing orders (BTC/STC) are allowed at this time`);
  }

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

      // If submitted, check live status from Schwab
      if (order.schwab_order_id && !order.filled_at && !order.cancelled_at) {
        const token = await getValidToken();
        const hash  = await getAccountHash(token, order.account);
        const r     = await fetch(
          `${SCHWAB_BASE}/trader/v1/accounts/${hash}/orders/${order.schwab_order_id}`,
          { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
        );

        // Handle order not found at Schwab
        if (r.status === 404) {
          return res.status(200).json({ ok: true, order, schwabStatus: null, message: "Order not found at Schwab — may not have been provisioned." });
        }

        const schwabOrder = r.ok ? await r.json() : null;
        if (!schwabOrder) {
          return res.status(200).json({ ok: true, order, schwabStatus: null, message: `Schwab returned HTTP ${r.status}` });
        }

        // Update status based on Schwab response — only auto-update on FILLED
        // Don't auto-cancel on CANCELED/REJECTED — may be a provisioning issue,
        // let the user see the status and decide
        let patch = { raw_response: schwabOrder };
        if (schwabOrder.status === "FILLED") {
          const leg = schwabOrder.orderActivityCollection?.[0];
          patch = {
            ...patch,
            status:     "filled",
            filled_at:  new Date().toISOString(),
            fill_price: leg?.executionLegs?.[0]?.price ?? null,
            fill_qty:   schwabOrder.filledQuantity ?? order.qty,
          };
          sendPushover(
            `✅ Order Filled: ${order.ticker}`,
            `${orderSummary(order)}\nFill price: $${patch.fill_price?.toFixed(2) ?? "—"} · ${patch.fill_qty} contracts`,
            `${APP_URL}/?tab=contracts`,
            1
          ).catch(()=>{});
        }
        // Just save raw response for other statuses — don't change our status
        const updated = await dbUpdate("trade_orders", orderId, patch);
        return res.status(200).json({ ok: true, order: updated, schwabStatus: schwabOrder.status });
      }

      return res.status(200).json({ ok: true, order });
    }

    // ── POST: preview order ───────────────────────────────────────────────────
    if (req.method === "POST" && action === "preview") {
      const body = req.body;
      const { contract_id, qty, approved_by, limit_price: overridePrice, order_type, duration, special_instruction } = body;

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

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error("[schwab-orders]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
