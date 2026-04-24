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

  const { path, ...queryParams } = req.query;
  if (!path) return res.status(400).json({ error: "Missing ?path= parameter" });

  try {
    const consumerKey    = process.env.ETRADE_CONSUMER_KEY    || process.env.VITE_ETRADE_CONSUMER_KEY;
    const consumerSecret = process.env.ETRADE_CONSUMER_SECRET || process.env.VITE_ETRADE_CONSUMER_SECRET;
    if (!consumerKey || !consumerSecret)
      return res.status(500).json({ error: "E*TRADE credentials not configured" });

    const { accessToken, accessTokenSecret } = await loadTokens();
    const targetUrl = `${ETRADE_BASE}${path}`;
    const authHeader = buildOAuth1Header({ method: "GET", url: targetUrl, queryParams, consumerKey, consumerSecret, accessToken, accessTokenSecret });
    const qs = Object.keys(queryParams).length ? "?" + Object.entries(queryParams).map(([k,v]) => `${k}=${v}`).join("&") : "";
    const eRes = await fetch(`${targetUrl}${qs}`, { headers: { Authorization: authHeader, Accept: "application/json" } });
    const body = await eRes.text();
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
  const nonce     = crypto.randomBytes(16).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sigParams = { oauth_consumer_key:consumerKey, oauth_nonce:nonce, oauth_signature_method:"HMAC-SHA1", oauth_timestamp:timestamp, oauth_token:accessToken, oauth_version:"1.0", ...queryParams };
  const paramString = Object.entries(sigParams).map(([k,v]) => [pct(k),pct(String(v))]).sort(([a],[b]) => a<b?-1:a>b?1:0).map(([k,v]) => `${k}=${v}`).join("&");
  const signatureBase = [method.toUpperCase(), pct(url), pct(paramString)].join("&");
  const signingKey    = `${pct(consumerSecret)}&${pct(accessTokenSecret)}`;
  const signature     = crypto.createHmac("sha1", signingKey).update(signatureBase).digest("base64");
  return `OAuth realm="",oauth_consumer_key="${pct(consumerKey)}",oauth_nonce="${pct(nonce)}",oauth_signature="${pct(signature)}",oauth_signature_method="HMAC-SHA1",oauth_timestamp="${pct(timestamp)}",oauth_token="${pct(accessToken)}",oauth_version="1.0"`;
}
