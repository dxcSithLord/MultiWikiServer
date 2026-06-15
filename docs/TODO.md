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
- [x] **API authentication — VERIFIED SECURED (finding 2026-06-14).** Items cannot be read
      without authentication, on- or off-host. Tested live (no session cookie): every recipe is
      `403 RECIPE_NO_READ_PERMISSION` with no content leak (`/wiki/{recipe}`, `/recipe/{recipe}/
      status`, `/recipe/{recipe}/tiddlers/{title}` — moving-house *and* the docs/mws-docs/tour
      recipes); admin + front-door routes `302`→`/login`. The anonymous-read path
      (`allowAnonReads`/`allowAnonWrites`) is **commented out** in `RequestState.ts:237-240`, so
      access is role-ACL only with no anonymous grant. **Network:** MWS binds **127.0.0.1:8080
      loopback only** (not LAN/0.0.0.0); reachable off-machine **only via Tailscale Serve
      (tailnet-only HTTPS); Funnel is OFF** (no public internet). Defense-in-depth: tailnet
      boundary + per-request role auth + CSRF (`X-Requested-With` + same-origin referer-host).
      Net: a tailnet peer (e.g. a node-shared family device) STILL needs a valid login — reach ≠ read.
- [x] **Login throttling — DONE (batch 2):** in-memory per-username rate limit/lockout on
      `POST /login/1` (`SessionManager.checkLoginRateLimit`); keyed by username (per-IP is moot
      behind the loopback proxy). Remaining: keep Funnel OFF (standing invariant), consider an
      alert if the listener ever binds non-loopback, and a general per-route rate limit (API4).
- [ ] **Access-model series (staged PRs off `Alternative-to-react`).** Confirmed decisions:
      admin content access = least privilege; audit = DB table + admin view; session timeouts =
      idle 30m / absolute 12h (SSO new-login window 30m).
  - [x] **Batch 1 — DONE (PR #17 / issue #16):** non-admin landing (`/admin-htmx` → `/wiki/{recipe}`
        or a friendly "no wikis assigned" 200 page); ACL editor UI in the Recipes/Bags edit modals
        (wired to `recipe_acl_update` / `bag_acl_update`); `user_create` auto-assigns `USER` and an
        enabled user must keep ≥1 role. Docs: `security.md` (controls + access-flow diagram),
        `operations.md` (granting access).
  - [x] **Batch 2 — least privilege (DONE):** removed the `isAdmin` content bypass in
        `getRecipeACL`/`getBagACL` (content needs an explicit ACL grant/ownership for everyone,
        admins included); initial `admin` user gets `ADMIN`+`USER` roles; soft role-count cap
        (`ROLE_SOFT_CAP = 20`). `SDP.md` §13 + `security.md` updated. **Deliberately declined**
        filtering the `index_json` admin management listing — the panel stays admin-sees-all so
        admins can still administer/grant ACLs on every recipe (content ≠ structural admin).
        - [x] Seed `USER → READ` on the four standard reference wikis (`docs`/`mws-docs`/`dev-docs`/
          `tour`) at `init-store` so fresh installs get it out of the box (idempotent, additive-only;
          reuses `REFERENCE_RECIPES`). Live store was already backfilled manually via the ACL editor.
  - [ ] **Batch 3 — `WIKI_ADMIN` tier:** gate recipe/bag create/delete behind
        `isAdmin || WIKI_ADMIN || owner` (today any logged-in user can create); document READ =
        download, WRITE = edit, WIKI_ADMIN = structure/data management.
  - [ ] **Batch 4 — audit + sessions:** `AuditLog` table + read-only admin view (`audit_list`);
        emit points across user/role/recipe/bag/login; cookie idle/absolute timeout; SSO login
        de-dup. **Update `security.md` audit/session section + `SDP.md`.**
  - [x] **Batch 5 — DONE (PR #19 / issue #18):** user home page (`/home`) listing the wikis a
        user can reach (reference wikis open in a new tab), with a working logout and a manage-wikis
        link when permitted; root dispatch by role (anon→login, admin→admin, user→/home); logout
        sets a short-lived `mws_no_sso` marker honoured before SSO so logout/persona-switch works,
        with a `/resume-sso` short-cut + login-page button. Docs: `security.md`, `operations.md`.
  - [ ] **Batch 6 — generic in-wiki home button:** inject the `🏠 MWS home` button server-side
        into served wikis (skip reference wikis); drop the hand-coded link from the moving-house-app
        seed (separate repo). Follows Batch 5.
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
