import { describe, it, expect, vi } from "vitest";
import {
  roleAtLeast, isValidEmail, idleStatus, secondsUntilExpiry, idleMsFromEnv,
  shouldAttachAuth, normalizeAppUser, enabledProviders, DEFAULT_IDLE_MINUTES,
} from "../src/lib/authCore.js";
import {
  authorize, extractBearer, hasValidCronSecret, resolveUserFromToken, safeEqual, roleAtLeast as srvRoleAtLeast,
} from "../api/_lib/auth.js";

const res = () => {
  const r = { code: null, body: null };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  return r;
};
const ENV = { VITE_SUPABASE_URL: "https://x.supabase.co", VITE_SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_KEY: "svc", CRON_SECRET: "s3cret" };

describe("roles", () => {
  it("orders admin > trader > viewer", () => {
    expect(roleAtLeast("admin", "trader")).toBe(true);
    expect(roleAtLeast("trader", "trader")).toBe(true);
    expect(roleAtLeast("viewer", "trader")).toBe(false);
    expect(srvRoleAtLeast("viewer", "viewer")).toBe(true);
  });
  it("unknown / missing roles get nothing", () => {
    expect(roleAtLeast(undefined, "viewer")).toBe(false);
    expect(roleAtLeast("root", "viewer")).toBe(false);
    expect(roleAtLeast("admin", "nonsense")).toBe(false);
  });
});

describe("idle timeout", () => {
  const idleMs = 10 * 60_000;
  const now = 1_000_000_000;
  it("active inside the window", () => expect(idleStatus({ lastActivity: now - 60_000, now, idleMs })).toBe("active"));
  it("warns in the final minute", () => expect(idleStatus({ lastActivity: now - idleMs + 30_000, now, idleMs })).toBe("warn"));
  it("expires at the limit", () => expect(idleStatus({ lastActivity: now - idleMs, now, idleMs })).toBe("expired"));
  it("treats missing activity as active (fresh login)", () => expect(idleStatus({ lastActivity: undefined, now, idleMs })).toBe("active"));
  it("counts down seconds", () => expect(secondsUntilExpiry({ lastActivity: now - idleMs + 30_000, now, idleMs })).toBe(30));
  it("env parsing falls back to the default", () => {
    expect(idleMsFromEnv(undefined)).toBe(DEFAULT_IDLE_MINUTES * 60_000);
    expect(idleMsFromEnv("abc")).toBe(DEFAULT_IDLE_MINUTES * 60_000);
    expect(idleMsFromEnv("0")).toBe(DEFAULT_IDLE_MINUTES * 60_000);
    expect(idleMsFromEnv("15")).toBe(15 * 60_000);
  });
});

describe("client helpers", () => {
  it("validates emails", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail(" a@b.co ")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail(null)).toBe(false);
  });
  it("attaches the token only to same-origin /api/ calls", () => {
    const o = "https://app.example.com";
    expect(shouldAttachAuth("/api/etrade?action=positions", o)).toBe(true);
    expect(shouldAttachAuth("https://app.example.com/api/claude", o)).toBe(true);
    expect(shouldAttachAuth("https://evil.example.net/api/claude", o)).toBe(false);
    expect(shouldAttachAuth("https://api.schwabapi.com/v1/x", o)).toBe(false);
    expect(shouldAttachAuth("/other", o)).toBe(false);
    expect(shouldAttachAuth("//evil.example.net/api/x", o)).toBe(false);
  });
  it("normalizes app users and defaults to least privilege", () => {
    expect(normalizeAppUser(null)).toBeNull();
    const u = normalizeAppUser({ id: "frank", name: "Frank M DiMarzio" });
    expect(u.role).toBe("viewer");
    expect(u.initials).toBe("FM");
  });
  it("only enables known providers", () => {
    expect(enabledProviders("azure, GOOGLE ,github,")).toEqual([{ id: "azure", label: "Microsoft" }, { id: "google", label: "Google" }]);
    expect(enabledProviders(undefined)).toEqual([]);
  });
});

