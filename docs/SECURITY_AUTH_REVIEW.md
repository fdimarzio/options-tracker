# TOD Security Review & Authentication Modernization

Scope: the 4-digit-PIN login, session handling, API protection, database access, and the replacement (Supabase Auth, allow-listed, role-aware).
Findings were verified in the code and, read-only, against the live Supabase project (policy/grant metadata only — no row data, PIN values or token values were read).

---

## 1. Security assessment of the PIN model

The PIN was never the real lock. It was a client-side screen in front of a system with no server-side access control at all.

### Critical

| # | Finding | Evidence | Impact |
|---|---|---|---|
| C1 | **The shared API secret (value deliberately not repeated here) is hard-coded in the browser bundle and in the (public) repo.** Every order endpoint accepts it. | 12 call sites in `src/pri-tod-v3.jsx` (`schwab-orders?action=…&secret=…`); `gh repo view` → `PUBLIC` | Anyone can list, **place, cancel, re-price and chase** live Schwab / E*Trade orders and read E*Trade positions. This is the worst finding. |
| C2 | **The database is open to the public anon key.** The anon key ships in the bundle by design; RLS did not restrict it. | Live: 50 of 57 policies are `ALL … USING (true)`; `col_prefs`, `contracts`, `trade_orders`, `app_users` each have an `anon … ALL true` policy; **9 of 53 public tables have RLS disabled** | Anyone can read, edit or delete every table. Broker OAuth token rows (`schwab_tokens`, `etrade_tokens`) live in `col_prefs`, which is anon-readable by policy. |
| C3 | **PINs are plaintext in the public repo and in the database.** Both users' PINs (values deliberately not repeated here) in `USERS_DEFAULT`; `app_users.pin` is plaintext and was fetched to the browser with `select("*")`. | `src/pri-tod-v3.jsx` (old L150), `app_users` schema | PINs are public. They also gated nothing server-side. |
| C4 | **The gate was cosmetic.** All data loads on mount, before login; the PIN comparison runs in the browser (`np === loginTarget.pin`). | old `load()` effect | Opening devtools / calling Supabase directly bypasses it. |

### High

- `api/schwab-proxy.js` and `api/claude.js` had **no authentication** and `Access-Control-Allow-Origin: *`. The proxy forwarded **any** Schwab path, including `/trader/v1/accounts` (account numbers, balances, positions, orders). `claude.js` let anyone spend the Anthropic key.
- `api/etrade.js?action=import&dryRun=1` was explicitly unauthenticated.
- Every gate was **fail-open**: `if (secret && provided !== secret)` — an unset `CRON_SECRET` meant no auth. Compared with `!==` (not constant-time). Secrets travelled in query strings (they end up in access logs).
- `/import` and `/chain` routes had no gate of any kind.
- Maintenance RPCs (`run_snapshot_purge` [SECURITY DEFINER], `purge_ticker`, `update_contract_profit`, …) were executable by `anon`.

### Medium / Low

- 4-digit PIN = 10,000 combinations; no lockout, no rate limiting (SMOKE_TEST.md lists a lockout that was not implemented).
- No session model: auth lived in React state only; no expiry, no server-side session, no revocation.
- No security headers. `VITE_ANTHROPIC_API_KEY` is a `VITE_`-prefixed name for a server secret (a hazard if ever referenced in client code; it currently is not). `vite.config.js` dev proxy logs credential fragments (dev only).

### Local storage / cookies / env
Only UI prefs are in `localStorage` (`pri_ui_scale`, `pri_light_mode`, `pri_auto_refresh`). No cookies. The built bundle previously contained the shared secret and PIN literals; it now contains neither (verified by grep on `dist/`).

---

## 2. Recommended architecture

**Supabase Auth (already the backend) + a DB-enforced allow-list + role-aware RLS.**

```
Browser ──email link / 6-digit code (or Microsoft/Google when enabled)──▶ Supabase Auth
   │  access token (JWT, auto-refreshed)
   ├─▶ Supabase REST ── Postgres RLS: is_app_user() / app_role() ──▶ data
   └─▶ /api/*  Authorization: Bearer <JWT> ──▶ authorize(): verify token → allow-list → role
                 cron / GitHub Actions: x-cron-secret (server-to-server only, fails closed)
```

