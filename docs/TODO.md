# TODO — parked work (branch `docs/sdp-and-plans`)

Outstanding items captured for later. Done items are recorded in the git history / memory.

## Documentation (see DOCUMENTATION-PLAN.md)
- [ ] Update `README.md` (remove OAuth/"dumpster fire"/`npm install`; reflect npm 10, OPAQUE, hardening).
- [ ] Update `CONTRIBUTING.md` (drop the deleted react-admin/setupDevServer description).
- [ ] Create `docs/{security,testing,operations}.md`; relocate `PLANNING.md` → `docs/roadmap/`.
- [ ] Archive the migration + Bun-era docs (`archive/htmx-migration/`, `archive/testing-bun/`).
- [ ] Fix `ARCHITECTURE.md` §9 (audit now 0) + add `secure:true` to §10; fix `openapi.yaml` externalDocs URL.
- [ ] Persist `SDP.md` as the canonical SDP once reviewed.

## Tests (see TEST-PLAN.md)
- [ ] Add ACL tests (role-grant read/write + deny) — guards the `role_ids` bug.
- [ ] Add auth/OPAQUE + cookie-Secure + logout tests; add wiki-sync HTTP round-trip tests.
- [ ] Repair or delete the broken `test-htmx-admin.mjs`.
- [ ] `vitest --coverage` baseline; reconcile the Bun-era test docs.
- [ ] **Stabilise the flaky `wiki-status.test.ts` SSE test** — it intermittently fails under
      full-suite load (e.g. `expect(sentEvents.length).toBe(0)`, a timing race), passing on
      re-run. A flaky test in the blocking pre-push gate randomly blocks pushes — fix the timing
      (deterministic fake timers / await the SSE flush) before relying on the gate.
- [ ] Optional: a fork CI job mirroring the pre-push hook.

## Security / standards (see SDP.md §6–8)
- [ ] Decide FIPS-140-3 scope (recommend: documented non-goal for this deployment) — record it.
- [ ] Threat model (`docs/security.md`); password-master-key rotation procedure; backup/retention policy.
- [ ] SBOM / transitive license scan.
- [ ] Pin a Node version of record (`.nvmrc`); reconcile engines/CI/ARCHITECTURE mismatch.

## Family task app (see the `moving-house-app` repo)
- [ ] Comments-as-discrete-tiddlers upgrade (current per-task notes tiddler is last-write-wins).
- [ ] Rotate the admin password from `1234` on the deployment (use `mws reset-password`).
- [ ] Node-share the Pi to each family member's Tailscale account + hand out their household login.

## Upstream / maintenance (see SDP.md §2.10)
- [ ] If a handler ever returns `undefined` (204 port), add client 204-handling (HTMX admin + TW syncer).
- [ ] Re-review upstream periodically (TiddlyWiki 5.4 bump not yet upstream; Hono pipeline = big/divergent).