describe("server authorize()", () => {
  it("extracts bearer tokens", () => {
    expect(extractBearer({ headers: { authorization: "Bearer abc.def" } })).toBe("abc.def");
    expect(extractBearer({ headers: { authorization: "Basic abc" } })).toBeNull();
    expect(extractBearer({ headers: {} })).toBeNull();
  });
  it("safeEqual rejects empty / mismatched / non-strings", () => {
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "b")).toBe(false);
    expect(safeEqual("", "")).toBe(false);
    expect(safeEqual(undefined, "a")).toBe(false);
  });
  it("cron secret: header or query, fails closed when unset", () => {
    expect(hasValidCronSecret({ headers: { "x-cron-secret": "s3cret" } }, ENV)).toBe(true);
    expect(hasValidCronSecret({ headers: {}, query: { secret: "s3cret" } }, ENV)).toBe(true);
    expect(hasValidCronSecret({ headers: {}, query: { secret: "wrong" } }, ENV)).toBe(false);
    expect(hasValidCronSecret({ headers: {}, query: {} }, ENV)).toBe(false);
    expect(hasValidCronSecret({ headers: {}, query: { secret: "" } }, { ...ENV, CRON_SECRET: "" })).toBe(false);
    expect(hasValidCronSecret({ headers: {}, query: { secret: undefined } }, { ...ENV, CRON_SECRET: undefined })).toBe(false);
  });

  const mockSupabase = ({ user, row } = {}) => vi.fn(async (url) => {
    if (url.includes("/auth/v1/user")) return user ? { ok: true, json: async () => user } : { ok: false, json: async () => ({}) };
    if (url.includes("/rest/v1/app_users")) return { ok: true, json: async () => (row ? [row] : []) };
    throw new Error("unexpected " + url);
  });

  it("resolves an allow-listed confirmed user", async () => {
    const f = mockSupabase({ user: { id: "u1", email: "a@b.co", email_confirmed_at: "2026-01-01" }, row: { id: "frank", name: "F", role: "trader" } });
    const u = await resolveUserFromToken("tok", ENV, f);
    expect(u).toMatchObject({ id: "frank", role: "trader", authId: "u1" });
    // allow-list lookup is by auth user id, not by (spoofable) email
    expect(f.mock.calls[1][0]).toContain("auth_user_id=eq.u1");
  });
  it("rejects invalid token, unconfirmed email, and users not on the allow-list", async () => {
    expect(await resolveUserFromToken("bad", ENV, mockSupabase({ user: null }))).toBeNull();
    expect(await resolveUserFromToken("t", ENV, mockSupabase({ user: { id: "u", email: "a@b.co" }, row: { id: "x", role: "admin" } }))).toBeNull();
    expect(await resolveUserFromToken("t", ENV, mockSupabase({ user: { id: "u", email: "a@b.co", email_confirmed_at: "x" }, row: null }))).toBeNull();
    expect(await resolveUserFromToken(null, ENV, vi.fn())).toBeNull();
  });
  it("defaults a row with no role to viewer", async () => {
    const f = mockSupabase({ user: { id: "u1", email: "a@b.co", email_confirmed_at: "x" }, row: { id: "p", name: "P", role: null } });
    expect((await resolveUserFromToken("t", ENV, f)).role).toBe("viewer");
  });

  it("401s with no credentials and 401s cron-only for a user token", async () => {
    const r = res();
    expect(await authorize({ headers: {}, query: {} }, r)).toBeNull();
    expect(r.code).toBe(401);
  });
  it("accepts the cron secret", async () => {
    process.env.CRON_SECRET = "s3cret";
    const r = res();
    const a = await authorize({ headers: { "x-cron-secret": "s3cret" }, query: {} }, r, { cronOnly: true });
    expect(a).toEqual({ via: "cron" });
    delete process.env.CRON_SECRET;
  });
  it("cronOnly ignores user tokens entirely", async () => {
    const r = res();
    expect(await authorize({ headers: { authorization: "Bearer tok" }, query: {} }, r, { cronOnly: true })).toBeNull();
    expect(r.code).toBe(401);
  });
});
