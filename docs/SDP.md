# Software Development Plan — MWS fork (`Alternative-to-react`)

> Canonical Software Development Plan for this fork. Records the engineering decisions,
> tooling, dependencies, standards and outstanding gaps. Drawn from the branch history
> (`git log 6e32c46..`) and verified against the codebase as of `0dbae8f`.

## 1. Context & scope

A multi-user TiddlyWiki MultiWikiServer fork whose admin UI was rewritten from React to
HTMX, deployed as a self-hosted family task app (see the `moving-house-app` repo). Per-tiddler
SQLite storage, OPAQUE auth, bag/recipe/role ACL, reached over Tailscale.

## 2. Key engineering decisions (this branch)

1. **React → HTMX admin cutover (phased, with a regression guard).** Eliminated the
   React/Material-UI SPA for a server-rendered, build-free HTMX admin (~20KB vs ~500KB, no
   client build, offline-friendly — aligns with "Simplicity First"). Steps: front-door
   redirect → inline error responder → HTMX login (self-hosted OPAQUE WASM) → fallback
   repoint → delete `packages/react-admin` + `public/react-admin/` → drop dead build steps →
   canonical `ARCHITECTURE.md`. Guarded by the `mws-cutover-check` skill.
2. **Role-based ACL bug fix.** `getRecipeACL`/`getBagACL` read `this.user.role_ids`, which was
   always `undefined` (`AuthUser` exposes `roles`), so non-admins could only reach resources
   they *owned*. Fixed to `roles.map(r => r.role_id)`. High-severity authz correctness fix.
3. **`SendError` 500→403.** `Streamer.catcher` blanket-500'd everything, masking intended
   statuses (an unauthorized PUT surfaced as 500). Now honours `SendError.status`/`reason`.
4. **CSRF hardening.** `admin()` now requires the referer **host** to equal the request Host
   (was pathname-only — `evil.com/admin` passed). Verified live behind `tailscale serve`.
5. **Security pass.** `npm audit` 9→0; analysis showed all high/critical were dev-only
   (vitest/vite/rollup/postcss/picomatch); only prod finding was `uuid` (unreachable as used).
6. **OpenAPI 3.1 + Spectral/OWASP + coverage skill.** Full HTTP surface documented; Spectral
   `oas` + OWASP API Top-10 (conflicting rules down-ranked with rationale); `openapi-coverage`
   skill diffs handled routes vs documented paths.
7. **`reset-password` CLI command.** Closes a lockout gap (no way to reset a forgotten password
   without an authed admin session).
8. **Mobile/UX fixes.** Responsive accordion sidebar; viewport-safe dropdown; Profile →
   Users-edit redirect; clickable user rows; **the duplicate-`const pathPrefix` bug** that
   aborted the frame script on the Users page → frame script wrapped in an IIFE.
