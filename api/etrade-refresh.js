// api/etrade-refresh.js
// Vercel cron job — runs nightly at 11:50 PM ET to renew E*TRADE access token.
// Stores the new token in Supabase so etrade-proxy.js picks it up automatically.
//
// Schedule set in vercel.json:  "0 4 * * *"  (4:00 AM UTC = 11:50 PM ET winter / 12:50 AM ET summer... 
// E*TRADE tokens expire at midnight ET so we refresh at 11:50 PM ET = 03:50 UTC)

import crypto from "crypto";

const ETRADE_BASE  = "https://api.etrade.com";
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const CRON_SECRET  = process.env.CRON_SECRET; // optional — set in Vercel to secure the endpoint

export default async function handler(req, res) {
  // Secure the endpoint
  if (CRON_SECRET && req.headers["authorization"] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const consumerKey       = process.env.ETRADE_CONSUMER_KEY       || process.env.VITE_ETRADE_CONSUMER_KEY;
    const consumerSecret    = process.env.ETRADE_CONSUMER_SECRET    || process.env.VITE_ETRADE_CONSUMER_SECRET;
    const accessToken       = process.env.ETRADE_ACCESS_TOKEN       || process.env.VITE_ETRADE_ACCESS_TOKEN;
    const accessTokenSecret = process.env.ETRADE_ACCESS_TOKEN_SECRET || process.env.VITE_ETRADE_ACCESS_TOKEN_SECRET;

    if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) {
      return res.status(500).json({ error: "Missing E*TRADE credentials in env vars" });
    }

    // E*TRADE token renewal — GET /oauth/access_token with existing token
    const url = `${ETRADE_BASE}/oauth/access_token`;
    const op  = {
      oauth_consumer_key:     consumerKey,
      oauth_token:            accessToken,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
      oauth_nonce:            crypto.randomBytes(16).toString("hex"),
      oauth_version:          "1.0",
    };

    const paramStr = Object.entries(op)
      .map(([k,v]) => [pct(k), pct(String(v))]).sort(([a],[b]) => a<b?-1:1)
      .map(([k,v]) => `${k}=${v}`).join("&");
    const base = ["GET", pct(url), pct(paramStr)].join("&");
    const key  = `${pct(consumerSecret)}&${pct(accessTokenSecret)}`;
    op.oauth_signature = crypto.createHmac("sha1", key).update(base).digest("base64");

    const authHeader = "OAuth " + Object.entries(op).map(([k,v]) => `${pct(k)}="${pct(String(v))}"`).join(", ");

    const eRes = await fetch(url, { headers: { Authorization: authHeader } });
    const text = await eRes.text();

    if (!eRes.ok) {
      console.error("[etrade-refresh] renewal failed:", text);
      return res.status(500).json({ error: "Token renewal failed", detail: text.slice(0, 200) });
    }

    const params     = Object.fromEntries(new URLSearchParams(text));
    const newToken   = params.oauth_token;
    const newSecret  = params.oauth_token_secret;

    if (!newToken || !newSecret) {
      return res.status(500).json({ error: "No tokens in renewal response", raw: text.slice(0, 200) });
    }

    // Save to Supabase so etrade-proxy.js picks them up
    const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
      method: "POST",
      headers: {
        apikey:          SUPABASE_KEY,
        Authorization:   `Bearer ${SUPABASE_KEY}`,
        "Content-Type":  "application/json",
        Prefer:          "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        id:   "etrade_tokens",
        cols: { accessToken: newToken, accessTokenSecret: newSecret, refreshedAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }),
    });

    if (!saveRes.ok) {
      const saveErr = await saveRes.text();
      console.error("[etrade-refresh] supabase save failed:", saveErr);
      return res.status(500).json({ error: "Failed to save tokens to Supabase", detail: saveErr });
    }

    console.log("[etrade-refresh] tokens renewed successfully at", new Date().toISOString());
    res.status(200).json({ ok: true, refreshedAt: new Date().toISOString() });

  } catch (err) {
    console.error("[etrade-refresh] error:", err.message);
    res.status(500).json({ error: err.message });
  }
}

function pct(str) {
  return encodeURIComponent(String(str ?? "")).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
