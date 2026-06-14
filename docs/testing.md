# Testing

The single, current testing guide for this fork. The toolchain is **vitest** (the repo
previously carried Bun-era test docs and a `bun:test` suite that could not run — those are
archived under `archive/testing-bun/`). For the test-case inventory and gap analysis, see
[`TEST-PLAN.md`](TEST-PLAN.md).

## Running the tests

```sh
npm run test:unit     # vitest run — the unit suite (93/93 green as of the current branch)
```

> `npm test` runs an unrelated pack/install smoke (`scripts.mjs`), **not** the unit suite. Use
> `npm run test:unit`.

`vitest.config.ts` aliases the workspace `@tiddlywiki/*` packages (and the vendored
`@mjackson/multipart-parser`) to their `src/index.ts` so the suite runs unbundled, and the
test include is `packages/**/__tests__/**/*.test.ts`.

## What is covered

| Area | File | Notes |
|---|---|---|
| Cache service | `packages/mws/src/services/__tests__/cache.test.ts` | |
| Wiki state store | `packages/mws/src/managers/__tests__/WikiStateStore.test.ts` | |
| SSE handler cleanup | `packages/mws/src/managers/__tests__/wiki-status.test.ts` | Uses fake timers for the close-guard ordering tests (previously a load-dependent flake). |
| Admin CSRF | `packages/mws/src/managers/__tests__/admin-utils.test.ts` | Includes the referer-**host** check. |
| HTMX admin routes | `packages/mws/src/managers/__tests__/admin-htmx.test.ts` | Mocks `fs/promises` to fix the unbundled template path. |

## Headless admin smoke

`dev/hooks/smoke-admin.cjs` drives the built server in a real (headless Chromium via
puppeteer-core) browser to guard the admin UI bug class seen during the React→HTMX cutover
(a duplicate-global JS error that killed nav; clipped/unclickable Users-table actions). It:

- boots `dist/mws.js` against a **fresh, isolated** SQLite store in a temp dir on an
  **ephemeral loopback port** — it never touches `dev/wiki/store` or port 8080;
- sets a known `admin` password on the throwaway store via the `reset-password` CLI (since
  `init-store` now generates a unique random one), then logs in via the HTMX OPAQUE form;
- asserts no `pageerror`/`console.error`, that the ☰ and user-menu toggles work, and that a
  Users-table row is present and clickable.

Run it directly with `node dev/hooks/smoke-admin.cjs`. Override `CHROMIUM_PATH` /
`PUPPETEER_CORE_PATH` if the defaults differ on your host.

## Pre-push CI gate (opt-in)

A fail-fast `pre-push` hook (`dev/hooks/pre-push`) runs the full gate before every push.
Enable it locally after review:

```sh
git config core.hooksPath dev/hooks      # enable
git config --unset core.hooksPath        # disable
```

It runs, stopping at the first failure: `npm run build` → `npm run test:unit` →
`mws-cutover-check` skill → `openapi-coverage` skill → `npm audit --omit=dev --audit-level=high`
→ the headless admin smoke. Set `SKIP_SMOKE=1` to skip the smoke step (e.g. hosts without
Chromium).

## Gaps

The biggest outstanding test gaps (full list in [`TEST-PLAN.md`](TEST-PLAN.md)):

- **ACL tests** — highest value; guard the `role_ids` regression class.
- **Auth/OPAQUE runtime tests** + a `Secure`-cookie-behind-proxy assertion.
- **Wiki-sync HTTP round-trip** tests (tiddler PUT/GET/DELETE, write events, ETag 304).
- A `vitest run --coverage` baseline.
- Broaden the headless smoke to the other admin pages (bags/plugins/roles/settings).
- Repair or delete the broken root `test-htmx-admin.mjs`.
