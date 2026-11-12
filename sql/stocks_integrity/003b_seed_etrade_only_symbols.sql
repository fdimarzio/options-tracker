-- 003b — Seed ETrade-only symbols that 003 could not see
--
-- STATUS: APPLIED to production on 2026-11-12 (migration "stocks_integrity_003b_seed_etrade_only_symbols").
-- Idempotent (ON CONFLICT DO NOTHING).
--
-- WHY THIS EXISTS: 003 seeds from the live stocks_data blob. Overnight, ETrade's access token
-- expires and market-refresh's ETrade positions call returns nothing; market-refresh then
-- "clears shares for tickers no longer held", so EVERY ETrade-held ticker shows shares = 0 and
-- sharesByAcct = {} until ETrade re-authorizes (observed 2026-11-12 11:30 UTC: AAPL, AMD, CEG, MCD,
-- NVDA, SPCX all at 0, Schwab holdings intact). 003 ran in that window, so it only carried over
-- ETrade names that had an EXPLICIT autoSto = true. MCD and SPCX (100 shares each, autoSto never
-- set) were eligible in production on 2026-11-11 under the old rule but invisible to 003.
-- Their eligibility on 2026-11-11 was read from the blob at 21:30 UTC, while ETrade was healthy.
--
-- LESSON for anyone re-running 003 on another environment: run it while ETrade positions are
-- populated (market hours), or check that ETrade-held tickers show shares > 0 first.

insert into public.stock_user_settings (ticker, auto_sto)
values ('MCD', true), ('SPCX', true)
on conflict (ticker) do nothing;
