// api/schwab-callback.js
// Step 2 — Schwab redirects here with ?code=... after user approves
// Exchanges code for access + refresh tokens, saves to Supabase

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(`Auth error: ${error}`);
  }
  if (!code) {
    return res.status(400).send("No authorization code received");
  }

  try {
    const clientId     = process.env.SCHWAB_CLIENT_ID;
    const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
    const callbackUrl  = process.env.SCHWAB_CALLBACK_URL || "https://options-tracker-five.vercel.app/api/schwab-callback";

    // Exchange code for tokens
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const tokenRes = await fetch("https://api.schwabapi.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type":  "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:   "authorization_code",
        code,
        redirect_uri: callbackUrl,
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      return res.status(500).send(`Token exchange failed: ${JSON.stringify(tokens)}`);
    }

    // Save tokens to Supabase
    await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
      method: "POST",
      headers: {
        apikey:         SUPABASE_KEY,
        Authorization:  `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer:         "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        id:  "schwab_tokens",
        cols: {
          accessToken:           tokens.access_token,
          refreshToken:          tokens.refresh_token,
          accessTokenExpiresAt:  Date.now() + (tokens.expires_in * 1000),
          refreshTokenExpiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000), // 7 days
          savedAt:               new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      }),
    });

    res.status(200).send(`
      <html><body style="font-family:monospace;background:#0d1117;color:#00ff88;padding:40px">
        <h2>✓ Schwab Connected Successfully</h2>
        <p>Tokens saved. You can close this window and return to the app.</p>
        <p style="color:#555;font-size:12px">Access token expires in ${Math.round(tokens.expires_in/60)} minutes. Refresh token valid for 7 days.</p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
}
