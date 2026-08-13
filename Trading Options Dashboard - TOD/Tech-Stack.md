# Tech Stack

## Architecture

| Layer | Technology |
|-------|-----------|
| Frontend | React/Next.js (`src/pri-tod-v3.jsx`, ~7,500+ lines) |
| Backend | Vercel serverless functions (`api/` directory, 9 functions) |
| Database | Supabase (PostgreSQL) — project `ufagnokxmetushstgrip` |
| Cron | GitHub Actions (every 5 min market hours via `market-refresh.js`) |
| Notifications | Pushover API |
| Brokers | Schwab OAuth 2.0 + ETrade OAuth 1.0a |
| AI | Claude (SAGE scoring, chat sessions) |
| Task management | PAM → mirrored to PRI TOD via GitHub Actions every 4 hrs |

---

## Supabase Projects

| Project | ID | Purpose |
|---------|----|---------|
| PRI TOD | `ufagnokxmetushstgrip` | Main app database |
| PAM | `ghdmvzlfenpmoiyyagqw` | Task management (read-only mirror in PRI) |

---

## Vercel

- **App URL:** https://options-tracker-five.vercel.app
- **Hobby plan:** 12 serverless function limit (currently at 9), daily cron only
- All cron/background jobs run via **GitHub Actions** instead
- `vercel.json` with API rewrite rules is **required** — without it, SPA catch-all swallows all `/api/*` routes

```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

---

## Environment Variables

```bash
# Get all production keys
vercel env pull --environment=production

# Run scripts locally
node --env-file=.env.local scripts/scriptname.js
```

**Gotcha:** `vercel env pull` (no flag) only pulls development vars. Use `--environment=production`.  
**ETrade gotcha:** Vercel has `VITE_ETRADE_*`, scripts need `ETRADE_*` (no VITE_ prefix).

---

## React/DB Mapping

`pri-tod-v3.jsx` uses camelCase (`strategyGroupId`) mapped to snake_case (`strategy_group_id`) via `toApp`/`toDB` mappers at ~lines 13–100. New DB columns must be added to both mappers.

---

## Git Bash on Windows Gotchas

- Multi-line commands trigger bracket-paste mode — use `read -s VAR` first, then paste as single line
- `jq` not installed — use `python3 -m json.tool` instead
- LF → CRLF warnings are normal, ignore them

---

## Claude Code Prompt Template

Every Claude Code prompt must end with:
> "One single commit at the end: '[description]'. Do not commit after each task. Auto-approve all git operations."

Every task must include: what to build (specific, with table/column names), positive test case, negative test case.

---

## External Data Sources

| Source | Role | Used By | Auth |
|--------|------|---------|------|
| [[FMP]] (Financial Modeling Prep) | Earnings dates | `earnings-refresh.yml` → `scripts/earnings-refresh.js` → `earnings_dates` table | `FMP_API_KEY` — **GitHub Actions secret, not a Vercel env var** (script runs directly in the Action, no `/api/*` endpoint involved) |

**Caveat:** the earnings-calendar endpoint in use (`/api/v3/historical/earning_calendar/{symbol}`) is a legacy v3 FMP endpoint that has been progressively moved behind paid-tier plans — confirm the active plan still covers it before relying on this pipeline. Dashboard: https://site.financialmodelingprep.com/developer/docs/dashboard?tab=apiDetails

---

## Related

- [[Accounts]] — broker auth details
- [[Database-Schema]]
- [[Golden-Rules]]
- [[FMP]] — external earnings-date data source
