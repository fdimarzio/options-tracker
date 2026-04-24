import crypto from "crypto";

const CONSUMER_KEY    = "5974003f6130ba9664e925753f1619f2";
const CONSUMER_SECRET = "8f5086fc8475233d86c44660ab2c0ae9226b7b1fb6d8bbd1a2f0d175d3d83544";
const BASE_URL        = "https://api.etrade.com";

function pct(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function sign(method, url, params, consumerSecret, tokenSecret = "") {
  const paramStr = Object.entries(params)
    .map(([k,v]) => [pct(k), pct(v)])
    .sort(([a],[b]) => a < b ? -1 : 1)
    .map(([k,v]) => `${k}=${v}`)
    .join("&");
  const base = [method, pct(url), pct(paramStr)].join("&");
  const key  = `${pct(consumerSecret)}&${pct(tokenSecret)}`;
  return crypto.createHmac("sha1", key).update(base).digest("base64");
}

function authHeader(params) {
  return "OAuth " + Object.entries(params).map(([k,v]) => `${pct(k)}="${pct(v)}"`).join(", ");
}

async function requestToken() {
  const url = `${BASE_URL}/oauth/request_token`;
  const params = {
    oauth_callback:         "oob",
    oauth_consumer_key:     CONSUMER_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp:        Math.floor(Date.now()/1000).toString(),
    oauth_version:          "1.0",
  };
  params.oauth_signature = sign("GET", url, params, CONSUMER_SECRET);
  const res  = await fetch(url, { headers: { Authorization: authHeader(params) } });
  const text = await res.text();
  console.log("\nStep 1 response:", text);
  return Object.fromEntries(new URLSearchParams(text));
}

async function accessToken(oauthToken, oauthTokenSecret, verifier) {
  const url = `${BASE_URL}/oauth/access_token`;
  const params = {
    oauth_consumer_key:     CONSUMER_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp:        Math.floor(Date.now()/1000).toString(),
    oauth_token:            oauthToken,
    oauth_verifier:         verifier,
    oauth_version:          "1.0",
  };
  params.oauth_signature = sign("GET", url, params, CONSUMER_SECRET, oauthTokenSecret);
  const res  = await fetch(url, { headers: { Authorization: authHeader(params) } });
  const text = await res.text();
  console.log("\nStep 3 response:", text);
  return Object.fromEntries(new URLSearchParams(text));
}

const step = process.argv[2];

if (step === "1" || !step) {
  const tokens = await requestToken();
  if (tokens.oauth_token) {
    console.log("\n✓ Got request token. Now open this URL in your browser:");
    console.log(`\nhttps://us.etrade.com/e/t/etws/authorize?key=${CONSUMER_KEY}&token=${tokens.oauth_token}\n`);
    console.log("Accept, then run:  node get-etrade-token.mjs 3", tokens.oauth_token, tokens.oauth_token_secret, "VERIFIER_CODE");
  }
} else if (step === "3") {
  const [,, , oauthToken, oauthTokenSecret, verifier] = process.argv;
  if (!oauthToken || !oauthTokenSecret || !verifier) {
    console.error("Usage: node get-etrade-token.mjs 3 OAUTH_TOKEN OAUTH_TOKEN_SECRET VERIFIER");
    process.exit(1);
  }
  const tokens = await accessToken(oauthToken, oauthTokenSecret, verifier);
  if (tokens.oauth_token) {
    console.log("\n✓ SUCCESS! Add these to your .env.local:\n");
    console.log(`VITE_ETRADE_ACCESS_TOKEN=${tokens.oauth_token}`);
    console.log(`VITE_ETRADE_ACCESS_TOKEN_SECRET=${tokens.oauth_token_secret}`);
  }
}