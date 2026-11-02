// Pure auth helpers (no React, no network) so they can be unit-tested in node.

export const ROLE_RANK = { viewer: 1, trader: 2, admin: 3 };

export function roleAtLeast(role, minRole) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[minRole] || Infinity);
}

export function isValidEmail(v) {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
}

export const DEFAULT_IDLE_MINUTES = 120;
export const WARN_SECONDS = 60;

export function idleMsFromEnv(raw) {
  const n = Number(raw);
  return (Number.isFinite(n) && n >= 1 ? n : DEFAULT_IDLE_MINUTES) * 60_000;
}

// 'active' | 'warn' | 'expired'
export function idleStatus({ lastActivity, now, idleMs, warnMs = WARN_SECONDS * 1000 }) {
  const last = Number(lastActivity);
  if (!Number.isFinite(last) || last <= 0) return "active";
  const idle = now - last;
  if (idle >= idleMs) return "expired";
  if (idle >= idleMs - warnMs) return "warn";
  return "active";
}

export function secondsUntilExpiry({ lastActivity, now, idleMs }) {
  return Math.max(0, Math.ceil((Number(lastActivity) + idleMs - now) / 1000));
}

// Only same-origin /api/ requests carry the user's token — never third-party hosts.
export function shouldAttachAuth(url, origin) {
  try {
    const u = new URL(typeof url === "string" ? url : url?.url ?? "", origin);
    return u.origin === origin && u.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

export function normalizeAppUser(row) {
  if (!row?.id) return null;
  const name = row.name || row.id;
  const initials = row.initials || name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
  return { ...row, name, initials, color: row.color || "#00ff88", role: row.role || "viewer" };
}

export function enabledProviders(raw) {
  const allowed = { azure: "Microsoft", google: "Google" };
  return String(raw || "").split(",").map(s => s.trim().toLowerCase()).filter(p => allowed[p]).map(p => ({ id: p, label: allowed[p] }));
}
