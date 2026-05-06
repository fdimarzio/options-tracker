// api/etrade.js
// Combined ETrade API handler — OAuth 1.0a signing, auth flow, account discovery, transactions
//
// Actions:
//   ?action=auth                                        — step 1: get request token + ETrade login page
//   ?action=callback&oauth_verifier=Y                   — step 2: exchange verifier for access tokens
//   ?action=accounts                                    — list accounts (auth test)
//   ?action=transactions&accountKey=X&days=7            — fetch raw transactions
//   ?action=import&days=30&dryRun=1                     — parse + match transactions (dryRun=1 = no DB writes)
//   ?action=import&days=30                              — parse + stage into pending_transactions
//   ?action=proxy&path=/v1/...                          — generic signed proxy

import crypto from "crypto";

const ETRADE_BASE     = "https://api.etrade.com";
const APP_URL         = "https://options-tracker-five.vercel.app";
const SUPABASE_URL    = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY    = process.env.VITE_SUPABASE_ANON_KEY;
const CONSUMER_KEY    = process.env.ETRADE_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.ETRADE_CONSUMER_SECRET;

// Account ID → display name
const ACCOUNT_NAMES = {
  "227156917": "ETrade 6917",
  "227418222": "ETrade 8222",
};

// transactionType → opt_type
const TX_TYPE_MAP = {
  "Sold Short":     "STO",  // standard STO
  "Sold":           "STO",  // covered call / CSP sale
  "Bought To Open": "BTO",
  "Bought To Cover":"BTC",
  "Bought":         "BTC",  // buy to close variant
  "Sold To Close":  "STC",
  "Option Assigned":"ASSIGNED",
};

// ── OAuth 1.0a helpers ────────────────────────────────────────────────────────
function pctEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g, "%21").replace(/'/g, "%27")
    .replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\*/g, "%2A");
}

function buildAuthHeader(method, url, oauthToken, oauthTokenSecret, extraParams = {}) {
  const oauthParams = {
    oauth_consumer_key:     CONSUMER_KEY,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_nonce:            crypto.randomBytes(16).toString("hex"),
    oauth_version:          "1.0",
  };
  if (oauthToken) oauthParams.oauth_token = oauthToken;

  const allParams   = { ...oauthParams, ...extraParams };
  const paramString = Object.keys(allParams).sort()
    .map(k => `${pctEncode(k)}=${pctEncode(allParams[k])}`).join("&");
  const baseString  = [method.toUpperCase(), pctEncode(url), pctEncode(paramString)].join("&");
  const signingKey  = `${pctEncode(CONSUMER_SECRET)}&${pctEncode(oauthTokenSecret || "")}`;
  const signature   = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");

  oauthParams.oauth_signature = signature;
  return "OAuth " + Object.keys(oauthParams)
    .map(k => `${pctEncode(k)}="${pctEncode(oauthParams[k])}"`)
    .join(", ");
}

// ── Signed ETrade GET ─────────────────────────────────────────────────────────

