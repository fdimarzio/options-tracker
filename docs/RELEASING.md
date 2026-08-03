# Releasing

This app deploys continuously — every merge to `main` ships to production via
Vercel (see `docs/ROLLBACK.md`). A "release" here doesn't trigger a deploy by
itself; it's a deliberate checkpoint that bundles whatever's landed on `main`
since the last one under a single version number, with a changelog entry and
a git tag, so there's a clear answer to "what shipped, and when" without
having to read raw commit history.

## When to cut a release

Batch it — don't tag every merge. Cut a release when a meaningful batch of
fixes/features has accumulated on `main` (a bug-fix sweep, a feature plus its
follow-ups, etc.), not after each individual PR. There's no fixed cadence;
use judgment.

## Version numbers (semver)

`package.json`'s `"version"` field, e.g. `1.0.0` → `MAJOR.MINOR.PATCH`:

- **PATCH** (`1.0.0` → `1.0.1`) — bug fixes, no behavior change to anything
  working correctly already.
- **MINOR** (`1.0.0` → `1.1.0`) — new features, additive changes (new signal
  rules, new detection paths, new UI panels) that don't change existing
  behavior for anyone not using them.
- **MAJOR** (`1.0.0` → `2.0.0`) — breaking changes: a DB column/table removed
  or repurposed, a changed API contract, a default behavior flip that
  requires action (e.g. flipping a signal_rule's `dry_run` to live by
  default).

This is a single-user/small-team internal tool, not a published package — the
version number's job is to give the changelog and rollback points something
stable to refer to, not to signal compatibility to external consumers.

## Bump-on-release steps

1. Make sure `main` is green (CI passed on every merged PR — see
   `.github/workflows/ci.yml`).
2. Decide the new version number (see semver rules above).
3. Update `CHANGELOG.md`: move the accumulated changes out of `[Unreleased]`
   (if you've been logging them there as you go) or write the entries now,
   under a new `## [X.Y.Z] - YYYY-MM-DD` heading. Keep-a-Changelog format —
   group under `Added` / `Changed` / `Fixed` / `Removed` as needed.
4. Bump `"version"` in `package.json` to match.
5. Commit both together:
   ```
   git add package.json CHANGELOG.md
   git commit -m "chore: release vX.Y.Z"
   git push origin main
   ```
6. Tag the release and push the tag:
   ```
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
7. Optional: create a GitHub Release from the tag (`gh release create vX.Y.Z
   --notes-file <(sed -n '/## \[X.Y.Z\]/,/## \[/p' CHANGELOG.md)` or just
   paste the same changelog section into the GitHub UI) — gives the tag a
   visible page and makes `git log`/GitHub's release list line up.
8. The version now shows in the app's menu footer (`v1.0.0`) after the next
   build picks up `public/version.json` — that file is regenerated from
   `package.json` at build time by `scripts/stamp-version.js`, wired into
   `npm run build`. No manual step needed beyond the version bump in step 4.

## Rolling back a release

See `docs/ROLLBACK.md` — rolling back the *deploy* is independent of the
version number; a bad release doesn't need its version "undone," just a
Vercel rollback (and, if the release included a DB change, a DB rollback per
the same doc). The changelog entry stays as a historical record either way —
add a follow-up entry noting the rollback rather than editing history.
