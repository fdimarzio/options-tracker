// api/schwab-auth.js
// Consolidated Schwab OAuth handler — replaces schwab-auth.js, schwab-callback.js, schwab-token-refresh.js
//
// Actions:
//   GET  (no action)          — Step 1: redirect user to Schwab login page
//   GET  ?action=callback     — Step 2: Schwab redirects here with ?code=... after user approves
//   GET  ?action=refresh      — Daily token keeper: refresh access+refresh tokens (called by GitHub Actions/cron)
//   GET  ?action=status       — Check token health: days left, last run, etc.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query.action;

  // ── No action / default: Step 1 — redirect to Schwab login ─────────────────
  if (!action) {
    const clientId    = process.env.SCHWAB_CLIENT_ID;
    const callbackUrl = process.env.SCHWAB_CALLBACK_URL || "https://options-tracker-five.vercel.app/api/schwab-auth?action=callback";

    const params = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  callbackUrl,
      response_type: "code",
      scope:         "readonly",
    });

    return res.redirect(`https://api.schwabapi.com/v1/oauth/authorize?${params}`);
  }

  // ── action=callback: Step 2 — exchange code for tokens ─────────────────────
  if (action === "callback") {
    const { code, error } = req.query;
    if (error) return res.status(400).send(`Auth error: ${error}`);
    if (!code)  return res.status(400).send("No authorization code received");

    try {
      const clientId     = process.env.SCHWAB_CLIENT_ID;
      const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
      const callbackUrl  = process.env.SCHWAB_CALLBACK_URL || "https://options-tracker-five.vercel.app/api/schwab-auth?action=callback";

      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      const tokenRes = await fetch("https://api.schwabapi.com/v1/oauth/token", {
        method: "POST",
        headers: {
          Authorization:  `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callbackUrl }),
      });

      const tokens = await tokenRes.json();
      if (!tokens.access_token) {
        return res.status(500).send(`Token exchange failed: ${JSON.stringify(tokens)}`);
      }

      await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({
          id: "schwab_tokens",
          cols: {
            accessToken:           tokens.access_token,
            refreshToken:          tokens.refresh_token,
            accessTokenExpiresAt:  Date.now() + (tokens.expires_in * 1000),
            refreshTokenExpiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000),
            savedAt:               new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        }),
      });

      return res.status(200).send(`
        <html><body style="font-family:monospace;background:#0d1117;color:#00ff88;padding:40px">
          <h2>✓ Schwab Connected Successfully</h2>
          <p>Tokens saved. You can close this window and return to the app.</p>
          <p style="color:#555;font-size:12px">Access token expires in ${Math.round(tokens.expires_in / 60)} minutes. Refresh token valid for 7 days.</p>
        </body></html>
      `);
    } catch (err) {
      return res.status(500).send(`Error: ${err.message}`);
    }
  }

  // ── action=refresh: Daily token keeper — resets 7-day refresh window ────────
  if (action === "refresh") {
    const secret   = process.env.CRON_SECRET;
    const provided = req.headers["x-cron-secret"] || req.query.secret;
    if (secret && provided !== secret) return res.status(401).json({ error: "Unauthorized" });

    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_tokens`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      const t = (await r.json())?.[0]?.cols;
      if (!t?.refreshToken) return res.status(500).json({ error: "No refresh token — re-authorize at /api/schwab-auth" });

      if (t.refreshTokenExpiresAt < Date.now()) {
        return res.status(500).json({
          error: "Refresh token expired — manual re-auth required at /api/schwab-auth",
          expiredAt: new Date(t.refreshTokenExpiresAt).toISOString(),
        });
      }

      const daysLeft = ((t.refreshTokenExpiresAt - Date.now()) / 86400000).toFixed(1);
      const creds = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString("base64");
      const tokenRes = await fetch("https://api.schwabapi.com/v1/oauth/token", {
        method: "POST",
        headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken }),
      });

      const n = await tokenRes.json();
      if (!n.access_token) return res.status(500).json({ error: `Token refresh failed: ${JSON.stringify(n)}` });

      const now = Date.now();
      const newTokens = {
        accessToken:           n.access_token,
        refreshToken:          n.refresh_token || t.refreshToken,
        accessTokenExpiresAt:  now + (n.expires_in * 1000),
        refreshTokenExpiresAt: now + (7 * 24 * 60 * 60 * 1000),
        savedAt:               new Date().toISOString(),
        lastKeeperRun:         new Date().toISOString(),
      };

      await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id: "schwab_tokens", cols: newTokens, updated_at: new Date().toISOString() }),
      });

      console.log(`[schwab-auth] token keeper refreshed OK, was ${daysLeft}d left`);
      return res.status(200).json({
        ok: true,
        daysLeftBefore: +daysLeft,
        accessExpiresIn: `${Math.round(n.expires_in / 60)}min`,
        refreshReset: "7 days from now",
        savedAt: newTokens.savedAt,
      });
    } catch (err) {
      console.error("[schwab-auth] refresh error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── action=status: Token health check ──────────────────────────────────────
  if (action === "status") {
    const secret   = process.env.CRON_SECRET;
    const provided = req.headers["x-cron-secret"] || req.query.secret;
    if (secret && provided !== secret) return res.status(401).json({ error: "Unauthorized" });

    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.schwab_tokens`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      const t = (await r.json())?.[0]?.cols;
      if (!t) return res.status(200).json({ ok: false, reason: "No tokens found" });

      const now = Date.now();
      return res.status(200).json({
        ok:              true,
        accessOk:        t.accessTokenExpiresAt > now,
        accessExpiresIn: `${Math.round((t.accessTokenExpiresAt - now) / 60000)}min`,
        refreshOk:       t.refreshTokenExpiresAt > now,
        refreshDaysLeft: +((t.refreshTokenExpiresAt - now) / 86400000).toFixed(1),
        lastKeeperRun:   t.lastKeeperRun || "unknown",
        savedAt:         t.savedAt,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}
