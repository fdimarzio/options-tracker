# Rollback

Two independent things can need rolling back: the deployed app (Vercel), and a
database change (`sql/`). They're rolled back separately — reverting a deploy
does not touch the database, and reverting a SQL change does not touch the
deploy.

## App rollback (Vercel) — under 2 minutes

Every merge to `main` auto-deploys to production
(`https://options-tracker-five.vercel.app`). To roll back to the previous
working version:

1. Go to the [Vercel dashboard](https://vercel.com) → the `options-tracker`
   project → **Deployments** tab.
2. Find the last deployment you know was good (usually the one directly above
   the current one — check the commit message/time).
3. Click the **⋯** menu on that deployment → **Promote to Production** (shown
   as **Instant Rollback** on some plans). Confirm.
4. Production now serves that build immediately — no rebuild, no redeploy
   delay.

**CLI alternative** (if you have the Vercel CLI set up locally):

```
vercel rollback [deployment-url-or-id]
# or, to just list recent deployments first:
vercel ls options-tracker
```

**Note:** this only reverts the deployed *frontend + serverless functions*. If
the bad deploy also shipped a code path that depends on a new DB object (a
new column it reads, a new table it writes to), rolling back the app alone is
enough — the DB object being unused by the older code is harmless. It's only
a problem the other direction: an OLD app build calling a DB function that a
NEWER migration changed incompatibly. If that's the situation, roll back the
SQL first (below), then the app.

## Database rollback (`sql/`) — under 5 minutes

This project has no automated migration runner — every change under `sql/`
(and especially `sql/schema/`, the source of truth for triggers/functions/RLS
— see `sql/schema/README.md`) is applied manually via the Supabase SQL
editor. Reverting means applying the inverse by hand, using git history as
the record of what "before" looked like.

1. **Find what changed.** Identify the commit that introduced the bad SQL:
   ```
   git log --oneline -- sql/
   ```
2. **For a function or trigger** (anything in `sql/schema/`): check out the
   previous version of that file and re-apply it as-is — these are all
   `CREATE OR REPLACE`, so re-running the old definition fully reverts it,
   no DROP needed.
   ```
   git show <good-commit>:sql/schema/update_contract_profit.sql
   ```
   Copy that output into the Supabase SQL editor and run it. Then commit a
   revert PR so the file in `main` matches what's actually live again (see
   `sql/schema/README.md` — the file must always match reality).
3. **For a new table/column** (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF
   NOT EXISTS`): these are additive and safe to leave in place even after
   reverting the app code that used them — nothing else reads/writes them.
   Only drop them if you specifically need the schema itself back to its
   prior shape:
   ```sql
   ALTER TABLE contracts DROP COLUMN IF EXISTS <column>;
   DROP TABLE IF EXISTS <table>;
   ```
   Run via the Supabase SQL editor. Double-check nothing else in the app
   references the column/table first (`grep -rn "<name>" api/ src/`).
4. **For an RLS policy change**: re-apply the previous `CREATE POLICY`
   statement from `sql/schema/rls_policies.sql`'s git history the same way as
   step 2.

## If you're not sure whether to roll back the app, the DB, or both

Roll back the app first — it's faster and safer (no data-shape risk). If the
symptom persists after the app rollback, the problem is in the database
layer; follow the DB rollback steps above.
