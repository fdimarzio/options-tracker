# stocks_data — data ownership and write rules

**Problem this fixes:** `col_prefs` row `stocks_data` is one JSON blob. The server
(`api/market-refresh.js`, every 5 min) and every open browser tab rewrote the **whole blob** from
their own copy, so a stale tab silently reverted user settings (e.g. the auto-STO toggle) and share
counts, and every failed save was swallowed (`supabase-js` *returns* errors; the `catch {}` blocks
never fired). Fix = separate who owns what, write small, check every result, and make it visible.

## Architecture

**Before** — every writer sends its whole in-memory copy; last writer wins; errors are dropped.

```
 Browser tab A ──┐                                              ┌─ autoSto, earningsDate, iv   (USER data)
 Browser tab B ──┼─ upsert WHOLE blob (stale copy) ─▶ col_prefs │─ shares, sharesByAcct         (SERVER data)
 Browser tab C ──┤   on every quote poll, every 1–10 min        │─ quotes, bid/ask              (SERVER data)
                 │   `try { await … } catch {}` (never fires)   └─ __cash__, fundamentals       (mixed)
 market-refresh ─┘─ read blob → merge → write WHOLE blob (unchecked, every 5 min)
 market-refresh reads autoSto from the same blob; "never set" == eligible
```
Result: any stale writer silently reverted any field, including the auto-STO flag. Nobody was told.

**After** — user data and market data are different stores with different single owners.

```
 Browser (signed-in user)                              Server (service role)
   │                                                      │
   │ one-row upsert, changed columns only                 │ read blob → merge quotes+shares → write blob
   ▼                                                      ▼   (HTTP result checked; failure → heartbeat=error → watchdog)
 stock_user_settings  ◀── READ ONLY ── market-refresh   col_prefs.stocks_data ──▶ READ ONLY ──▶ Browser (display)
 (auto_sto, earnings_date, iv_manual)   fails CLOSED     (quotes, shares; SYSTEM data)           quote polls = React state only
                                         if unreadable
 Browser's few remaining blob writes (manual cash/price/shares, watchlist fundamentals) go through
 patchStocksData: re-read freshest row → apply small mutator → compare-and-swap on updated_at → retry/throw.
 Every failure → visible banner, optimistic UI rolls back. Failed initial load → writes blocked.
 Audit trail (sql/stocks_integrity/001): col_prefs_audit records WHO (jwt_role) changed WHAT, per ticker.
```

## Concurrency guarantees → evidence (tests/stocks-data-concurrency.test.js, run against a stateful model)

| Guarantee | Mechanism | Evidence |
|---|---|---|
| Tab A cannot overwrite Tab B | settings: single-row upsert of only the changed columns; blob: CAS + re-apply | "1. Tab A cannot overwrite Tab B" (4 tests) |
| Browser cannot overwrite market-refresh | CAS on `updated_at`; mutator runs on the freshest row; quote/position flows are state-only | "2. Browser cannot overwrite market-refresh changes" (4 tests) |
| market-refresh cannot overwrite user settings | settings are a different table; the server only reads it | "3. market-refresh cannot overwrite user settings" (3 tests) + `tests/stock-user-settings.test.js` (real handler) |
| Failed loads cannot write empty blobs | `loadStocksDataChecked` → `ok:false`; writes gated on status `ready`; a patch whose read fails writes nothing | "4. Failed loads cannot write empty blobs" (3 tests) |
| Stale closures cannot revert settings | no closure state is ever sent: settings save passes the value, blob patches apply to the fresh row; UI uses functional `setState` | "5. Stale closures cannot revert settings" (3 tests) |
| Harness is capable of failing | control test reproduces the original clobber; mutation-checked (removing CAS fails 7 tests; making settings saves send all columns fails 6) | "control" block |

Residual gap: market-refresh's own read→write of the blob is not compare-and-swap (window = one HTTP round-trip). A browser
patch of a blob field (manual cash/price, fundamentals) landing inside that window would be overwritten. User settings are not
affected (different table).

## Ownership

| Data | Where it lives | Owner (only writer) | Readers |
|---|---|---|---|
| Quotes (`currentPrice, bid, ask, changePct, changeClose, lastQuoteAt`) | `col_prefs.stocks_data` | **market-refresh (server)** | UI (display), claude.js, chase-step, auto-import |
| Share counts (`shares, sharesByAcct, sharesUpdatedAt`) | `col_prefs.stocks_data` | **market-refresh (server)** | tickerUniverse, market-refresh, claude.js, UI |
| **Auto-STO opt-in** (`auto_sto`) | **`stock_user_settings`** | **signed-in user (UI)** | market-refresh (read-only), UI |
| Earnings date (display), manual IV (display) | **`stock_user_settings`** | **signed-in user (UI)** | UI |
| Fundamentals (`week52High/Low, peRatio, divYield, marketCap`) | `col_prefs.stocks_data` | UI watchlist actions *(no server writer exists yet — see Known gaps)* | UI |
| Manual overrides (`sharesSchwab, sharesEtrade, currentPrice, __cash__.*` typed by hand) | `col_prefs.stocks_data` | UI, user-initiated only | UI |
| Broker-derived display data (`avgPrice, gainLoss*, currentDayGL*`, broker cash/NAV) | React state only | — **never persisted** | UI |

