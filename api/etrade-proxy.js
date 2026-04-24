// api/etrade-proxy.js
// Vercel serverless function — signs E*TRADE API requests with OAuth 1.0a
// Browser calls: /api/etrade-proxy?path=/v1/market/quote/AAPL.json&...extra params

import crypto from "crypto";

const ETRADE_BASE  = "https://api.etrade.com";
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;

async function loadTokens() {
  // Prefer env vars (Vercel environment variables, set in dashboard)
  const envToken  = process.env.ETRADE_ACCESS_TOKEN        || process.env.VITE_ETRADE_ACCESS_TOKEN;
  const envSecret = process.env.ETRADE_ACCESS_TOKEN_SECRET || process.env.VITE_ETRADE_ACCESS_TOKEN_SECRET;
  if (envToken && envSecret) return { accessToken: envToken, accessTokenSecret: envSecret };
  // Fall back to Supabase (updated nightly by refresh cron)
  const res  = await fetch(
    `${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.etrade_tokens`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows   = await res.json();
  const tokens = rows?.[0]?.cols;
  if (!tokens?.accessToken) throw new Error("No E*TRADE tokens in DB — run OAuth flow");
  return tokens;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { path, ...queryParams } = req.query;
  if (!path) return res.status(400).json({ error: "Missing ?path= parameter" });

  try {
    const consumerKey    = process.env.ETRADE_CONSUMER_KEY    || process.env.VITE_ETRADE_CONSUMER_KEY;
    const consumerSecret = process.env.ETRADE_CONSUMER_SECRET || process.env.VITE_ETRADE_CONSUMER_SECRET;
    if (!consumerKey || !consumerSecret)
      return res.status(500).json({ error: "E*TRADE credentials not configured in Vercel env vars" });

    const { accessToken, accessTokenSecret } = await loadTokens();
    const targetUrl  = `${ETRADE_BASE}${path}`;
    const authHeader = buildOAuth1Header({ method: "GET", url: targetUrl, queryParams, consumerKey, consumerSecret, accessToken, accessTokenSecret });
    const qs         = Object.keys(queryParams).length ? "?" + new URLSearchParams(queryParams).toString() : "";
    const eRes       = await fetch(`${targetUrl}${qs}`, { headers: { Authorization: authHeader, Accept: "application/json" } });
    const body       = await eRes.text();
    res.status(eRes.status).setHeader("Content-Type", "application/json").end(body);
  } catch (err) {
    console.error("[etrade-proxy]", err.message);
    res.status(500).json({ error: err.message });
  }
}

function pct(str) {
  return encodeURIComponent(String(str ?? "")).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildOAuth1Header({ method, url, queryParams = {}, consumerKey, consumerSecret, accessToken, accessTokenSecret }) {
  const op = {
    oauth_consumer_key: consumerKey, oauth_token: accessToken,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_version: "1.0",
  };
  const paramStr = Object.entries({ ...queryParams, ...op })
    .map(([k,v]) => [pct(k), pct(String(v))]).sort(([a],[b]) => a<b?-1:1)
    .map(([k,v]) => `${k}=${v}`).join("&");
  const base = [method.toUpperCase(), pct(url), pct(paramStr)].join("&");
  const key  = `${pct(consumerSecret)}&${pct(accessTokenSecret)}`;
  op.oauth_signature = crypto.createHmac("sha1", key).update(base).digest("base64");
  return "OAuth " + Object.entries(op).map(([k,v]) => `${pct(k)}="${pct(String(v))}"`).join(", ");
}
