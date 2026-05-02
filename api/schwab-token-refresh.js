// api/schwab-token-refresh.js
// Proactively refreshes the Schwab access+refresh token pair before the
// 7-day refresh token window expires.  Called by GitHub Actions daily.
// This resets the 7-day clock so manual re-auth is never needed as long
// as the job runs at least once every 6 days.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const secret   = process.env.CRON_SECRET;
  const provided = req.headers["x-cron-secret"] || req.query.secret;
  if (secret && provided !== secret) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Load current tokens
    const r = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_tokens`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const t = (await r.json())?.[0]?.cols;
    if (!t?.refreshToken) return res.status(500).json({ error: "No refresh token found — re-authorize at /api/schwab-auth" });

    // Check if refresh token is already expired
    if (t.refreshTokenExpiresAt < Date.now()) {
      return res.status(500).json({
        error: "Refresh token expired — manual re-auth required at /api/schwab-auth",
        expiredAt: new Date(t.refreshTokenExpiresAt).toISOString(),
      });
    }

    const daysLeft = ((t.refreshTokenExpiresAt - Date.now()) / 86400000).toFixed(1);

    // Always refresh — this resets the 7-day window
    const creds = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString("base64");
    const tokenRes = await fetch("https://api.schwabapi.com/v1/oauth/token", {
      method: "POST",
      headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken }),
    });

    const n = await tokenRes.json();
    if (!n.access_token) {
      return res.status(500).json({ error: `Token refresh failed: ${JSON.stringify(n)}` });
    }

    const now = Date.now();
    const newTokens = {
      accessToken:           n.access_token,
      refreshToken:          n.refresh_token || t.refreshToken,
      accessTokenExpiresAt:  now + (n.expires_in * 1000),
      // Reset the 7-day window from now
      refreshTokenExpiresAt: now + (7 * 24 * 60 * 60 * 1000),
      savedAt:               new Date().toISOString(),
      lastKeeperRun:         new Date().toISOString(),
    };

    await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ id: "schwab_tokens", cols: newTokens, updated_at: new Date().toISOString() }),
    });

    console.log(`[schwab-token-refresh] refreshed OK, was ${daysLeft}d left on refresh token`);
    res.status(200).json({
      ok: true,
      daysLeftBefore: +daysLeft,
      accessExpiresIn: `${Math.round(n.expires_in / 60)}min`,
      refreshReset: "7 days from now",
      savedAt: newTokens.savedAt,
    });
  } catch (err) {
    console.error("[schwab-token-refresh]", err.message);
    res.status(500).json({ error: err.message });
  }
}