### Option comparison

| | Security | Complexity | UX | Maintenance |
|---|---|---|---|---|
| **A Email + password** | Weak-to-OK; password reuse/phishing; needs reset flow, breach handling | Low | OK | Medium (reset, rotation) |
| **B Magic link / email code** | OK (≈ security of the mailbox); no passwords to leak; phishable only via the mailbox | **Lowest** (native in Supabase) | Good; slightly slow per login | Low |
| **C Passkeys** | **Best** (phishing-resistant, device-bound) | **High today** — Supabase Auth has no native passkey primary login; needs WebAuthn server verification (e.g. SimpleWebAuthn) and minting sessions | Best (one tap) | Medium (credential lifecycle, recovery) |
| **D Microsoft / Google** | Strong *if* the IdP account has MFA/passkeys; inherits them for free | Medium: app registration, redirect URIs, secrets; account-linking rules | Good | Medium (secret expiry, tenant config) |
| **E Hybrid (recommended)** | B now, D optional, C when ready, TOTP MFA between | Incremental | Best of each | Medium |

### Your preference (Microsoft and/or passkeys): validated, with two challenges

- **Validated:** removing passwords and delegating strong auth is the right direction, and Microsoft/Google sign-in gets passkey + MFA support "for free" from the IdP.
- **Challenge 1 — Microsoft is not automatically safer.** Entra's `email` claim is mutable and, for multi-tenant apps, not guaranteed verified; matching users by email from an IdP is a known account-takeover class ("nOAuth"). This design therefore **binds the allow-list to the immutable Supabase user id on first sign-in** (`claim_app_user()`), requires a confirmed email, and never re-matches by email afterwards. It also needs an Azure app registration I cannot create for you, and gives a two-person app a third-party dependency.
- **Challenge 2 — passkeys-only is a poor *first* step.** Without native Supabase support it is the largest build, and with two users the recovery story (lost device) needs a fallback anyway. Passkeys are the right *target* (Phase 3), not the right Phase 1.
- **Why B first:** it works today with zero new vendors, removes the shared secrets and the open database (the real risks), and is honest about being only as strong as the mailbox — which is why Phase 2 adds TOTP MFA.

Microsoft/Google buttons are already built behind a flag: set `VITE_AUTH_PROVIDERS=azure,google` (after enabling the provider in Supabase) and they appear. No code change needed.

### Session management (implemented / recommended)

| Topic | Phase 1 (done) | Recommended next |
|---|---|---|
| Tokens | Supabase JWT (1 h) + rotating refresh token, auto-refresh, stored by supabase-js | Shorten refresh-token reuse interval; enable refresh-token rotation (default on) |
| Idle timeout | 120 min of no input (`VITE_IDLE_MINUTES`), 60 s warning, **any tab's activity counts** | Lower to 30–60 min once passkeys make re-auth one tap |
| Absolute lifetime | Supabase refresh-token validity | Time-box sessions to 7–30 days (Supabase Pro setting) |
| Logout | Revokes the session server-side, clears storage, syncs across tabs | "Sign out everywhere" (`scope:'global'`) |
| Remember me / device trust | Not yet | Phase 2: trusted-device flag extends idle limit and skips MFA on that device for N days |
| Token storage | `localStorage` (supabase-js default) | Acceptable with a strict CSP; add CSP (report-only first) — XSS is the residual risk |
| Rate limiting | Supabase email OTP limits + 30 s client resend cooldown | Per-user limits on `/api/claude` and order endpoints |

### Authorization

Roles `admin ⊃ trader ⊃ viewer`, stored on `app_users.role`, enforced **twice**:

- **Postgres RLS**: allow-listed users can `SELECT`; only `admin`/`trader` can write; only `admin` can edit the roster. A viewer cannot write even by calling Supabase directly.
- **API** (`api/_lib/auth.js`): viewer = read quotes/orders/positions; trader = place/cancel/reprice/chase/AI; cron-only endpoints (market-refresh, auto-import, …) reject user tokens entirely.

Both current users are seeded as `admin` (set in step 2 of the runbook); adding a read-only user later is one `INSERT` + one invite.

