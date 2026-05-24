# API Consolidation — Deploy & Test Plan
**Target: Tuesday morning before market open (8:30am ET)**

---

## What Changed

| Old files (DELETE these) | Absorbed into |
|---|---|
| `api/schwab-callback.js` | `api/schwab-auth.js` → `?action=callback` |
| `api/schwab-token-refresh.js` | `api/schwab-auth.js` → `?action=refresh` |
| `api/schwab-transactions.js` | `api/schwab-orders.js` → `?action=transactions` |

**File count: 12 → 9** (3 free slots for BRIA, MIA, etc.)

**One source code change required:**
- `src/ImportPage.jsx` line 547: change `/api/schwab-transactions?` → `/api/schwab-orders?action=transactions&`

---

## Pre-Deploy Checklist (do in this order)

### Step 1 — Update Schwab Developer Portal
The OAuth callback URL is changing. Do this BEFORE deploying.

1. Go to: https://developer.schwab.com → Your App → Edit
2. Change the **Redirect URI** from:
   - `https://options-tracker-five.vercel.app/api/schwab-callback`
   - → `https://options-tracker-five.vercel.app/api/schwab-auth?action=callback`
3. Save

### Step 2 — Update Vercel Environment Variable
1. Vercel dashboard → options-tracker → Settings → Environment Variables
2. Update `SCHWAB_CALLBACK_URL` to:
   - `https://options-tracker-five.vercel.app/api/schwab-auth?action=callback`
3. Save (no redeploy needed yet — it applies on next deploy)

### Step 3 — Update GitHub Actions / cron-job.org token keeper
Change the URL for the daily token refresh job from:
- `/api/schwab-token-refresh` → `/api/schwab-auth?action=refresh`

The `x-cron-secret` header stays the same. No other changes.

### Step 4 — Update ImportPage.jsx
In `src/ImportPage.jsx` line 547, change:
```js
// BEFORE
let schwabUrl = "/api/schwab-transactions?";

// AFTER
let schwabUrl = "/api/schwab-orders?action=transactions&";
```

---

## Deploy Steps

```bash
# 1. Drop in new files
# Copy schwab-auth.js and schwab-orders.js from outputs into api/

# 2. Delete the three old files
rm api/schwab-callback.js
rm api/schwab-token-refresh.js
rm api/schwab-transactions.js

# 3. Build check
npm run build

# 4. Deploy
git add -A
git commit -m "consolidate api: schwab-auth absorbs callback+token-refresh, schwab-orders absorbs transactions"
git push
```

---

## Post-Deploy Verification Tests

Run these in order. Stop if any step fails.

### Test 1 — Token Status (30 seconds)
Confirms auth is healthy and new routing works.
```bash
curl -s "https://options-tracker-five.vercel.app/api/schwab-auth?action=status&secret=CronSecret2026!"
```
**Expected:** `{ ok: true, accessOk: true, refreshOk: true, refreshDaysLeft: X }`

If `accessOk: false` — the access token expired during deploy. Run Test 2 immediately.

---

### Test 2 — Token Refresh (new endpoint)
```bash
curl -s "https://options-tracker-five.vercel.app/api/schwab-auth?action=refresh&secret=CronSecret2026!"
```
**Expected:** `{ ok: true, daysLeftBefore: X, accessExpiresIn: "29min", refreshReset: "7 days from now" }`

---

### Test 3 — Schwab Proxy still works (quotes)
```bash
curl -s "https://options-tracker-five.vercel.app/api/schwab-proxy?path=/marketdata/v1/quotes&symbols=AAPL&secret=CronSecret2026!" | head -c 200
```
**Expected:** JSON with AAPL quote data (bid, ask, lastPrice, etc.)

---

### Test 4 — Transactions endpoint (new routing)
```bash
curl -s "https://options-tracker-five.vercel.app/api/schwab-orders?action=transactions&days=7&secret=CronSecret2026!" | python -m json.tool | head -30
```
**Expected:** `{ transactions: [...], openContracts: [...], meta: { startDate, endDate, total, rawTotal } }`

If this returns `{ error: "Unknown action: transactions" }` — the deploy didn't pick up the new schwab-orders.js. Check Vercel deployment logs.

---

### Test 5 — Import tab in the app (UI smoke test)
1. Open https://options-tracker-five.vercel.app
2. Navigate to the **Import** tab
3. Set range to **7 days**, click **Fetch**
4. Should load Schwab + ETrade transactions same as before

---

### Test 6 — Market refresh still healthy
```bash
curl -s "https://options-tracker-five.vercel.app/api/market-refresh?secret=CronSecret2026!&action=status"
```
**Expected:** Status response with no errors. (market-refresh was not changed — this just confirms nothing broke the deploy globally)

---

### Test 7 — Schwab Orders still work (list)
```bash
curl -s "https://options-tracker-five.vercel.app/api/schwab-orders?action=list&secret=CronSecret2026!" | head -c 200
```
**Expected:** `{ ok: true, orders: [...] }`

---

## If Something Goes Wrong

### "Signature invalid" or auth error on Schwab
The Schwab Developer Portal redirect URI wasn't updated before deploy. Do Step 1 now, then re-test. The existing tokens in Supabase are still valid — no full re-auth needed unless you see `refreshOk: false`.

### Import tab shows error after deploy
Check that ImportPage.jsx was updated (Step 4). The old URL `/api/schwab-transactions` no longer exists.

### `refreshDaysLeft` is low (< 2)
Run Test 2 immediately to reset the window before Tuesday trading.

### Roll back
```bash
git revert HEAD
git push
```
Then restore the three deleted files from git history.

---

## After Verification — Confirm Vercel Function Count
Go to Vercel Dashboard → Functions. Should show **9 functions**:
1. `auto-import`
2. `chain-refresh`
3. `claude`
4. `etrade`
5. `market-refresh`
6. `oi-tracker`
7. `schwab-auth` ← new consolidated
8. `schwab-orders` ← expanded
9. `schwab-proxy`

3 free slots available for BRIA, MIA, and future use.
