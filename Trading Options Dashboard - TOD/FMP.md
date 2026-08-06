---
tags: [landscape, data-source, vendor]
---

# FMP — Financial Modeling Prep

External data vendor. Sole role in this app: earnings-calendar dates feeding the earnings-date-awareness guard (avoid selling options that span an earnings date).

---

## Role

Earnings dates only — next/previous earnings date per symbol.

## Dashboard

https://site.financialmodelingprep.com/developer/docs/dashboard?tab=apiDetails

## Pipeline

`earnings-refresh.yml` (GitHub Actions, daily 6am ET / 10:00 UTC) → `scripts/earnings-refresh.js` → FMP earnings-calendar API → `earnings_dates` table (`symbol`, `next_earnings`, `prev_earnings`, `source`, `updated_at`).

## Auth

`FMP_API_KEY` — stored as a **GitHub Actions secret**, *not* a Vercel environment variable. The refresh script runs directly inside the Action (`node scripts/earnings-refresh.js`), not behind a Vercel `/api/*` endpoint, so there's nothing on the Vercel side that needs the key.

## ⚠️ Paid-tier caveat

`scripts/earnings-refresh.js` calls the legacy `/api/v3/historical/earning_calendar/{symbol}` endpoint. FMP has been progressively moving earnings-calendar endpoints behind paid plans — confirm the active FMP plan actually covers this endpoint before relying on this pipeline. Each symbol is fetched inside its own try/catch (`main()`, `scripts/earnings-refresh.js`) — a paid-tier rejection just logs `[symbol] failed:` and increments a `failed` counter, it does **not** fail the whole run or alert. A plan downgrade could silently degrade `earnings_dates` coverage for a while before anyone notices.

---

## Related

[[Tech-Stack]] [[Ecosystem]] [[Cron-Jobs]] — PAM task `50a7c7c5` ("Bug: Earnings Dates Refresh workflow failing — earnings_dates empty (missing FMP_API_KEY?)")