Rules:

1. **market-refresh never writes `stock_user_settings`.** User settings are never inside the blob the server rewrites.
2. **The browser never writes the blob from memory.** Its only path is `patchStocksData` (`src/lib/stocksDataStore.js`): re-read the freshest row, apply a small mutator, write with compare-and-swap on `updated_at`, re-apply on conflict, throw on any failure.
3. **Quote polling and broker position pulls are React-state only** (`applyQuotesToStocksData`, `refreshEtrade`).
4. **Every write is checked.** Failures raise a visible banner; optimistic UI changes roll back; a failed *initial load* blocks all writes instead of looking like an empty DB.
5. **Auto-STO is explicit opt-in:** eligible ⇔ ≥ 100 shares **and** a `stock_user_settings` row with `auto_sto = true`. `false`, `NULL` (the column is `NOT NULL`, and the scanner rejects anything but a literal `true` regardless) or no row ⇒ not eligible. Production behavior is preserved at migration time by seeding (see Deploy order). If the table can't be read, market-refresh **fails closed** (no orders), alerts once a day, and logs.

## Deploy order (matters)

1. Apply `sql/stocks_integrity/001_audit_col_prefs.sql` (recommended first — records who writes what).
2. Apply `002_stock_user_settings.sql`, then `003_backfill_stock_user_settings.sql`; run its verification queries.
   - **003 preserves today's production behavior by default**: it seeds `auto_sto = true` for every symbol the old rule
     trades (≥ 100 shares AND `autoSto` not explicitly false) plus every explicit `true`. On 2026-11-11 that is exactly:
     AAPL, AMZN, CAT, CEG, JPM, MCD, NVDA, SPCX, TSLA, WDC. AMD (explicit false) stays off. Run the PREVIEW first; run
     verification queries (a) and (b) afterwards — both must return no rows. For strict opt-in instead, set
     `seed_legacy_eligibility := false` in 003.
   - **Run 003 while ETrade positions are populated.** Overnight ETrade's token expires and market-refresh zeroes every
     ETrade-held ticker's shares in the blob, so 003 cannot see ETrade-only names that have no explicit `autoSto`.
     `003b_seed_etrade_only_symbols.sql` exists because exactly that happened on 2026-11-12 (MCD, SPCX).
3. Optionally `004_audit_stock_user_settings.sql`.
4. **Then** merge/deploy the code. Deploying first fails safe (no auto-STO orders, banner in the UI) but is avoidable.
5. In the Stocks tab, switch AMD on if you want it (the DB holds `false`; the earlier UI toggle never persisted).

Only P0–P3 (commits `bb4abff`…`eaff2ec`) are deployable without any SQL. P4 (`57a8b73` and later) requires 002+003 first.

**Production status (2026-11-12):** `001`, `002`, `003`, `003b` and `004` are APPLIED (Supabase migrations
`stocks_integrity_001_audit_col_prefs`, `…_002_stock_user_settings`, `…_003_seed_stock_user_settings`,
`…_003b_seed_etrade_only_symbols`, `…_004_audit_stock_user_settings`). Each was first dry-run inside a rolled-back transaction.
Opted-in set = AAPL, AMZN, CAT, CEG, JPM, MCD, NVDA, SPCX, TSLA, WDC (+ OKLO, explicit true, 1 share); AMD = false.
`sql/auth/002` (RLS lockdown) and `CRON_SECRET` rotation were NOT done (declined).

Rollback: `002_rollback_stock_user_settings.sql` (copies settings back into the blob, drops the table) together with reverting the code.

## Known gaps (deliberately not changed here)

- **Fundamentals** (52-week, P/E, yield, market cap) are fetched and saved by the UI watchlist actions; no server job writes them. They still persist, but as a patch onto the freshest copy. Moving them into market-refresh would be new functionality.
- **Other writers with the same flaw** — `contracts` (the refresh flow upserts the whole in-memory contract list), `plan_items` (delete-all then re-insert), `persist`/`persistOne`/`deleteOne`, watchlist notes/alerts, `trade_rules`, `profit_bands`, `dte_matrix` — still use unchecked `try { await … } catch {}`. The `contracts` upsert is the riskiest: a stale tab can re-open/re-price contracts the server auto-closed.
- The refresh flow still auto-saves the month-end Schwab balance to `balance_history` (a different row, re-reads before writing). Kept on purpose: it is the only automatic capture of month-end balances.
- `sql/auth/002_lockdown_rls.sql` is not applied on the live DB: the public anon key can still read/write every table. See `docs/SECRET_ROTATION.md` §4.
