---
name: mws-cutover-check
description: Read-only verification that the React→HTMX admin cutover in this MultiWikiServer fork stays complete. Use after editing routes/admin/templates (managers/index.ts, wiki-index.ts, admin-htmx.ts, templates/) or before committing, to confirm no stray sendAdmin, the front-door redirect + a served /login (loop-safe), HTMX login plumbing (template + self-hosted OPAQUE), full HTMX route↔template coverage, and that React stays fully removed (regression guard). Runs ripgrep/grep checks only — never edits files.
---

# mws-cutover-check

Verifies that the React → HTMX admin cutover in this fork is complete and stays that
way. The migration (steps 1-6) is done: the admin UI is HTMX-only and React is deleted.
This script asserts that end state and **fails on regression**. It is **read-only**: it
runs `rg`/`grep` and filesystem checks and reports results. It does not modify, build,
or boot anything.

## When to use

- After editing `packages/mws/src/managers/{index,wiki-index,admin-htmx}.ts` or any
  `packages/mws/src/templates/htmx-admin-*.html`.
- Before committing cutover work, to catch regressions.
- When asked to "check the cutover state" / "verify the React removal".

## How to run

From the repo root (or anywhere — the script finds the root itself):

```bash
bash .claude/skills/mws-cutover-check/check.sh
```

The script prints lines prefixed `PASS:`, `FAIL:`, `WARN:`, `INFO:`, ends with a
`summary: N failure(s)` line, and exits non-zero if any check failed.

## What it checks

1. **No stray `sendAdmin`** — `index.ts` and `wiki-index.ts` have no *functional*
   `sendAdmin` call (doc-comment mentions ignored); errors go through `sendWikiError`
   and the fallback redirects instead.
2. **Front-door redirect** — `index.ts` has the exact-root route (`/^\/$/`)
   redirecting to `/admin-htmx`.
3. **Loop-safety** — the redirect destination `/login` is *served* by its own HTMX
   route (`/^\/login$/` in `admin-htmx.ts`), so the front-door redirects terminate.
4. **HTMX login plumbing** — `htmx-login.html` exists and is referenced, and the
   self-hosted OPAQUE client route (`opaque.js`) is present.
5. **HTMX coverage** — for every admin surface (recipes, bags, users/`poc`, roles,
   plugins, settings, frame) the template exists **and** is referenced in `admin-htmx.ts`.
6. **React fully removed (regression guard)** — `public/react-admin/` and
   `packages/react-admin/` are gone, `setupDevServer.ts` is gone, no `react-admin`
   references remain in `package.json`/`tsconfig.base.json`, and the frame nav has no
   "Switch to React Admin" link. Any reappearance is a **FAIL**.

## How to report results

Run the script, then summarise the output as a short table grouped by PASS / FAIL /
WARN, and call out any `FAIL` lines explicitly with the file:line they reference.
Do **not** attempt fixes as part of this skill — report only.