---

## 3. Implementation summary

**Server** — `api/_lib/auth.js`: `authorize(req,res,{minRole,cronOnly})`. Accepts a verified Supabase token whose user is on the allow-list (by `auth_user_id`, email confirmed) **or** `CRON_SECRET` (constant-time compare, fails closed when unset). Applied to every handler in `api/`. `schwab-proxy` is now market-data-only (`/marketdata/v1/…`) and strips caller secrets. Server code prefers `SUPABASE_SERVICE_KEY` over the anon key for DB access.

**Client** — `src/AuthGate.jsx` wraps **every route** (`main.jsx`): nothing renders or fetches until signed in and allow-listed. New sign-in screen (email → link/code, optional Microsoft/Google), denied/setup states, idle timeout with warning, cross-tab sign-out. `src/lib/apiAuth.js` adds the user's token to same-origin `/api/*` calls only. All hard-coded secrets, PIN keypad, PIN-change UI and client-side user seeding removed; Profile now shows email + role + Sign out. `OptionsChain`/`ImportPage` use the shared authenticated client; API URLs made relative.

**Database** (`sql/auth/`, **not applied** — see runbook):
`001` additive: `email/role/auth_user_id` on `app_users`, `is_app_user()`, `app_role()`, `claim_app_user()` · `002` lockdown: RLS on all tables, role-aware policies, revoke anon RPC access · `002_rollback` · `003` drop `pin`.

**Other** — `vercel.json` security headers + `no-store` on `/api`; keep-alive workflow sends the secret as a header; smoke tests rewritten for passwordless auth.

### Files changed
`api/_lib/auth.js` (new) · all of `api/*.js` · `src/AuthGate.jsx`, `src/lib/{supabase,authCore,apiAuth,authContext}.js` (new) · `src/{main,pri-tod-v3,ImportPage,OptionsChain,OpportunityScanner}.jsx` · `sql/auth/*` (new) · `vercel.json` · `.github/workflows/market-refresh.yml` (1 line) · `tests/auth.test.js`, `tests/api-auth-wiring.test.js`, `tests/e2e/auth.e2e.spec.js` (new) · 6 existing tests updated (they relied on the fail-open behaviour) · `tests/smoke.spec.js`, `SMOKE_TEST.md`, `.gitignore`, `scripts/*` (service-key preference) · this doc.

---

## 4. Test results

| Suite | Result |
|---|---|
| Full unit suite (`npm test`) | **957 passed** (incl. 21 new helper tests and 38 new API-auth tests) |
| `tests/api-auth-wiring.test.js` — real handlers, stubbed network | anonymous → 401 on all 16 endpoint/action pairs; previously hard-coded secret value → 401; non-allow-listed and unconfirmed users → 401; **fails closed** with no `CRON_SECRET`; viewer → 403 on place/cancel/chase/AI/E*Trade proxy; a `POST` cannot masquerade as a read action; cron-only endpoints reject admin user tokens; proxy 403 for `/trader/…`, `/v1/oauth/…`, `..` traversal, `//host`; caller secrets never forwarded |
| `tests/e2e/auth.e2e.spec.js` — Chromium desktop **12/12**, Pixel 7 viewport (Chromium) **12/12** | signed-out shows only sign-in and issues **zero** data/API requests; `/import`, `/chain`, unknown routes gated; bad email rejected client-side; unknown email gets the same message (no enumeration); non-allow-listed account denied with no data load; code sign-in works; **every `/api` call carries `Bearer <token>` and none has `secret=`**; `app_users` query never asks for `pin`; session survives reload; logout revokes, clears storage, stays out after reload; sign-out propagates to a second tab; idle warning → "Stay signed in" → auto sign-out |
| SQL (`001`/`002`/rollback/`003`) on a real Postgres engine (PGlite) with Supabase-style roles | **31/31**: baseline reproduces the open-DB finding; claim binds only confirmed, allow-listed emails; a second identity with an already-bound email cannot take over; after lockdown anon reads/writes nothing (including the formerly RLS-less table, PINs and RPCs); non-allow-listed authenticated gets nothing; viewer read-only; trader writes but cannot grant roles; service role unaffected; rollback restores prior state |

