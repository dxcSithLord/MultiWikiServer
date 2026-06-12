---
name: mws-cutover-check
description: Read-only verification of the React→HTMX admin cutover in this MultiWikiServer fork. Use after editing routes/admin/templates (managers/index.ts, wiki-index.ts, admin-htmx.ts, templates/) or before committing cutover work, to confirm no stray sendAdmin, exact-/ redirect loop-safety, full HTMX route↔template coverage, and React-dormant state. Runs ripgrep/grep checks only — never edits files.
---

# mws-cutover-check

Verifies the state of the gradual React → HTMX admin migration in this fork. It is
**read-only**: it runs `rg`/`grep` and filesystem checks and reports results. It does
not modify, build, or boot anything.

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

1. **No stray `sendAdmin`** — `wiki-index.ts` has no *functional* `sendAdmin` call
   (doc-comment mentions are ignored); error rendering must go through `sendWikiError`.
2. **Front-door redirect & loop-safety** — `index.ts` has the exact-root route
   (`/^\/$/`) redirecting to `/admin-htmx`, and references `/admin-htmx` at most once
   so `/login` is not redirected (which would loop).
3. **HTMX coverage** — for every admin surface (recipes, bags, users/`poc`, roles,
   plugins, settings, frame) the template file exists **and** is referenced in
   `admin-htmx.ts`.
4. **Gradual-phase state (INFO/WARN)** — whether `public/react-admin/` still exists,
   whether the React `sendAdmin(200, null)` fallback is still active, and whether the
   `client-build` step is still a no-op. These are informational during the gradual
   phase; they flip to expected-absent once the clean phase (steps 4–6) is done.

## How to report results

Run the script, then summarise the output as a short table grouped by PASS / FAIL /
WARN, and call out any `FAIL` lines explicitly with the file:line they reference.
Do **not** attempt fixes as part of this skill — report only.
