# TODO — parked work (branch `docs/sdp-and-plans`)

Outstanding items captured for later. Done items are recorded in the git history / memory.

## Documentation (see DOCUMENTATION-PLAN.md) — DONE
- [x] Update `README.md` (removed OAuth/"dumpster fire"/`npm install`; now npm 10, OPAQUE, hardening + doc index).
- [x] Update `CONTRIBUTING.md` (dropped the deleted react-admin/setupDevServer description → HTMX wiring).
- [x] Create `docs/{README,security,testing,operations}.md`; relocated `PLANNING.md` → `docs/roadmap/`.
- [x] Archive the migration + Bun-era docs (`archive/htmx-migration/`, `archive/testing-bun/`, each with a provenance README).
- [x] Fix `ARCHITECTURE.md` §9 (audit now 0) + added `secure:true` to §10; fixed `openapi.yaml` externalDocs URL.
- [x] Persist `SDP.md` as the canonical SDP (code-grounded review; WIP banner removed).

## Tests (see TEST-PLAN.md)
- [ ] Add ACL tests (role-grant read/write + deny) — guards the `role_ids` bug.
- [ ] Add auth/OPAQUE + cookie-Secure + logout tests; add wiki-sync HTTP round-trip tests.
- [ ] Repair or delete the broken `test-htmx-admin.mjs`.
- [ ] `vitest --coverage` baseline; reconcile the Bun-era test docs.
- [x] **Stabilise the flaky `wiki-status.test.ts` SSE test** — DONE (Alternative-to-react
      `cbd4dc5`): the `sendEvent` + `hasBag` closed-guard tests relied on a real 5ms wait beating
      a real 10ms timer (inverts under load); switched both to `vi.useFakeTimers()` +
      `advanceTimersByTimeAsync`. Verified 40/40 isolated + 5/5 full `test:unit`.
- [ ] Optional: a fork CI job mirroring the pre-push hook.

## Pre-push gate / smoke (see `dev/hooks/smoke-admin.cjs`)
Hardening notes from the smoke-admin review (the hook + smoke are sound and pass end-to-end;
these are polish, not correctness):
- [ ] Make the puppeteer-core path less fragile — it defaults to mermaid-cli's nested
      `node_modules/puppeteer-core` (breaks if mermaid-cli moves); add it as a `devDependency`
      (the `PUPPETEER_CORE_PATH` env override is the current escape hatch).
- [ ] Tighten the favicon-404 filter — it currently ignores *any* `Failed to load resource: …404`,
      which could mask a real missing asset (e.g. `styles.css`); scope it to the favicon only.
- [ ] Speed up the gate — `init-store` re-imports the full doc editions every run (~minutes,
      dominates pre-push time); cache or minimise the store init.
- [ ] Surface login failure explicitly — the `waitForFunction(...).catch()` swallows a failed
      login so it shows up as "no Users row found" rather than "login failed" (cosmetic).

## Security / standards (see SDP.md §6–8)
- [ ] Decide FIPS-140-3 scope (recommend: documented non-goal for this deployment) — record it.
- [ ] Threat model (`docs/security.md`); password-master-key rotation procedure; backup/retention policy.
- [ ] SBOM / transitive license scan.
- [ ] Pin a Node version of record (`.nvmrc`); reconcile engines/CI/ARCHITECTURE mismatch.

## Family task app (see the `moving-house-app` repo)
- [x] Comments-as-discrete-tiddlers upgrade — DONE (in `moving-house-app`): each comment is its
      own append-only `task-comment` tiddler (one MWS row each), replacing the single per-task
      notes tiddler that was last-write-wins. Dashboard shows a collapsible thread + add form;
      legacy notes shown read-only. Interactive create/sync still to be confirmed on the live Pi.
- [x] Rotate the **live deployment's** admin credential (was first initialised under the old
      fixed `1234` default) — DONE: changed via the HTMX admin web page. New installs no longer
      use `1234` — `init-store` generates a unique random password (UK PSTI alignment; see
      `docs/security.md`).
- [ ] Node-share the Pi to each family member's Tailscale account + hand out their household login.

## Upstream / maintenance (see SDP.md §2.10)
- [ ] If a handler ever returns `undefined` (204 port), add client 204-handling (HTMX admin + TW syncer).
- [ ] Re-review upstream periodically (TiddlyWiki 5.4 bump not yet upstream; Hono pipeline = big/divergent).
