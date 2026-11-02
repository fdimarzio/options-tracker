// Shared request authorization for /api/* handlers.
//
// Two kinds of caller are accepted:
//   1. Server-to-server (GitHub Actions, cron, other API routes): CRON_SECRET via
//      the x-cron-secret header or ?secret= query param.
//   2. Signed-in browser users: a Supabase access token in `Authorization: Bearer`,
//      which must belong to an allow-listed row in app_users (matched by auth_user_id).
//
// Fails CLOSED: with no CRON_SECRET configured, secret auth is never accepted.

import { timingSafeEqual } from "node:crypto";

export const ROLE_RANK = { viewer: 1, trader: 2, admin: 3 };

export function roleAtLeast(role, minRole) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[minRole] || Infinity);
}

export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function extractBearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(h) ? h[0] : h);
  return m ? m[1].trim() : null;
}

export function hasValidCronSecret(req, env = process.env) {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  const provided = req.headers?.["x-cron-secret"] || req.query?.secret;
  return safeEqual(String(provided || ""), secret);
}

// Resolves a Supabase access token to an allow-listed app user, or null.
export async function resolveUserFromToken(token, env = process.env, fetchImpl = fetch) {
  const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
  const anon = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;
  if (!token || !url || !anon) return null;

  const who = await fetchImpl(`${url}/auth/v1/user`, {
    headers: { apikey: anon, Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!who?.ok) return null;
  const authUser = await who.json().catch(() => null);
  if (!authUser?.id || !authUser.email_confirmed_at) return null;

  // Service key reads the allow-list regardless of RLS; the user's own token works
  // too once RLS is locked down, so fall back to it.
  const key = env.SUPABASE_SERVICE_KEY;
  const rows = await fetchImpl(
    `${url}/rest/v1/app_users?auth_user_id=eq.${encodeURIComponent(authUser.id)}&select=id,name,role&limit=1`,
    { headers: { apikey: key || anon, Authorization: `Bearer ${key || token}` } }
  ).then(r => (r.ok ? r.json() : null)).catch(() => null);

  const row = rows?.[0];
  if (!row) return null;
  return { authId: authUser.id, email: authUser.email, id: row.id, name: row.name, role: row.role || "viewer" };
}

// Returns { via, user? } on success. On failure it has already sent the response
// and returns null — callers should `if (!auth) return;`.
export async function authorize(req, res, { minRole = "viewer", cronOnly = false, allowCron = true } = {}) {
  if (allowCron && hasValidCronSecret(req)) return { via: "cron" };

  if (!cronOnly) {
    const token = extractBearer(req);
    if (token) {
      const user = await resolveUserFromToken(token);
      if (user) {
        if (roleAtLeast(user.role, minRole)) return { via: "user", user };
        res.status(403).json({ error: "Forbidden" });
        return null;
      }
    }
  }

  res.status(401).json({ error: "Unauthorized" });
  return null;
}
