---
tags: [claude-code-prompt, etrade, broker, reconciliation]
---

# Claude Code build prompt — Fix E*TRADE portfolio value (pull from Balance API)

Work at the repo root (fdimarzio/options-tracker).

## Diagnosis (confirmed from the DB)

The portfolio value graph is driven by `portfolio_snapshots`. Its `etrade_value` column is a **hardcoded placeholder of `110558`, written unchanged for 28 straight days (2026-06-08 → today)**, with `etrade_cash` null the whole time. The real combined E*TRADE value (accounts 6917 + 8222) is ~$470k, so `total_value` has been **understated by ~$360k every day since 6/08**.

Proof the integration works: on **2026-06-22** the snapshot captured `etrade_value = 475170.15769` (correct) — the one day the balance fetch actually ran. Every other day fell back to the constant. So the E*TRADE auth/request path is functional; the snapshot writer just isn't calling it (or silently swallows the failure and writes the constant).

Do NOT patch the data. The cron rewrites the row daily; the fix must be in the snapshot generator.

## Tasks

1. **Locate the snapshot writer.** `grep -rn "110558"` and `grep -rn "portfolio_snapshots"` to find where `etrade_value` / `etrade_cash` are set. Remove the hardcoded `110558` entirely.

2. **Pull the live balance from the E*TRADE Balance API**, reusing the existing authenticated request path in `etrade.js` (the same OAuth/signing that already pulls transactions and resolved these accounts). For **each** IRA account key (6917 and 8222):
   - `GET /v1/accounts/{accountIdKey}/balance` with `instType=BROKERAGE` and `realTimeNAV=true`.
   - Read account value from `Computed.RealTimeValues.totalAccountValue` (fallback to `Computed.accountBalance` if absent) and cash from `Computed.cashBalance` / `netCash`.
   - Resolve `accountIdKey` the same way the transaction pull does (via `/v1/accounts/list`); do not hardcode the raw account numbers as keys.
   - `etrade_value` = sum of both accounts' total value; `etrade_cash` = sum of both accounts' cash.
   - **Verify field names/paths against a live response and against how `etrade.js` already parses E*TRADE JSON — do not assume.**

3. **Fail safe — never write a constant or null.** If either account's balance call fails (E*TRADE OAuth `signature_invalid` is a recurring issue): carry forward the **last known good** `etrade_value`/`etrade_cash` from the most recent snapshot, and mark the row stale (add a boolean `etrade_stale` column, default false; set true when carried forward). Log the failure. Do the same pattern for the Schwab side if it isn't already.

4. **Outlier guard.** Before writing, if `|daily_change_pct|` would exceed a threshold (default 15%), do not silently persist it — log/flag it (reuse the stale flag or a note) and prefer carry-forward, so one bad pull can't poison the graph again. Make the threshold a constant near the top of the file.

5. **Migration** (via Supabase, additive): `ALTER TABLE public.portfolio_snapshots ADD COLUMN IF NOT EXISTS etrade_stale boolean DEFAULT false;` (add `schwab_stale` too if you implement carry-forward for Schwab).

## Tests (`portfolio-snapshot.test.js`, dot notation; positive + negative)

1. Both accounts return values → `etrade_value` = correct sum, `etrade_cash` = correct sum, `etrade_stale=false`.
2. One account fails → carry-forward last good, `etrade_stale=true`, other account still summed correctly.
3. Both fail → full carry-forward, `etrade_stale=true`, no constant written.
4. Balance response missing `totalAccountValue` → falls back to `accountBalance`.
5. Outlier guard: a pull that implies `|Δ%|>15` is flagged/carried, not silently written.
6. Regression: never writes the literal `110558`.

## Non-negotiables

1. Server-side Supabase reads/writes use `SUPABASE_SVC_KEY`, never the anon key.
2. Deliver complete files, not diffs.
3. Test files use dot notation.
4. Validate before handoff: ESM check (`cp file.js /tmp/check.mjs && node --check /tmp/check.mjs`), brace balance, `npx esbuild` for any JSX. All pass.

## Definition of done

1. A fresh snapshot writes the real ~$470k E*TRADE value (validate against Frank's known figure) and real `etrade_cash`.
2. No code path can write `110558`; failures carry forward and set `etrade_stale`.
3. `portfolio-snapshot.test.js` green; three validation checks pass.

## Related

[[Accounts]] [[Reconciliation]] [[Session-Log]]
4. After deploy, today's `total_value` reflects Schwab + live E*TRADE (~$882k), and the graph is correct from that point forward. (Historical backfill of 6/08→present is a separate, later task.)