Bugs the tests caught and I fixed: the inactivity warning rendered *under* the app's bottom nav (z-index 9999) and could not be clicked; 6 legacy tests depended on the old fail-open behaviour.

### Not tested — please verify during rollout
- **Real email delivery, magic-link redirect and OTP code** against your Supabase project (tested with a mocked auth backend). Opening the link on a *different* device than the one that requested it will not sign in the original browser — use the code.
- **Microsoft/Google OAuth** (not configured).
- **iOS Safari/WebKit** (not installed here; Pixel 7 was emulated in Chromium).
- **`002` against the real 53-table schema.** It was tested on an emulated schema; run it in a quiet moment with the rollback script open. It briefly takes locks on every table.
- Vercel runtime behaviour (handlers were exercised by direct import).

---

## 5. Rollout runbook (order matters)

**Do first — independent of everything else**
1. After the new build is deployed (step 5), **rotate `CRON_SECRET`** to a new random value (`openssl rand -hex 32`) in **Vercel env** and **GitHub Actions secrets**. The old value is in git history and was in every browser bundle; treat it as public. Making the repo private is sensible but does **not** un-leak history.

**Supabase dashboard**
2. Authentication → Providers → Email: enabled. **Disable "Allow new users to sign up".** Authentication → URL configuration: Site URL = production URL; add preview URLs if used. Edit the *Magic Link* template to include `{{ .Token }}` next to `{{ .ConfirmationURL }}` (this enables the code path). Configure custom SMTP — the built-in sender is heavily rate-limited.
3. Authentication → Users → **Invite** the two email addresses.

**Database**
4. Run `sql/auth/001_app_users_auth.sql`, then (addresses intentionally not committed):
   `UPDATE app_users SET email=lower('…'), role='admin' WHERE id='frank';` and the same for `priscilla`.

**Deploy**
5. Vercel env: confirm `SUPABASE_SERVICE_KEY` is set (server code now prefers it); optional `VITE_IDLE_MINUTES`, `VITE_AUTH_PROVIDERS`. Merge the PR → deploy. Sign in as each user and confirm the dashboard loads and orders/quotes work.

**Lock the database** (only after step 5 is verified)
6. Confirm GitHub Actions secrets `SUPABASE_SERVICE_KEY` exist for all workflows and local scripts export it. Run `sql/auth/002_lockdown_rls.sql`; check a cron run and the dashboard. If anything breaks: `sql/auth/002_rollback_open_rls.sql`.
7. Run `sql/auth/003_drop_pin.sql`.
8. **Re-authorize Schwab and E*Trade** (SCH⟳ / ET⟳): their token rows were readable and writable by the public anon key until step 6, so treat the old tokens as exposed.

---

## 6. Follow-up recommendations

1. **Phase 2:** TOTP MFA (`supabase.auth.mfa`) required on sign-in; trusted-device flag (longer idle limit, skip MFA for N days, revocable list in `app_users`/new table); "sign out everywhere".
2. **Phase 3:** passkeys — prefer enabling them via Microsoft/Google account if you adopt D; otherwise WebAuthn with SimpleWebAuthn and a server endpoint that mints a Supabase session. Keep email code as recovery.
3. **Hide controls by role in the UI** (viewer still *sees* order buttons; the server returns 403 and RLS blocks writes, but the UI should not offer them). `useAuth().can("trader")` is ready.
4. **Add CSP** (start `Content-Security-Policy-Report-Only`) — it is the main defence for tokens in `localStorage`. Restrict CORS on `/api/*` from `*` to the app origin.
5. **Move broker tokens out of `col_prefs`** into a service-role-only table so they are never reachable from a user JWT.
6. Per-user rate limits and an audit log (who placed/cancelled what) on order endpoints and `/api/claude`.
7. Rename `VITE_ANTHROPIC_API_KEY` → `ANTHROPIC_API_KEY`; stop the dev proxy logging credential fragments; make `/api/etrade?action=auth|callback` require a signed-in user once the flow can carry one (they are the only unauthenticated handlers left).
8. Optionally scrub the old secret and PINs from git history (BFG); only meaningful after rotation.
