# stocks_data — data ownership and write rules

**Problem this fixes:** `col_prefs` row `stocks_data` is one JSON blob. The server
(`api/market-refresh.js`, every 5 min) and every open browser tab rewrote the **whole blob** from
their own copy, so a stale tab silently reverted user settings (e.g. the auto-STO toggle) and share
counts, and every failed save was swallowed (`supabase-js` *returns* errors; the `catch {}` blocks
never fired). Fix = separate who owns what, write small, check every result, and make it visible.

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
5. **Auto-STO is explicit opt-in:** eligible ⇔ ≥ 100 shares **and** a `stock_user_settings` row with `auto_sto = true`. `false` or no row ⇒ not eligible. If the table can't be read, market-refresh **fails closed** (no orders), alerts once a day, and logs.

## Deploy order (matters)

1. Apply `sql/stocks_integrity/001_audit_col_prefs.sql` (recommended first — records who writes what).
2. Apply `002_stock_user_settings.sql`, then `003_backfill_stock_user_settings.sql`; run its verification queries.
   - Decide on the **OPTIONAL** legacy-equivalent block in 003 if you want today's effective auto-STO set preserved.
3. Optionally `004_audit_stock_user_settings.sql`.
4. **Then** merge/deploy the code. Deploying first fails safe (no auto-STO orders, banner in the UI) but is avoidable.
5. In the Stocks tab, switch auto-STO **on** for each ticker you want traded (the backfill carries over only literal `true`).

Rollback: `002_rollback_stock_user_settings.sql` (copies settings back into the blob, drops the table) together with reverting the code.

## Known gaps (deliberately not changed here)

- **Fundamentals** (52-week, P/E, yield, market cap) are fetched and saved by the UI watchlist actions; no server job writes them. They still persist, but as a patch onto the freshest copy. Moving them into market-refresh would be new functionality.
- **Other writers with the same flaw** — `contracts` (the refresh flow upserts the whole in-memory contract list), `plan_items` (delete-all then re-insert), `persist`/`persistOne`/`deleteOne`, watchlist notes/alerts, `trade_rules`, `profit_bands`, `dte_matrix` — still use unchecked `try { await … } catch {}`. The `contracts` upsert is the riskiest: a stale tab can re-open/re-price contracts the server auto-closed.
- The refresh flow still auto-saves the month-end Schwab balance to `balance_history` (a different row, re-reads before writing). Kept on purpose: it is the only automatic capture of month-end balances.
- `sql/auth/002_lockdown_rls.sql` is not applied on the live DB: the public anon key can still read/write every table. See `docs/SECRET_ROTATION.md` §4.
