# Test plan — MWS fork

> WIP / parking doc. The pre-push hook (below) is DONE; the test *cases* and *gaps* are the
> remaining work.

## Current state

- **Unit suite runs under vitest** (`npm run test:unit`) — **93/93 green** as of `0dbae8f`.
  (It was previously dead: files imported `bun:test`, bun not installed.)
- Existing test files: `services/__tests__/cache.test.ts` (22), `managers/__tests__/`
  `WikiStateStore.test.ts` (29), `wiki-status.test.ts` (15), `admin-utils.test.ts` (12, incl. the
  CSRF host check), `admin-htmx.test.ts` (15, with an `fs/promises` mock for the unbundled
  template path). `npm test` still runs an unrelated pack/install smoke (`scripts.mjs`), NOT the units.
- `test-htmx-admin.mjs` (root) is **broken** (orphaned code after a missing `try {`; mock login) —
  fix or delete.
- **Pre-push hook DONE** (`dev/hooks/pre-push` + `dev/hooks/smoke-admin.cjs`): build → vitest →
  cutover-check → openapi-coverage → npm audit → headless admin smoke (`SKIP_SMOKE=1` escape).
  Enable with `git config core.hooksPath dev/hooks`.

## Test cases needed (grouped) + status

**Auth/OPAQUE** — login success/failure/unknown-user; `reset-password` CLI; cookie flags incl.
`Secure`-behind-proxy; logout clears cookie; expired session. → mostly **GAP** (no runtime login test).
**Authorization/ACL** (the `role_ids` regression) — non-admin in a granted role can read+write the
permitted bag/recipe, denied elsewhere; admin bypass; list endpoints return the role-granted set.
→ **GAP** (no ACL test at all — this was the unguarded bug).
**Routing/error contract** — SendError → real status (403 not 500); 404 wiki render; front-door →
`/login` (no loop); fallback redirect; Profile → Users edit. → **PARTIAL** (cutover-check is static;
admin-htmx covers profile/auth now; no end-to-end status-contract test).
**HTMX admin UI (headless)** — frame script binds dropdown + ☰ on EVERY page incl. Users; no
duplicate-global JS error; Profile→Users modal; clickable rows/unclipped Actions; responsive.
→ **NOW PARTIALLY COVERED** by `smoke-admin.cjs` (front door + Users page); broaden to all pages.
**Wiki sync** — tiddler PUT/GET/DELETE round-trip; write events; ETag 304 over HTTP. → **PARTIAL**
(store internals unit-tested; no HTTP round-trip).
**OpenAPI** — valid + every route documented. → **DONE** (`openapi-coverage` skill).

## Gaps / TODO

- Convert/repair or delete `test-htmx-admin.mjs`.
- Add ACL tests (highest value — guards the role_ids bug class).
- Add auth/OPAQUE runtime tests + cookie-Secure assertion.
- Add wiki-sync HTTP round-trip tests + write-event integration.
- Generate `vitest run --coverage` and record a baseline; reconcile/remove the Bun-era test docs.
- Decide on a fork CI job (GH Actions) mirroring the pre-push hook (the existing workflow only
  builds the upstream site).
- Broaden the headless smoke to the other admin pages (bags/plugins/roles/settings).
