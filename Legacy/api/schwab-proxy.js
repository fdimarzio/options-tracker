// api/schwab-proxy.js
// Proxies all Schwab API calls, auto-refreshing the access token when needed
// Browser calls: /api/schwab-proxy?path=/marketdata/v1/quotes&symbols=AAPL

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SCHWAB_BASE  = "https://api.schwabapi.com";

async function getValidToken() {
  // Load tokens from Supabase
  const res  = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_tokens`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const rows = await res.json();
  const t    = rows?.[0]?.cols;
  if (!t?.accessToken) throw new Error("No Schwab tokens — visit /api/schwab-auth to authorize");

  // If access token is still valid (with 2 min buffer), use it
  if (t.accessTokenExpiresAt > Date.now() + 120000) {
    return t.accessToken;
  }

  // Access token expired — use refresh token to get a new one
  if (!t.refreshToken) throw new Error("No refresh token — re-authorize at /api/schwab-auth");
  if (t.refreshTokenExpiresAt < Date.now()) throw new Error("Refresh token expired — re-authorize at /api/schwab-auth");

  const clientId     = process.env.SCHWAB_CLIENT_ID;
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
  const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const refreshRes = await fetch("https://api.schwabapi.com/v1/oauth/token", {
    method: "POST",
    headers: { "Authorization": `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken }),
  });

  const newTokens = await refreshRes.json();
  if (!newTokens.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(newTokens)}`);

  // Save refreshed tokens back to Supabase
  await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      id:  "schwab_tokens",
      cols: {
        ...t,
        accessToken:          newTokens.access_token,
        refreshToken:         newTokens.refresh_token || t.refreshToken,
        accessTokenExpiresAt: Date.now() + (newTokens.expires_in * 1000),
        savedAt:              new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    }),
  });

  console.log("[schwab-proxy] access token refreshed");
  return newTokens.access_token;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { path, ...queryParams } = req.query;
  if (!path) return res.status(400).json({ error: "Missing ?path= parameter" });

  try {
    const accessToken = await getValidToken();
    const qs          = Object.keys(queryParams).length ? "?" + new URLSearchParams(queryParams).toString() : "";
    const fullUrl     = `${SCHWAB_BASE}${path}${qs}`;

    console.log("[schwab-proxy] ->", fullUrl);

    const apiRes = await fetch(fullUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    const body = await apiRes.text();
    console.log("[schwab-proxy] <-", apiRes.status);
    res.status(apiRes.status).setHeader("Content-Type", "application/json").end(body);
  } catch (err) {
    console.error("[schwab-proxy] error:", err.message);
    res.status(500).json({ error: err.message });
  }
}