9. **Cookie `Secure` behind proxy.** The fork already supports it via the listener `secure=true`
   flag (`expectSecure` → cookie `Secure`); enabled in `dev/mws.dev.json` for the tailscale-serve
   deploy. (Equivalent of upstream's later-renamed `assumeHTTPS`.)
10. **Upstream ports.** 204-on-empty (`05b7b3c`, currently inert) and sendFile error handling +
    HTTP/2 exit cleanup (`9aaf50f`). Reviewed-and-skipped: write-events fix (already present),
    dataBuffer (not needed), syncer.js (would break SSE), named-capture routing (high cost/low
    value, conflicts).

## 3. Tools & skills

**Created in this fork:** `.claude/skills/mws-cutover-check` (React-removal regression guard),
`.claude/skills/openapi-coverage` (Spectral + `yq` route-coverage), the `reset-password` CLI
command, and the opt-in `dev/hooks/pre-push` CI gate (+ `smoke-admin.cjs` headless guard).
**Machine-level skill:** `~/.claude/skills/mermaid-test`.
**Used:** Spectral (`@stoplight/spectral-cli` + `-owasp-ruleset`), mikefarah `yq` v4.53.3,
puppeteer-core + chromium (headless tests), `tailscale serve`, tsup/esbuild, vitest, Prisma.

## 4. Build / run / deploy

- Install: `npx --yes npm@10 install` (npm 9 Arborist crashes on the workspace peer-deps).
- Build: `npm run build` (tsup → `dist/mws.js`); no client bundle.
- Init: `npm start init-store` (admin/1234; **rotate it** — use `mws reset-password`).
- Run: `npm start` → binds loopback; override via gitignored `dev/mws.dev.json`
  (`secure=true` behind a TLS-terminating proxy).
- Deploy: Raspberry Pi 400 (aarch64) + `tailscale serve` (in-tailnet HTTPS); systemd service.
  See `DEPLOY-PI.md` (in the `moving-house-app` repo).
- Pre-push gate: `dev/hooks/pre-push` (enable with `git config core.hooksPath dev/hooks`).

## 5. Dependencies (direct, exact versions — from each package.json)

**root** deps: `@prisma/adapter-better-sqlite3 6.10.1`, `@serenity-kit/opaque ^0.8.4`,
`prisma-client file:prisma/client`, `rxjs ^7.8.2`, `source-map-support ^0.5.21`,
`tiddlywiki ^5.3.2`. devDeps: `@prisma/client 6.10.1`, `@stoplight/spectral-cli ^6.16.0`,
`@stoplight/spectral-owasp-ruleset ^2.0.1`, `@types/node ^24.6.0`, `prettier ^3.6.1`,
`prisma 6.10.1`, `prisma-json-types-generator 3.5.0`, `tsup ^8.5.0`, `typescript ^5.8.3`,
`vitest ^3.2.4`.
**packages/mws** devDeps: `@types/better-sqlite3 ^7.6.13`, `@types/debug ^4.1.12`, `debug ^4.4.1`,
`esbuild 0.25.2`, `helmet ~8.1.0`, `supports-color ^10.0.0`, `tiddlywiki ^5.1.22`,
`try ^1.0.0-beta.5`, `uuid ^11.1.0`, `zod-to-ts ^1.2.0`.
**packages/server** deps: `bytes ^3.1.2`, `compressible ^2.0.18`, `compression ^1.8.0`,
`debug ^4.4.1`, `mime-types ^2.1.35`, `negotiator ^1.0.0`, `rxjs ^7.8.2`, `send ^1.2.0`,
`supports-color ^10.0.0`, `try ^1.0.0-beta.5`, `uuid ^11.1.0`, `vary ^1.1.2`, `zod ^3.25.49`,
`zod-validation-error ^3.4.1` (+ `@types/*`).
**packages/commander** deps: `commander 13.1.0`, `chalk ^5.4.1`.
**packages/multipart-parser** (vendored, MIT) deps: `@remix-run/headers ^0.12.0`.
events/utils/tiddlywiki-types: no runtime deps.
**packages/create-package** (`@tiddlywiki/create-mws`): no `dependencies` block; the scaffolded
`files/package.json` (`@tiddlywiki/mws-instance`) likewise declares no deps — only a
`start: "mws listen --listener"` script. The generated Prisma client (`prisma/client`,
published as `@tiddlywiki/mws-prisma`) is a build artifact, not a hand-managed dependency, and
is referenced from root deps as `prisma-client file:prisma/client`.

## 6. Standards

- **NIST**: SP 800-63B-style auth via OPAQUE (no password transmitted/stored as a testable
  hash); session cookie `HttpOnly` + `SameSite=Strict` + `Secure` (when `expectSecure`).
  GAP: no SP 800-53 control mapping; no key-rotation procedure for the password master key.
- **OWASP**: API Top-10 wired via `.spectral.yaml`, enforced by `openapi-coverage` at
  `--fail-severity=error`; CSRF (`X-Requested-With` + same-origin referer host), output
  escaping, the broken-access-control + error-handling fixes above. GAP: no rate limiting
  (api4 is `warn`-only); no CSRF token (defense-in-depth).
- **FIPS 140-3** (uplifted from the workspace's "140-2" — 140-2 is superseded): the stack is
  **NOT FIPS-validated** and largely can't be without major change. See the dedicated path in
  §7. Do **not** claim FIPS compliance.

## 7. FIPS-140-3 adherence path (future workstream — analysis only)

FIPS validates cryptographic *modules*; adherence = use CMVP-validated modules in approved mode
with only approved algorithms. Blocking realities:
- **OPAQUE (`@serenity-kit/opaque`)** ships its own WASM crypto (Ristretto255/OPRF/Argon2) —
  none FIPS-approved, and there is no validated aPAKE. True FIPS auth means abandoning OPAQUE
  (e.g. PBKDF2-over-FIPS-TLS), losing its zero-knowledge property.
- **Tailscale** transport (Curve25519/ChaCha20) isn't FIPS-validated; `tailscale serve` TLS
  isn't a FIPS module.
- The **Pi 400 + Debian** likely can't host a CMVP-validated OpenSSL FIPS provider (Ubuntu
  Pro/RHEL are the validated platforms; aarch64 coverage must be verified).
Phased path: (0) decide scope + record decision; (1) crypto inventory (no guessing — audit
`node:crypto` use, the session signature, RNG); (2) FIPS-mode OS + Node on a validated OpenSSL
FIPS provider; (3) FIPS-validated TLS termination instead of tailscale serve; (4) replace
OPAQUE; (5) FIPS-validated at-rest encryption if in scope; (6) evidence (CMVP cert refs) +
maintenance. **Defensible decision: record FIPS-140-3 as a non-goal for this tailnet-only
family app**; phases 0–1 are the no-regret first steps if it ever becomes required.

## 8. Gaps (no guessing — items needing evidence/decisions)

- Threat model (STRIDE/trust boundaries) — none exists.
- Test coverage % — no report generated (see TEST-PLAN.md).
- SBOM / transitive license inventory — only direct/root LICENSE (BSD-3-Clause) + vendored MIT confirmed.
- FIPS-validated crypto module status — unknown/absent (see §7).
- Data-retention / backup policy + password-master-key rotation — undocumented.
- CI/CD for the fork — the existing GH workflow only builds the upstream site; the pre-push hook
  is the only gate (consider a fork CI job).
- Node version of record — root `engines.node >=18` (the only `engines` field in the workspace;
  no per-package or `create-package` constraint) vs ARCHITECTURE "20+" vs upstream CI "23"; no `.nvmrc`.
- The 204-port latent contract caveat (client 204-handling) if a handler ever returns `undefined`.
