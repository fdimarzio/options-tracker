// Auth end-to-end tests. Runs against a LOCAL build wired to a mocked Supabase, so it
// needs no real accounts, passwords or secrets.
//
//   VITE_SUPABASE_URL=https://mock.supabase.co VITE_SUPABASE_ANON_KEY=mock-anon-key VITE_IDLE_MINUTES=2 \
//     npx vite build --outDir dist-e2e
//   npx vite preview --outDir dist-e2e --port 4173 &
//   E2E_BASE_URL=http://localhost:4173 npx playwright test tests/e2e/auth.e2e.spec.js

import { test, expect } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://localhost:4173";
const SB = "https://mock.supabase.co";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "*" };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = (sub, email) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, email, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const FRANK = { id: "frank", name: "Frank M DiMarzio", initials: "FD", color: "#00ff88", role: "admin", email: "frank@example.com" };

function makeSession(email = "frank@example.com", sub = "11111111-1111-1111-1111-111111111111") {
  return {
    access_token: fakeJwt(sub, email), token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "refresh-token",
    user: { id: sub, aud: "authenticated", role: "authenticated", email, email_confirmed_at: "2026-01-01T00:00:00Z", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" },
  };
}

async function mockBackend(page, { claim = [FRANK], knownEmails = ["frank@example.com"] } = {}) {
  const log = { rest: [], api: [], otp: [], verify: 0, logout: 0, claim: 0 };
  const session = makeSession();

  await page.route(`${SB}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const json = (status, body) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });

    if (url.pathname === "/auth/v1/otp") {
      const body = JSON.parse(req.postData() || "{}");
      log.otp.push(body);
      if (!knownEmails.includes(String(body.email).toLowerCase())) return json(422, { code: 422, error_code: "otp_disabled", msg: "Signups not allowed for otp" });
      return json(200, {});
    }
    if (url.pathname === "/auth/v1/verify") { log.verify++; return json(200, session); }
    if (url.pathname === "/auth/v1/token") return json(200, session);
    if (url.pathname === "/auth/v1/user") return json(200, session.user);
    if (url.pathname === "/auth/v1/logout") { log.logout++; return route.fulfill({ status: 204, headers: CORS }); }
    if (url.pathname.startsWith("/rest/v1/rpc/claim_app_user")) { log.claim++; return json(200, claim); }
    if (url.pathname.startsWith("/rest/v1/")) {
      log.rest.push({ method: req.method(), path: url.pathname, search: url.search });
      return json(req.method() === "GET" ? 200 : 201, []);
    }
    return json(404, {});
  });

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    if (!req.url().startsWith(BASE)) return route.continue();
    log.api.push({ url: req.url(), authorization: req.headers()["authorization"] });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, orders: [] }) });
  });
  // Block Google Fonts etc. so the test never depends on the network.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  return { log, session };
}

async function signInWithCode(page, email = "frank@example.com") {
  await page.goto(BASE);
  await page.getByLabel("EMAIL").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByLabel("CODE").fill("123456");
  await page.getByRole("button", { name: "Verify code" }).click();
}
const appLoaded = (page) => page.waitForSelector("button:has-text('📋')", { timeout: 15000 });

test.describe("unauthenticated access", () => {
  test("shows the sign-in screen, loads no data, and has no PIN UI", async ({ page }) => {
    const { log } = await mockBackend(page);
    await page.goto(BASE);
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
    await expect(page.getByText("SELECT USER")).toHaveCount(0);
    await expect(page.getByText(/Enter .*PIN/i)).toHaveCount(0);
    await page.waitForTimeout(800);
    expect(log.rest, "no data requests before sign-in").toEqual([]);
    expect(log.api, "no /api calls before sign-in").toEqual([]);
  });

  for (const route of ["/import", "/chain", "/anything-else"]) {
    test(`route ${route} is behind the gate`, async ({ page }) => {
      const { log } = await mockBackend(page);
      await page.goto(BASE + route);
      await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
      await page.waitForTimeout(500);
      expect(log.rest).toEqual([]);
      expect(log.api).toEqual([]);
    });
  }

  test("rejects a malformed email without calling the server", async ({ page }) => {
    const { log } = await mockBackend(page);
    await page.goto(BASE);
    await page.getByLabel("EMAIL").fill("not-an-email");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByRole("alert")).toContainText("valid email");
    expect(log.otp).toEqual([]);
  });

  test("does not reveal whether an email is authorized (no account enumeration)", async ({ page }) => {
    const { log } = await mockBackend(page);
    await page.goto(BASE);
    await page.getByLabel("EMAIL").fill("stranger@example.com");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByText("If that email is authorized")).toBeVisible();
    expect(log.otp[0].options?.shouldCreateUser ?? log.otp[0].create_user).toBeFalsy();
  });

  test("a signed-in but non-allow-listed account is denied and loads no data", async ({ page }) => {
    const { log } = await mockBackend(page, { claim: [] });
    await signInWithCode(page);
    await expect(page.getByRole("alert")).toContainText("not authorized");
    await page.waitForTimeout(500);
    expect(log.rest, "no data fetched for a denied account").toEqual([]);
    expect(log.api).toEqual([]);
  });
});

test.describe("authenticated session", () => {
  test("code sign-in loads the app; API calls carry the user's token and no shared secret", async ({ page }) => {
    const { log, session } = await mockBackend(page);
    await signInWithCode(page);
    await appLoaded(page);
    expect(log.claim).toBeGreaterThan(0);

    // Trigger an /api call from the app (market data / chase poll fire shortly after load).
    await expect.poll(() => log.api.length, { timeout: 25000 }).toBeGreaterThan(0);
    for (const c of log.api) {
      expect(c.authorization, c.url).toBe(`Bearer ${session.access_token}`);
      expect(c.url).not.toMatch(/[?&]secret=/i);
    }
    const userReads = log.rest.filter((r) => r.path.endsWith("/app_users"));
    expect(userReads.length).toBeGreaterThan(0);
    for (const r of userReads) expect(decodeURIComponent(r.search)).not.toMatch(/\bpin\b|select=\*/);
  });

  test("session survives a reload", async ({ page }) => {
    await mockBackend(page);
    await signInWithCode(page);
    await appLoaded(page);
    await page.reload();
    await appLoaded(page);
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toHaveCount(0);
  });

  test("logout returns to sign-in, clears the stored session, and stays logged out on reload", async ({ page }) => {
    const { log } = await mockBackend(page);
    await signInWithCode(page);
    await appLoaded(page);
    expect(await page.evaluate(() => Object.keys(localStorage).some((k) => k.includes("auth-token")))).toBe(true);

    await page.getByTitle("Frank M DiMarzio").click();
    await page.getByRole("button", { name: /Sign Out/i }).click();
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
    expect(log.logout).toBe(1);
    expect(await page.evaluate(() => Object.keys(localStorage).some((k) => k.includes("auth-token")))).toBe(false);

    await page.reload();
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
  });

  test("sign-out in one tab signs out the other", async ({ page, context }) => {
    await mockBackend(page);
    await signInWithCode(page);
    await appLoaded(page);
    const second = await context.newPage();
    await mockBackend(second);
    await second.goto(BASE);
    await appLoaded(second);

    await page.getByTitle("Frank M DiMarzio").click();
    await page.getByRole("button", { name: /Sign Out/i }).click();
    await expect(second.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible({ timeout: 10000 });
  });
});

test.describe("idle timeout (build uses VITE_IDLE_MINUTES=2)", () => {
  test("warns, can be extended, then signs out when truly idle", async ({ page }) => {
    await page.clock.install();
    await mockBackend(page);
    await signInWithCode(page);
    await appLoaded(page);

    await page.clock.fastForward(75_000);
    await expect(page.getByRole("alertdialog")).toContainText("Signing out in");

    await page.getByRole("button", { name: "Stay signed in" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toHaveCount(0);

    await page.clock.fastForward(150_000);
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible({ timeout: 10000 });
  });
});
