// api/auto-import.js
// Fetches recent Schwab transactions and stages new ones in pending_transactions.
// Called by GitHub Actions every 5 min during market hours.
// Cutover date: 2026-05-02 — nothing older is auto-imported.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SCHWAB_BASE  = "https://api.schwabapi.com";
const APP_URL      = "https://options-tracker-five.vercel.app";

async function getValidToken() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_tokens`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const t = (await r.json())?.[0]?.cols;
  if (!t?.accessToken) throw new Error("No Schwab tokens");
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

async function sendPushover(title, message) {
  const token = process.env.PUSHOVER_API_TOKEN;
  const user  = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return;
  await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, user, title, message, url: `${APP_URL}/?tab=import`, url_title: "Review in App", priority: 0, sound: "pushover" }),
  });
}

// Parse a Schwab transaction into our contract shape (mirrors schwab-transactions.js logic)
function parseTx(tx, stocksData) {
  const items = tx.transferItems || [];
  const optItem = items.find(i => i.instrument?.assetType === "OPTION");
  if (!optItem) return null;

  const inst     = optItem.instrument;
  const putCall  = inst.putCall;           // CALL or PUT
  const strike   = inst.strikePrice;
  const expDate  = inst.expirationDate?.slice(0, 10);
  const symbol   = inst.underlyingSymbol || inst.symbol?.slice(0, 4).trim();
  const qty      = Math.abs(optItem.amount || 0);
  const price    = optItem.price || 0;
  const effect   = optItem.positionEffect; // OPENING or CLOSING
  const netAmt   = tx.netAmount || 0;

  // Determine opt_type
  let optType;
  if (effect === "OPENING") {
    optType = netAmt > 0 ? "STO" : "BTO";
  } else {
    optType = netAmt < 0 ? "BTC" : "STC";
  }

  const dateExec = new Date(tx.tradeDate || tx.time).toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);
  const premium  = Math.round(netAmt * 100) / 100;

  // Auto-fill stock price from stocks_data cache
  const stockPrice = stocksData?.[symbol?.toUpperCase()]?.currentPrice || null;

  return {
    schwab_transaction_id: String(tx.activityId),
    stock:    symbol?.toUpperCase(),
    type:     putCall === "CALL" ? "Call" : "Put",
    opt_type: optType,
    strike:   strike,
    expires:  expDate,
    qty:      qty,
    premium:  premium,
    date_exec: dateExec,
    account:  "Schwab",
    stock_price_at_exec: stockPrice,
    strategy: optType === "STO" && putCall === "CALL" ? "OTM Covered Call Strategy" : null,
    raw:      tx,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const secret   = process.env.CRON_SECRET;
  const provided = req.headers["x-cron-secret"] || req.query.secret;
  if (secret && provided !== secret) return res.status(401).json({ error: "Unauthorized" });

  const forceRun = req.query.force === "1";

  try {
    // Load config
    const cfgRes = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.auto_import_config`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const cfg = (await cfgRes.json())?.[0]?.cols || {};
    if (!forceRun && !cfg.enabled) return res.status(200).json({ skipped: true, reason: "auto-import disabled" });

    const cutoverDate = cfg.cutoverDate || "2026-05-02";

    // Load stocks_data for price at execution
    const sdRes = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.stocks_data`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const stocksData = (await sdRes.json())?.[0]?.cols || {};

    // Fetch transactions from Schwab for last 2 days (wide window to avoid missing anything)
    const token = await getValidToken();
    const today = new Date().toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);
    const fromDate = new Date(new Date().getTime() - 2 * 86400000).toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);

    // Get account numbers
    const acctRes = await fetch(`${SCHWAB_BASE}/trader/v1/accounts/accountNumbers`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const accounts = await acctRes.json();
    if (!Array.isArray(accounts) || !accounts.length) throw new Error("No accounts found");

    const startUTC = fromDate + "T05:00:00.000Z";
    const endUTC   = new Date(new Date(today + "T05:00:00.000Z").getTime() + 86400000).toISOString();

    const allRaw = [];
    for (const acct of accounts) {
      const hash = acct.hashValue;
      if (!hash) continue;
      const txRes = await fetch(
        `${SCHWAB_BASE}/trader/v1/accounts/${hash}/transactions?types=TRADE&startDate=${startUTC}&endDate=${endUTC}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
      );
      const txData = await txRes.json();
      const txList = Array.isArray(txData) ? txData : (txData?.transactions ?? []);
      allRaw.push(...txList);
    }

    if (!allRaw.length) return res.status(200).json({ ok: true, new: 0, reason: "no transactions" });

    // Filter to cutover date and options only
    const filtered = allRaw.filter(tx => {
      const d = new Date(tx.tradeDate || tx.time).toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);
      if (d < cutoverDate) return false;
      return (tx.transferItems || []).some(i => i.instrument?.assetType === "OPTION");
    });

    if (!filtered.length) return res.status(200).json({ ok: true, new: 0, reason: "no new option transactions" });

    // Load existing schwab_transaction_ids from both contracts and pending_transactions
    const existingContractsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/contracts?select=schwab_transaction_id&schwab_transaction_id=not.is.null`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const existingPendingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/pending_transactions?select=schwab_transaction_id`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const existingIds = new Set([
      ...(await existingContractsRes.json()).map(r => String(r.schwab_transaction_id)),
      ...(await existingPendingRes.json()).map(r => String(r.schwab_transaction_id)),
    ]);

    // Load open contracts for matching closes
    const openRes = await fetch(
      `${SUPABASE_URL}/rest/v1/contracts?select=id,stock,type,opt_type,strike,expires,qty,account,trade_rule&status=eq.Open`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const openContracts = await openRes.json();

    // Parse and stage new transactions
    const toInsert = [];
    for (const tx of filtered) {
      const id = String(tx.activityId);
      if (existingIds.has(id)) continue;

      const parsed = parseTx(tx, stocksData);
      if (!parsed) continue;

      // Try to match closes to open contracts
      let matchId = null;
      let matchConfidence = "none";
      if (["BTC", "STC"].includes(parsed.opt_type)) {
        const matches = openContracts.filter(c =>
          c.stock?.toUpperCase() === parsed.stock?.toUpperCase() &&
          c.type === parsed.type &&
          +c.strike === +parsed.strike &&
          c.expires === parsed.expires &&
          c.account === parsed.account
        );
        if (matches.length === 1) {
          matchId = matches[0].id;
          matchConfidence = "exact";
          // Inherit trade_rule from matched open contract if not set
          if (!parsed.trade_rule && matches[0].trade_rule) {
            parsed.trade_rule = matches[0].trade_rule;
          }
        } else if (matches.length > 1) {
          matchId = matches[0].id;
          matchConfidence = "partial";
        }
      }

      toInsert.push({
        ...parsed,
        match_id: matchId,
        match_confidence: matchConfidence,
        status: "pending",
      });
    }

    if (!toInsert.length) return res.status(200).json({ ok: true, new: 0, reason: "all already staged or committed" });

    // Insert into pending_transactions
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/pending_transactions`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates",
      },
      body: JSON.stringify(toInsert),
    });

    if (!insertRes.ok) {
      const err = await insertRes.text();
      throw new Error(`Insert failed: ${err}`);
    }

    // Send Pushover notification
    const opens  = toInsert.filter(t => ["STO","BTO"].includes(t.opt_type));
    const closes = toInsert.filter(t => ["BTC","STC"].includes(t.opt_type));
    const unmatched = closes.filter(t => t.match_confidence === "none");

    let msg = `${toInsert.length} new transaction${toInsert.length > 1 ? "s" : ""} ready for review.`;
    if (opens.length)     msg += `\n${opens.length} open${opens.length > 1 ? "s" : ""}.`;
    if (closes.length)    msg += `\n${closes.length} close${closes.length > 1 ? "s" : ""}.`;
    if (unmatched.length) msg += `\n⚠ ${unmatched.length} unmatched close${unmatched.length > 1 ? "s" : ""}.`;

    await sendPushover("📥 New Transactions Pending", msg);

    const now = new Date().toISOString();
    res.status(200).json({ ok: true, new: toInsert.length, opens: opens.length, closes: closes.length, unmatched: unmatched.length, time: now });

  } catch (err) {
    console.error("[auto-import]", err.message);
    res.status(500).json({ error: err.message });
  }
}
