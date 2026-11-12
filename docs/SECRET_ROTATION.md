# CRON_SECRET exposure — inventory and rotation plan

**Status of the code:** fixed on `main` (PR #22, `api/_lib/auth.js`). The browser no longer
holds any secret; it sends its Supabase JWT and the server verifies it against the
`app_users` allow-list. This document finishes the job: it records everywhere the old
value lived, redacts what is still tracked, and gives the rotation steps.

**Treat the old value as public.** It shipped in every browser bundle and sits in a
public repository's git history. Redacting files does not un-leak it — **only rotation does.**

## 1. Where the exposed secret was used

| Location | What it did | State |
|---|---|---|
| `src/pri-tod-v3.jsx` (12 call sites: `schwab-orders` list/cancel/order-cancel/status/reprice/chase-start/chase-stop/preview/approve, `chase-step` poll, `etrade?action=positions`, a `SECRET` const) | Browser called order endpoints directly | **Removed on `main`** — requests now carry `Authorization: Bearer <JWT>` (`src/lib/apiAuth.js`) |
| `Legacy/src/pri-tod-v3.jsx` (8 occurrences) | Dead copy of the old UI | **Redacted in this change** |
| `Session Summary/*` (3 files), `*/Product Docs/API_Consolidation_TestPlan.md` (2 files) | Docs / curl examples | **Redacted in this change** |
| Git history (many commits, e.g. `ab8e4c2`, `21bb710`, `43c8806`, `20a46c7`) | — | **Still present — rotate.** Optional scrub with BFG only *after* rotation |
| Vercel env `CRON_SECRET` | The live server-side value | **Must be changed (step 3)** |
| GitHub Actions secret `CRON_SECRET` | Used by `market-refresh.yml`, `chase-runner.yml`, `etrade-auto-auth.yml` | **Must be changed (step 3)** |
| cron-jobs.org jobs (`?secret=…` URLs) — see `Trading Options Dashboard - TOD/Cron-Jobs.md` | External scheduler | **Must be updated (step 4)** |
| Any local `.env.local`, saved `curl` commands, bookmarks (e.g. the ETrade re-auth URL) | Manual calls | Update (step 5) |

Server-side consumers (all use `authorize()` / `hasValidCronSecret()` in `api/_lib/auth.js`;
they read `process.env.CRON_SECRET`, never a literal): `market-refresh`, `chain-refresh`,
`auto-import`, `chase-step`, `oi-tracker`, `dani-simulate`, `schwab-auth`, `schwab-orders`,
`schwab-proxy`, `etrade`, `claude`.

## 2. Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `CRON_SECRET` | Vercel (Production + Preview), GitHub Actions secret | Server-to-server auth. **Fails closed** — if unset, secret auth is never accepted |
| `SUPABASE_SERVICE_KEY` | Vercel, GitHub Actions | Server DB access (already required by the auth rollout) |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Vercel build | Public by design; RLS decides what they can reach |

**Never prefix a server secret with `VITE_`** — Vite inlines every `VITE_*` variable into the browser bundle.

## 3. Rotation plan (do in this order; ~15 min; brief window where cron calls 401)

1. **Generate** a new value: `openssl rand -hex 32` (or PowerShell:
   `-join ((1..32) | % { '{0:x2}' -f (Get-Random -Max 256) })`).
2. **Confirm the new client build is the deployed one** (no secret in the bundle). Sanity check:
   open the deployed site → DevTools → Network → any `/api/…` request has an `Authorization`
   header and **no `secret=`** query param.
3. **Set the new value in both places, then redeploy Vercel** (env changes need a redeploy):
   - Vercel → Project → Settings → Environment Variables → `CRON_SECRET` (Production, Preview) → redeploy.
   - GitHub → Repo → Settings → Secrets and variables → Actions → `CRON_SECRET`.
4. **Update cron-jobs.org** jobs (market-refresh, chain-refresh, auto-import, etrade renew, etc.):
   prefer sending the header `x-cron-secret: <new value>` over `?secret=` (query strings land in access logs).
5. **Update anything local**: `.env.local`, saved curls, the ETrade re-auth bookmark.
6. **Verify rotation worked** (run from your own machine; both should print `401`):
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" "https://options-tracker-five.vercel.app/api/schwab-orders?action=list&secret=<OLD_VALUE>"
   curl -s -o /dev/null -w "%{http_code}\n" "https://options-tracker-five.vercel.app/api/etrade?action=positions&secret=<OLD_VALUE>"
   ```
   and confirm the next scheduled `market-refresh` run is green in `ecosystem_heartbeat`.
7. **Re-authorize Schwab and E*Trade** (SCH⟳ / ET⟳) if you have not since the database lockdown — the
   broker token rows live in `col_prefs`, which the public anon key could read and write until RLS is locked.

## 4. Related exposure that rotation does NOT fix

The live database still allows the public anon key to read/write every table (including
`col_prefs` with broker tokens, `trade_orders`, `signal_rules`, `contracts`). Migration
`sql/auth/001` is applied but `sql/auth/002_lockdown_rls.sql` is **not** (verified read-only against
the live policy list). Until 002 runs, rotating `CRON_SECRET` protects the API but anyone holding
the anon key from the bundle can still edit data directly. Run 002 per `docs/SECURITY_AUTH_REVIEW.md` §5.

## 5. Prevention

`tests/no-hardcoded-secrets.test.js` fails the suite if the old literal reappears anywhere in the
repo, or if `src/` contains a `secret=` query/header literal. Follow-ups (not done here): send the
secret via header in `market-refresh.yml` line 56 instead of `?secret=`; optional BFG history scrub.