async function etradeGet(path, queryParams = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.etrade_tokens`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const t = (await r.json())?.[0]?.cols;
  if (!t?.accessToken || !t?.accessTokenSecret) {
    throw new Error("No ETrade tokens — visit /api/etrade?action=auth to authorize");
  }

  const urlBase    = `${ETRADE_BASE}${path}`;
  const qs         = Object.keys(queryParams).length ? "?" + new URLSearchParams(queryParams).toString() : "";
  const fullUrl    = urlBase + qs;
  const authHeader = buildAuthHeader("GET", urlBase, t.accessToken, t.accessTokenSecret, queryParams);

  const res  = await fetch(fullUrl, { headers: { Authorization: authHeader, Accept: "application/json" } });
  const text = await res.text();

  if (text.trim().startsWith("<")) {
    throw new Error(`ETrade returned XML (status ${res.status}) — token may have expired. Visit /api/etrade?action=auth. Preview: ${text.slice(0, 200)}`);
  }

  let data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error(`Non-JSON response (status ${res.status}): ${text.slice(0, 200)}`); }

  if (!res.ok) {
    const msg = data?.Error?.message || data?.message || JSON.stringify(data);
    throw new Error(`ETrade API ${res.status}: ${msg}`);
  }
  return data;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function saveTokens(tokens) {
  await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: "etrade_tokens", cols: { ...tokens, savedAt: new Date().toISOString() }, updated_at: new Date().toISOString() }),
  });
}

async function supabaseGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  return r.json();
}

// ── Transaction parser ────────────────────────────────────────────────────────
function parseTx(tx) {
  const b       = tx.brokerage || {};
  const product = b.product    || {};

  // Skip non-option transactions
  if (product.securityType !== "OPTN" && tx.transactionType !== "Option Assigned") {
    console.log(`[etrade parseTx] skipped — not OPTN: securityType="${product.securityType}" transactionType="${tx.transactionType}"`);
    return null;
  }
  // Skip equity sales triggered by assignment (securityType = EQ)
  if (product.securityType === "EQ") return null;
  // Skip interest/other non-option types
  if (!product.callPut) {
    console.log(`[etrade parseTx] skipped — no callPut: transactionType="${tx.transactionType}" securityType="${product.securityType}"`);
    return null;
  }

  const optType = TX_TYPE_MAP[tx.transactionType];
  if (!optType) {
    console.log(`[etrade parseTx] skipped — unknown transactionType: "${tx.transactionType}" for ${product.symbol} ${product.callPut}`);
    return null;
  }

  // Build expiry date from year/month/day fields
  const yr  = String(product.expiryYear).length === 2 ? `20${product.expiryYear}` : String(product.expiryYear);
  const mo  = String(product.expiryMonth).padStart(2, "0");
  const dy  = String(product.expiryDay).padStart(2, "0");
  const expires = `${yr}-${mo}-${dy}`;

  const qty     = Math.abs(b.quantity || 0);
  const premium = Math.round((tx.amount || 0) * 100) / 100;
  const dateExec = new Date(tx.transactionDate)
    .toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);

  const account = ACCOUNT_NAMES[String(tx.accountId)] || `ETrade ${String(tx.accountId).slice(-4)}`;

  return {
    schwab_transaction_id: `etrade_${tx.transactionId}`, // prefix to avoid collision with Schwab IDs
    stock:      product.symbol?.toUpperCase(),
    type:       product.callPut === "CALL" ? "Call" : "Put",
    opt_type:   optType,
    strike:     product.strikePrice,
    expires,
    qty,
    premium,
    date_exec:  dateExec,
    account,
    exercised:  optType === "ASSIGNED" ? "Yes" : "No",
    // For display in test page
    _description: tx.description,
    _txType:      tx.transactionType,
    _raw:         tx,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
async function notifyReauth(message) {
  const token = process.env.PUSHOVER_API_TOKEN;
  const user  = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return;
  await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token, user,
      title:   "⚠️ ETrade Re-Auth Required",
      message,
      url:     `${APP_URL}/api/etrade?action=auth`,
      url_title: "Re-Authorize ETrade",
      priority: 1,
      sound:   "siren",
    }),
  }).catch(() => {});
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!CONSUMER_KEY || !CONSUMER_SECRET) {
    return res.status(500).json({ error: "ETRADE_CONSUMER_KEY / ETRADE_CONSUMER_SECRET not configured" });
  }

  const { action } = req.query;

  const isAuthAction   = action === "auth" || action === "callback";
  const isBrowserSafe  = action === "import" && req.query.dryRun === "1";
  if (!isAuthAction && !isBrowserSafe) {
    const secret   = process.env.CRON_SECRET;
    const provided = req.headers["x-cron-secret"] || req.query.secret;
    if (secret && provided !== secret) return res.status(401).json({ error: "Unauthorized" });
  }

  try {

    // ── Auth step 1 ───────────────────────────────────────────────────────────
    if (action === "auth") {
      const url = `${ETRADE_BASE}/oauth/request_token`;
      const oauthParams = {
        oauth_consumer_key:     CONSUMER_KEY,
        oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
        oauth_nonce:            crypto.randomBytes(16).toString("hex"),
        oauth_callback:         "oob",
      };
      const paramString = Object.keys(oauthParams).sort()
        .map(k => `${pctEncode(k)}=${pctEncode(oauthParams[k])}`).join("&");
      const baseString  = ["GET", pctEncode(url), pctEncode(paramString)].join("&");
      const signingKey  = `${pctEncode(CONSUMER_SECRET)}&`;
      oauthParams.oauth_signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
      const authHeader = "OAuth " + Object.keys(oauthParams)
        .map(k => `${pctEncode(k)}="${pctEncode(oauthParams[k])}"`)
        .join(", ");

      const r        = await fetch(url, { headers: { Authorization: authHeader, Accept: "application/x-www-form-urlencoded" } });
      const authBody = await r.text();
      if (!r.ok || authBody.startsWith("<")) {
        return res.status(500).send(`<pre>Failed to get request token (${r.status}):\n${authBody}</pre>`);
      }
      const params        = new URLSearchParams(authBody);
      const requestToken  = params.get("oauth_token");
      const requestSecret = params.get("oauth_token_secret");
      if (!requestToken) return res.status(500).send(`<pre>No oauth_token in response:\n${authBody}</pre>`);

      await saveTokens({ requestToken, requestTokenSecret: requestSecret, stage: "pending" });
      const authorizeUrl = `https://us.etrade.com/e/t/etws/authorize?key=${CONSUMER_KEY}&token=${requestToken}`;
      return res.status(200).send(`
        <html><body style="font-family:monospace;background:#0d1117;color:#e6edf3;padding:40px;max-width:600px">
          <h2 style="color:#4fc3f7">ETrade Authorization</h2>
          <p>1. Click the link below to authorize on ETrade:</p>
          <p><a href="${authorizeUrl}" target="_blank" style="color:#00ff88;font-size:14px">${authorizeUrl}</a></p>
          <p style="margin-top:20px">2. ETrade will show you a <strong style="color:#ffd166">verifier code</strong>. Paste it below:</p>
          <form method="GET" action="/api/etrade" style="margin-top:12px">
            <input type="hidden" name="action" value="callback" />
            <input type="hidden" name="oauth_token" value="${requestToken}" />
            <input name="oauth_verifier" placeholder="Paste verifier code here"
              style="background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:8px 12px;font-family:monospace;font-size:14px;width:300px" />
            <button type="submit"
              style="margin-left:8px;background:#00ff88;color:#010409;border:none;border-radius:4px;padding:8px 16px;font-family:monospace;font-weight:700;cursor:pointer">
              Connect →
            </button>
          </form>
        </body></html>
      `);
    }

    // ── Auth step 2 ───────────────────────────────────────────────────────────
    if (action === "callback") {
      const { oauth_verifier: oauthVerifier, oauth_token: oauthTokenParam } = req.query;
      if (!oauthVerifier) return res.status(400).send("<pre>Missing oauth_verifier</pre>");

      const r      = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.etrade_tokens`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      const stored = (await r.json())?.[0]?.cols;
      if (!stored?.requestToken || !stored?.requestTokenSecret) {
        return res.status(500).send("<pre>No request token — restart at /api/etrade?action=auth</pre>");
      }

      const oauthToken  = oauthTokenParam || stored.requestToken;
      const tokenSecret = stored.requestTokenSecret;
      const url         = `${ETRADE_BASE}/oauth/access_token`;
      const oauthParams = {
        oauth_consumer_key:     CONSUMER_KEY,
        oauth_token:            oauthToken,
        oauth_verifier:         oauthVerifier,
        oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
        oauth_nonce:            crypto.randomBytes(16).toString("hex"),
      };
      const paramString = Object.keys(oauthParams).sort()
        .map(k => `${pctEncode(k)}=${pctEncode(oauthParams[k])}`).join("&");
      const baseString  = ["GET", pctEncode(url), pctEncode(paramString)].join("&");
      const signingKey  = `${pctEncode(CONSUMER_SECRET)}&${pctEncode(tokenSecret)}`;
      oauthParams.oauth_signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
      const authHeader = "OAuth " + Object.keys(oauthParams)
        .map(k => `${pctEncode(k)}="${pctEncode(oauthParams[k])}"`)
        .join(", ");

      const ar         = await fetch(url, { headers: { Authorization: authHeader, Accept: "application/x-www-form-urlencoded" } });
      const accessBody = await ar.text();
      if (!ar.ok || accessBody.startsWith("<")) {
        return res.status(500).send(`<pre>Failed to get access token (${ar.status}):\n${accessBody}</pre>`);
      }
      const params       = new URLSearchParams(accessBody);
      const accessToken  = params.get("oauth_token");
      const accessSecret = params.get("oauth_token_secret");
      if (!accessToken) return res.status(500).send(`<pre>No access token:\n${accessBody}</pre>`);

      await saveTokens({ accessToken, accessTokenSecret: accessSecret, stage: "authorized" });
      return res.status(200).send(`
        <html><body style="font-family:monospace;background:#0d1117;color:#00ff88;padding:40px">
          <h2>✓ ETrade Connected Successfully</h2>
          <p>Tokens saved to Supabase.</p>
          <a href="/" style="color:#58a6ff">← Back to App</a>
        </body></html>
      `);
    }

    // ── renew — extend ETrade access token (valid same-day only) ─────────────
    if (action === "renew") {
      const tokenRes = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.etrade_tokens`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      const t = (await tokenRes.json())?.[0]?.cols;
      if (!t?.accessToken) return res.status(500).json({ error: "No ETrade token found — re-authorize first at /api/etrade?action=auth" });

      // Check if token was saved today (ETrade tokens expire at midnight ET)
      const savedAt   = new Date(t.savedAt || 0);
      const nowET     = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
      const savedAtET = new Date(savedAt.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const sameDay   = savedAtET.toDateString() === nowET.toDateString();

      if (!sameDay) {
        // Token is from a previous day — must fully re-authorize
        await notifyReauth("ETrade token expired (previous day) — manual re-auth required");
        return res.status(401).json({
          error: "ETrade token expired — re-authorize at /api/etrade?action=auth",
          reAuthUrl: `${APP_URL}/api/etrade?action=auth`,
          savedAt: t.savedAt,
        });
      }

      // Token is from today — call ETrade renew endpoint
      const renewRes = await etradeGet("/oauth/renew_access_token");
      const renewed  = { ...t, renewedAt: new Date().toISOString() };

      await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id: "etrade_tokens", cols: renewed, updated_at: new Date().toISOString() }),
      });

      return res.status(200).json({ ok: true, message: "ETrade token renewed successfully", renewedAt: renewed.renewedAt });
    }

    // ── accounts ──────────────────────────────────────────────────────────────
    if (action === "accounts") {
      const data     = await etradeGet("/v1/accounts/list");
      const accounts = data?.AccountListResponse?.Accounts?.Account || [];
      return res.status(200).json({
        ok: true, count: accounts.length,
        accounts: accounts.map(a => ({
          accountId: a.accountId, accountIdKey: a.accountIdKey,
          accountName: ACCOUNT_NAMES[a.accountId] || a.accountName,
          accountType: a.accountType, status: a.accountStatus,
        })),
      });
    }

    // ── transactions (raw) ────────────────────────────────────────────────────
    if (action === "transactions") {
      const { accountKey, days = "7" } = req.query;
      let key = accountKey;
      if (!key) {
        const acctData = await etradeGet("/v1/accounts/list");
        const accounts = acctData?.AccountListResponse?.Accounts?.Account || [];
        if (!accounts.length) throw new Error("No ETrade accounts found");
        key = accounts[0].accountIdKey;
      }
      const toDate   = new Date();
      const fromDate = new Date(toDate.getTime() - (+days * 86400000));
      const fmt      = d => `${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}${d.getFullYear()}`;
      const data     = await etradeGet(`/v1/accounts/${key}/transactions`, { startDate: fmt(fromDate), endDate: fmt(toDate) });
      const txList   = data?.TransactionListResponse?.Transaction || [];
      return res.status(200).json({ ok: true, accountKey: key, days: +days, count: txList.length, transactions: txList });
    }

    // ── import (parse + optionally stage) ────────────────────────────────────
    if (action === "import") {
      const days    = +(req.query.days || 30);
      const dryRun  = req.query.dryRun === "1";

      // Fetch all accounts
      const acctData = await etradeGet("/v1/accounts/list");
      const accounts = acctData?.AccountListResponse?.Accounts?.Account || [];
      if (!accounts.length) throw new Error("No ETrade accounts found");

      const toDate   = new Date();
      const fromDate = new Date(toDate.getTime() - (days * 86400000));
      const fmt      = d => `${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}${d.getFullYear()}`;

      // Fetch transactions from all accounts in parallel
      const allRaw = [];
      await Promise.all(accounts.map(async acct => {
        try {
          const data   = await etradeGet(`/v1/accounts/${acct.accountIdKey}/transactions`, {
            startDate: fmt(fromDate), endDate: fmt(toDate),
          });
          const txList = data?.TransactionListResponse?.Transaction || [];
          allRaw.push(...txList);
        } catch (e) {
          // 204 = no transactions for this account in the date range — not an error
          if (!e.message?.includes("204")) {
            console.warn(`[etrade] failed to fetch ${acct.accountIdKey}:`, e.message);
          }
        }
      }));

      // Parse all transactions
      const parsed   = allRaw.map(parseTx).filter(Boolean);
      const skipped  = allRaw.length - parsed.length;

      if (dryRun) {
        // Return parsed results without touching DB
        return res.status(200).json({
          ok: true, dryRun: true,
          fromDate: fromDate.toISOString().slice(0, 10),
          toDate:   toDate.toISOString().slice(0, 10),
          rawCount:    allRaw.length,
          parsedCount: parsed.length,
          skippedCount: allRaw.length - parsed.length,
          transactions: parsed,
          // Include raw skipped transactions for debugging
          skippedRaw: allRaw.filter(tx => !parsed.find(p => p.schwab_transaction_id === `etrade_${tx.transactionId}`))
            .map(tx => ({ transactionId: tx.transactionId, transactionType: tx.transactionType, description: tx.description, securityType: tx.brokerage?.product?.securityType, callPut: tx.brokerage?.product?.callPut, symbol: tx.brokerage?.product?.symbol })),
        });
      }

      // Real import — check for existing IDs and stage new ones
      const ids = parsed.map(p => p.schwab_transaction_id);

      // Check contracts table
      const existingContractsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/contracts?select=schwab_transaction_id&schwab_transaction_id=not.is.null`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      // Check pending_transactions table
      const existingPendingRes = await fetch(
        `${SUPABASE_URL}/rest/v1/pending_transactions?select=schwab_transaction_id`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const existingIds = new Set([
        ...(await existingContractsRes.json()).map(r => String(r.schwab_transaction_id)),
        ...(await existingPendingRes.json()).map(r => String(r.schwab_transaction_id)),
      ]);

      // Load open contracts for close matching
      const openRes       = await supabaseGet(`contracts?select=id,stock,type,opt_type,strike,expires,qty,account,trade_rule&status=eq.Open`);
      const openContracts = Array.isArray(openRes) ? openRes : [];

      const toInsert = [];
      for (const p of parsed) {
        if (existingIds.has(p.schwab_transaction_id)) continue;

        // Match closes to open contracts
        let matchId         = null;
        let matchConfidence = "none";
        if (["BTC","STC","ASSIGNED"].includes(p.opt_type)) {
          const matches = openContracts.filter(c =>
            c.stock?.toUpperCase() === p.stock?.toUpperCase() &&
            c.type  === p.type &&
            +c.strike === +p.strike &&
            c.expires === p.expires &&
            c.account === p.account
          );
          if (matches.length === 1) {
            matchId         = matches[0].id;
            matchConfidence = "exact";
            if (!p.trade_rule && matches[0].trade_rule) p.trade_rule = matches[0].trade_rule;
          } else if (matches.length > 1) {
            matchId         = matches[0].id;
            matchConfidence = "partial";
          }
        }

        toInsert.push({
          schwab_transaction_id: p.schwab_transaction_id,
          stock:      p.stock,
          opt_type:   p.opt_type === "ASSIGNED" ? "BTC" : p.opt_type,
          type:       p.type,
          strike:     p.strike,
          expires:    p.expires,
          qty:        p.qty,
          premium:    p.premium,
          date_exec:  p.date_exec,
          account:    p.account,
          exercised:  p.exercised,
          trade_rule: p.trade_rule || null,
          match_id:   matchId,
          match_confidence: matchConfidence,
          status:     "pending",
          raw:        p._raw,
        });
      }

      if (!toInsert.length) {
        return res.status(200).json({ ok: true, new: 0, reason: "all already staged or committed" });
      }

      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/pending_transactions`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates",
        },
        body: JSON.stringify(toInsert),
      });

      if (!insertRes.ok) throw new Error(`Insert failed: ${await insertRes.text()}`);

      return res.status(200).json({
        ok: true, new: toInsert.length,
        opens:    toInsert.filter(t => ["STO","BTO"].includes(t.opt_type)).length,
        closes:   toInsert.filter(t => ["BTC","STC"].includes(t.opt_type)).length,
        assigned: toInsert.filter(t => t.exercised === "Yes").length,
        skipped,
      });
    }

    // ── reconcile — match ETrade transactions to existing unlinked contracts ───
    if (action === "reconcile") {
      const dryRun = req.query.dryRun !== "0"; // default dryRun=true for safety
      const days   = 136; // back to ~Dec 19

      // Step 1: fetch all ETrade transactions from both accounts
      const acctData = await etradeGet("/v1/accounts/list");
      const accounts = acctData?.AccountListResponse?.Accounts?.Account || [];
      if (!accounts.length) throw new Error("No ETrade accounts found");

      const toDate   = new Date();
      const fromDate = new Date(toDate.getTime() - (days * 86400000));
      const fmt      = d => `${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}${d.getFullYear()}`;

      const allRaw = [];
      await Promise.all(accounts.map(async acct => {
        try {
          const data   = await etradeGet(`/v1/accounts/${acct.accountIdKey}/transactions`, {
            startDate: fmt(fromDate), endDate: fmt(toDate),
          });
          (data?.TransactionListResponse?.Transaction || []).forEach(tx => allRaw.push(tx));
        } catch (e) {
          console.warn(`[etrade reconcile] fetch failed for ${acct.accountIdKey}:`, e.message);
        }
      }));

      // Step 2: parse option transactions only
      const parsed = allRaw.map(parseTx).filter(Boolean);

      // Step 3: load all unlinked ETrade contracts from DB
      const contractsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/contracts?select=id,stock,type,opt_type,strike,expires,qty,premium,account,date_exec,schwab_transaction_id&account=like.Etrade*&schwab_transaction_id=is.null`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const unlinked = await contractsRes.json();

      if (!Array.isArray(unlinked)) throw new Error(`DB error loading contracts: ${JSON.stringify(unlinked)}`);

      // Step 4: match transactions to contracts
      const matched    = [];
      const ambiguous  = [];
      const noMatch    = [];
      const usedTxIds  = new Set();
      const usedCIds   = new Set();

      for (const c of unlinked) {
        // Find all parsed transactions that could match this contract
        const candidates = parsed.filter(p =>
          !usedTxIds.has(p.schwab_transaction_id) &&
          p.stock?.toUpperCase()  === c.stock?.toUpperCase() &&
          p.type                  === c.type &&
          +p.strike               === +c.strike &&
          p.expires               === c.expires &&
          p.opt_type              === c.opt_type
        );

        if (candidates.length === 1) {
          const tx = candidates[0];
          matched.push({
            contractId:    c.id,
            stock:         c.stock,
            contract:      `${c.stock} $${c.strike} ${c.type} ${c.expires}`,
            opt_type:      c.opt_type,
            oldAccount:    c.account,
            newAccount:    tx.account,
            txId:          tx.schwab_transaction_id,
            txDate:        tx.date_exec,
            contractDate:  c.date_exec,
            premium:       c.premium,
          });
          usedTxIds.add(tx.schwab_transaction_id);
          usedCIds.add(c.id);
        } else if (candidates.length > 1) {
          ambiguous.push({
            contractId:  c.id,
            contract:    `${c.stock} $${c.strike} ${c.type} ${c.expires}`,
            opt_type:    c.opt_type,
            candidates:  candidates.length,
            dates:       candidates.map(p => p.date_exec),
          });
        } else {
          noMatch.push({
            contractId: c.id,
            contract:   `${c.stock} $${c.strike} ${c.type} ${c.expires}`,
            opt_type:   c.opt_type,
            date_exec:  c.date_exec,
            account:    c.account,
          });
        }
      }

      if (dryRun) {
        return res.status(200).json({
          ok: true, dryRun: true,
          unlinkedContracts: unlinked.length,
          parsedTransactions: parsed.length,
          matched:   matched.length,
          ambiguous: ambiguous.length,
          noMatch:   noMatch.length,
          matchedList:   matched,
          ambiguousList: ambiguous,
          noMatchList:   noMatch,
        });
      }

      // Step 5: apply updates
      const updates = [];
      for (const m of matched) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/contracts?id=eq.${m.contractId}`, {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json", Prefer: "return=minimal",
          },
          body: JSON.stringify({
            schwab_transaction_id: m.txId,
            account: m.newAccount,
          }),
        });
        updates.push({ contractId: m.contractId, ok: r.ok, status: r.status });
      }

      const succeeded = updates.filter(u => u.ok).length;
      const failed    = updates.filter(u => !u.ok).length;

      return res.status(200).json({
        ok: true, dryRun: false,
        matched: matched.length, succeeded, failed,
        ambiguous: ambiguous.length,
        noMatch:   noMatch.length,
        ambiguousList: ambiguous,
        noMatchList:   noMatch,
      });
    }

    // ── proxy ─────────────────────────────────────────────────────────────────
    if (action === "proxy") {
      const { path: apiPath, ...queryParams } = req.query;
      delete queryParams.action; delete queryParams.secret;
      if (!apiPath) return res.status(400).json({ error: "Missing ?path=" });
      const data = await etradeGet(apiPath, queryParams);
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error("[etrade]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
