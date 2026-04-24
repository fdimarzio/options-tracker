import crypto from "crypto";

const ETRADE_BASE  = "https://api.etrade.com";
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;

async function loadTokens() {
  const envToken  = process.env.ETRADE_ACCESS_TOKEN        || process.env.VITE_ETRADE_ACCESS_TOKEN;
  const envSecret = process.env.ETRADE_ACCESS_TOKEN_SECRET || process.env.VITE_ETRADE_ACCESS_TOKEN_SECRET;
  if (envToken && envSecret) return { accessToken: envToken, accessTokenSecret: envSecret };
  const res    = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.etrade_tokens`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  const rows   = await res.json();
  const tokens = rows?.[0]?.cols;
  if (!tokens?.accessToken) throw new Error("No E*TRADE tokens in DB");
  return tokens;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Extract path — everything else in query is a param to forward to E*TRADE
  const { path, ...queryParams } = req.query;
  if (!path) return res.status(400).json({ error: "Missing ?path= parameter" });

  try {
    const consumerKey    = process.env.ETRADE_CONSUMER_KEY    || process.env.VITE_ETRADE_CONSUMER_KEY;
    const consumerSecret = process.env.ETRADE_CONSUMER_SECRET || process.env.VITE_ETRADE_CONSUMER_SECRET;
    if (!consumerKey || !consumerSecret)
      return res.status(500).json({ error: "E*TRADE credentials not configured" });

    const { accessToken, accessTokenSecret } = await loadTokens();

    // Build the target URL — path only, no /api/etrade-proxy prefix
    const targetUrl = `${ETRADE_BASE}${path}`;

    // Sign with ONLY the E*TRADE query params (not the 'path' routing param)
    const authHeader = buildOAuth1Header({
      method: "GET",
      url: targetUrl,
      queryParams,   // these are the actual E*TRADE params e.g. symbol, expiryYear etc
      consumerKey,
      consumerSecret,
      accessToken,
      accessTokenSecret,
    });

    // Build final URL with query params
    const qs      = Object.keys(queryParams).length ? "?" + new URLSearchParams(queryParams).toString() : "";
    const fullUrl = `${targetUrl}${qs}`;

    console.log("[etrade-proxy] ->", fullUrl);

    const eRes = await fetch(fullUrl, {
      headers: { Authorization: authHeader, Accept: "application/json" },
    });
    const body = await eRes.text();

    console.log("[etrade-proxy] <-", eRes.status, eRes.statusText);

    res.status(eRes.status).setHeader("Content-Type", "application/json").end(body);
  } catch (err) {
    console.error("[etrade-proxy] error:", err.message);
    res.status(500).json({ error: err.message });
  }
}

function pct(str) {
  return encodeURIComponent(String(str ?? "")).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildOAuth1Header({ method, url, queryParams = {}, consumerKey, consumerSecret, accessToken, accessTokenSecret }) {
  const op = {
    oauth_consumer_key:     consumerKey,
    oauth_token:            accessToken,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_nonce:            crypto.randomBytes(16).toString("hex"),
    oauth_version:          "1.0",
  };

  // Signature base = sorted merge of OAuth params + request query params
  const allParams = { ...queryParams, ...op };
  const paramStr  = Object.entries(allParams)
    .map(([k, v]) => [pct(k), pct(String(v))])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const signatureBase = [method.toUpperCase(), pct(url), pct(paramStr)].join("&");
  const signingKey    = `${pct(consumerSecret)}&${pct(accessTokenSecret)}`;

  op.oauth_signature = crypto.createHmac("sha1", signingKey).update(signatureBase).digest("base64");

  return "OAuth " + Object.entries(op)
    .map(([k, v]) => `${pct(k)}="${pct(String(v))}"`)
    .join(", ");
}
