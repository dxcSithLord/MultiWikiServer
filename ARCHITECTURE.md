# MWS Architecture

This document describes how this MultiWikiServer (MWS) fork works, end to end. It is
the canonical architecture reference; keep it in sync with the code.

> **Admin UI status:** the admin interface is **HTMX + server-rendered HTML only**.
> The former React/Material-UI admin has been fully removed (see *Document history*).
> Authentication uses **OPAQUE** — passwords never leave the browser in plaintext.

## 1. Overview

MWS is a multi-tenant [TiddlyWiki](https://tiddlywiki.com/) server for **hosting multiple
wikis accessed by many concurrent users** (the upstream purpose this fork preserves). Unlike a
classic single-file TiddlyWiki, MWS stores **each tiddler as its own row** in a SQLite database
(via Prisma), which makes concurrent, multi-user editing and fine-grained access control
possible. Wikis are composed from reusable **bags** of tiddlers through **recipes**, and
access is governed by role-based **ACLs**.

The server is a small, event-driven HTTP router written in TypeScript (ESM, Node 20+).
Its admin surface is rendered server-side as HTML and progressively enhanced with HTMX —
no client build step, no SPA bundle. This fork's defining change is that HTMX admin: it
**reduces dependencies and the runtime footprint and shrinks the supply-chain attack surface**
versus the upstream React/Material-UI admin. The work was driven by a concrete example use case
(a self-hosted family task app — see the `moving-house-app` repo) without specialising the
server to it.

## 2. High-level architecture

```mermaid
graph TD
  Browser["Browser<br/>(HTMX admin + wiki client)"]
  subgraph Server["MWS server (Node, ESM)"]
    Helmet["Helmet middleware"]
    Router["Router<br/>(first-match routes)"]
    subgraph Managers["Managers (route handlers)"]
      Htmx["HtmxAdminManager<br/>/admin-htmx, /login, opaque.js"]
      AdminApi["Admin/Recipe/User APIs<br/>/admin/*"]
      Sessions["SessionManager<br/>/login/1, /login/2, /logout"]
      Wiki["Wiki routes<br/>/wiki/*, /recipes/*"]
    end
    Prisma["Prisma client"]
    Plugins["Plugin cache"]
  end
  SQLite[("SQLite store<br/>(per-tiddler rows)")]

  Browser -->|HTTP| Helmet --> Router --> Managers
  Htmx --> Prisma
  AdminApi --> Prisma
  Sessions --> Prisma
  Wiki --> Prisma
  Wiki --> Plugins
  Prisma --> SQLite
```

## 3. Package structure

The repo is an npm workspace monorepo. The server bundle (`@tiddlywiki/mws`) is compiled
from `packages/mws` and depends on the supporting packages.

| Workspace | Role |
|---|---|
| `packages/events` | Tiny typed event emitter (`serverEvents`) used to wire everything together. |
| `packages/commander` | CLI command framework (the `mws` binary: `init-store`, `listen`, …). |
| `packages/server` | HTTP primitives: `Router`, `Streamer`/`ServerRequest`, route matching, `sendBuffer`/`sendStream`/`sendFile`, `STREAM_ENDED`, `dist_resolve`. |
| `packages/mws` | The application: managers (routes), services (sessions, cache), Prisma access, HTMX admin, templates, styles. |
| `packages/tiddlywiki-types` | Type declarations for TiddlyWiki. |
| `packages/utils` | Shared utilities. |
| `packages/multipart-parser` | Streaming multipart/form-data parser for uploads. |
| `prisma/client` | Generated Prisma client (`@tiddlywiki/mws-prisma`). |

The build is a single `tsup` step producing `dist/mws.js` (+ a stub `dist/mws.d.ts`).
There is **no client/admin build** — the admin UI is plain HTML/CSS/JS served at runtime.

## 4. Request processing pipeline

The server is wired through `serverEvents`. On listener init
(`packages/mws/src/registerRequest.ts`), routes are registered by emitting three events
**in order**, and the router resolves the **first matching** route:

```mermaid
graph LR
  important["mws.routes.important<br/>(highest priority)"] --> routes["mws.routes<br/>(normal: admin, HTMX, /login,<br/>exact-root redirect)"] --> fallback["mws.routes.fallback<br/>(catch-all GET)"]
```

- **`mws.routes.important`** — routes that must win (e.g. status endpoints).
- **`mws.routes`** — the bulk: admin/recipe/user APIs, the HTMX admin
  (`HtmxAdminManager`), the HTMX `/login` page, and the exact-root (`/^\/$/`) redirect to
  `/admin-htmx`. Because these are registered before the fallback, they match first.
- **`mws.routes.fallback`** — a catch-all `GET /^\/.*/` that **302-redirects any unmatched
  path to `/admin-htmx`** (which itself gates auth). This replaced the old React SPA
  fallback; the server no longer serves a SPA shell.

Each request is wrapped in a `ServerRequest`/`StateObject` exposing helpers such as
`sendBuffer`, `sendEmpty`, `sendFile`, `queryParams`, `pathPrefix`, `user`, and the
Prisma transaction runner. Handlers signal completion by returning/throwing the
`STREAM_ENDED` symbol.

Errors from wiki rendering are rendered by `sendWikiError`
(`packages/mws/src/managers/wiki-index.ts`) as a minimal, fully HTML-escaped error page —
no admin/SPA dependency.

## 5. The admin front door (HTMX + OPAQUE)

Every named surface has its own route; the front door is React-free:

```mermaid
sequenceDiagram
  participant B as Browser
  participant S as Server
  B->>S: GET /
  S-->>B: 302 → /admin-htmx
  B->>S: GET /admin-htmx (no session)
  S-->>B: 302 → /login?redirect=/admin-htmx
  B->>S: GET /login
  S-->>B: 200 htmx-login.html
  B->>S: GET /admin-htmx/opaque.js
  S-->>B: 200 self-hosted OPAQUE client (WASM inlined)
  Note over B: opaque.client.startLogin(password)
  B->>S: POST /login/1 {username, startLoginRequest}
  S-->>B: {loginResponse, loginSession}
  Note over B: opaque.client.finishLogin(...)
  B->>S: POST /login/2 {finishLoginRequest, loginSession}
  S-->>B: Set-Cookie session (HttpOnly, SameSite=Strict) + {user_id}
  B->>S: GET /admin-htmx (with cookie)
  S-->>B: 200 HTMX admin
```

`HtmxAdminManager` (`packages/mws/src/managers/admin-htmx.ts`) serves:

- **`GET /login`** — the HTMX login page (`templates/htmx-login.html`). Config
  (path prefix, validated redirect) is injected only as **HTML-escaped `data-*` attributes**;
  the page script reads them as plain strings, so no untrusted value is ever placed in
  executable JavaScript. The post-login `redirect` target is validated against open
  redirects (same-origin single-slash paths only).
- **`GET /admin-htmx/opaque.js`** — the `@serenity-kit/opaque` ESM client, served from
  `node_modules` (WASM inlined, ETag-cached). Self-hosted so the login page needs **no CDN**
  and works **offline**.
- **`GET /admin-htmx/styles.css`** — the admin stylesheet (`styles/admin-htmx.css`), ETag-cached.
- **`GET /admin-htmx[...]`** — the admin pages, each from a template in
  `packages/mws/src/templates/`: `recipes`, `bags`, users (`poc`), `roles`, `plugins`,
  `settings`, `audit`, wrapped by the shared `htmx-admin-frame.html`. Unauthenticated requests
  are redirected to `/login`. A logged-in **non-admin** is sent to their user home page
  (`/home`) rather than a dead-end 403; the **Recipes** and **Bags** pages additionally admit
  the **`WIKI_ADMIN`** role. The frame is always rendered with the real `isAdmin`, so the
  admin-only sections (Users / Roles / Settings / Audit) stay hidden and remain `isAdmin`-gated
  at the API even for a WIKI_ADMIN.

Read/write actions call the JSON admin APIs (`POST /admin/$key`,
`packages/mws/src/managers/admin-utils.ts`), which require an `X-Requested-With` header and
a same-origin `referer` (CSRF defenses).

## 6. Authentication & sessions

Authentication uses the **OPAQUE** asymmetric PAKE (`@serenity-kit/opaque`,
`packages/mws/src/services/sessions.ts`):

- The user's `password` column stores an OPAQUE **registration record**, not a password
  hash that the server can test offline.
- Login is a two-message handshake (`/login/1`, `/login/2`). The plaintext password never
  leaves the browser; the server learns only that the client proved knowledge of it.
  `/login/1` is **rate-limited** per username (in-memory throttle + lockout), and a successful
  login writes `last_login`.
- On success the server creates a `Sessions` row and sets a **session cookie** that is
  `HttpOnly`, `SameSite=Strict`, `Secure` when the connection is secure, and whose `expires`
  is set to the absolute session cap.
- **Session lifecycle:** sessions expire on **idle (30 min)** and an **absolute cap (12 h)**,
  enforced server-side in `parseIncomingRequest` — an expired row is deleted and the request
  becomes anonymous (re-authentication required). `last_accessed` is refreshed on use but
  throttled (≤ once/min) to avoid write amplification.
- On every request, `SessionManager.parseIncomingRequest` resolves the cookie (applying the
  expiry/refresh above) to the current user (or anonymous) and attaches it as `state.user`.
- **Tailscale SSO (optional, off by default):** with `MWS_TAILSCALE_SSO=1`, a
  `Tailscale-User-Login` header injected by Tailscale Serve is mapped to a user's
  `tailscale_login` and authenticated **passwordlessly, per request** (no session row;
  deny-unless-mapped). Logout sets a short-lived `mws_no_sso` marker so it sticks under SSO.
  Safe only behind a loopback bind + Tailscale Serve + Funnel-off — see `docs/security.md`.

## 7. Storage model — bags, recipes, tiddlers

Persistence is SQLite through Prisma (`prisma/schema.prisma`; SQLite init in
`packages/mws/src/db/sqlite-adapter.ts`). Each tiddler and each of its fields is a row.

```mermaid
erDiagram
  Recipes ||--o{ Recipe_bags : composes
  Bags    ||--o{ Recipe_bags : "included in"
  Bags    ||--o{ Tiddlers : holds
  Tiddlers ||--o{ Fields : has
  Recipes ||--o{ RecipeAcl : "ACL"
  Bags    ||--o{ BagAcl : "ACL"
  Users   }o--o{ Roles : "has"
  Users   ||--o{ Sessions : "has"
  Roles   ||--o{ RecipeAcl : "grants"
  Roles   ||--o{ BagAcl : "grants"
  AuditLog {
    int id
    datetime created_at
    string actor_label
    string action
    string outcome
  }
```

> `AuditLog` is a standalone, **append-only** table with no foreign keys — the actor is recorded
> as an id + label rather than a relation, so trimming users never cascades to the trail.

- **Bag** — a named collection of tiddlers (the unit of storage and ACL).
- **Recipe** — an **ordered** list of bags (`Recipe_bags.position`). Reading a recipe
  overlays its bags in order; the last bag wins for a given title. Recipes are how a
  composed wiki is assembled and served.
- **Tiddlers / Fields** — per-tiddler rows (`@@unique([bag_id, title])`), with arbitrary
  fields as child rows; `is_deleted` supports tombstones for sync.
- **Users / Roles / Sessions** — accounts, role membership, and active sessions.
- **Settings** — server key/value settings.
- **AuditLog** — append-only trail of administrative, structural, and authentication events
  (no FK; actor stored as id + label). Append-only is enforced in the database by `BEFORE
  UPDATE`/`BEFORE DELETE` triggers (WORM; NIST SP 800-53 AU-9). See `docs/security.md` §audit.

## 8. Authorization (ACL)

Access is **role-based**. `RecipeAcl` and `BagAcl` rows attach a `Permission`
(hierarchical `READ` < `WRITE` < `ADMIN`) to a `role_id`. A request's effective permissions
are the union of its user's roles' grants.

**Least privilege:** holding the `ADMIN` role does **not** bypass content ACLs — admins reach a
wiki's tiddler content only via a role grant or ownership, exactly like any other user (the
former `isAdmin` content bypass in `getRecipeACL`/`getBagACL` was removed). Admins retain
*structural* administration through the admin panel (which stays admin-sees-all so they can
manage and grant ACLs on every resource). A separate **`WIKI_ADMIN`** role is the
data-management tier: it may create and delete recipes and bags without being a full site-admin,
but gains no content-ACL bypass or owner reassignment. So the tiers are
**READ** (download) < **WRITE** (server-side edit) < **`WIKI_ADMIN`** (structure) <
**`ADMIN`** (system administration).

Recipe reads can optionally enforce the contained bags' ACLs (`Recipe_bags.with_acl`). Helpers
such as `getBagWhereACL` build the Prisma `where` clauses that filter bags/recipes to what the
caller may see. See `docs/security.md` for the full model.

## 9. Security posture

Aligned with the workspace standards (NIST/OWASP, defensive coding):

- **OPAQUE auth** — no plaintext password transmission; no server-side password hash to
  exfiltrate.
- **Session cookies** — `HttpOnly`, `SameSite=Strict`, `Secure` on secure transports.
- **Session lifecycle** — idle (30 min) + absolute (12 h) expiry enforced server-side; throttled
  `last_accessed`; `last_login` recorded.
- **Login rate-limiting** — per-username throttle + lockout on `/login/1` (in-memory, bounded).
- **Content least privilege** — `ADMIN` membership does not bypass content ACLs; structure is
  gated to the `WIKI_ADMIN` tier (admins/owners), so role/ownership governs all content access.
- **Audit logging (WORM)** — administrative, structural, and authentication events are written to
  an **append-only** `audit_log` (DB triggers abort `UPDATE`/`DELETE`; NIST SP 800-53 AU-9),
  with a read-only admin view at `/admin-htmx/audit`. Secrets are redacted at the sink.
- **Tailscale SSO (optional)** — opt-in passwordless identity-header auth, safe only behind a
  loopback bind + Tailscale Serve + Funnel-off.
- **CSRF** — admin APIs require `X-Requested-With` plus a same-origin `referer`.
- **Open-redirect guard** — the login `redirect` parameter accepts only same-origin
  single-slash paths.
- **Output encoding** — all server-injected values in admin/login/error HTML are
  HTML-escaped; login config is passed via `data-*` attributes, never into inline JS.
- **Headers** — Helmet (`referrer-policy: strict-origin-when-cross-origin`, etc.); a
  Content-Security-Policy is applied to rendered wiki routes (`WikiStateStore.ts`).
- **Dependency audit** — `npm audit --omit=dev` reports **0** vulnerabilities. The
  high/critical advisories were all dev-only (vitest/vite/rollup/postcss); the one
  production finding (`uuid`) is unreachable as used. The pre-push hook enforces
  `npm audit --omit=dev --audit-level=high`.

## 10. Build, run & deploy

```bash
# Install (this tree needs npm 10+; npm 9's Arborist crashes on the workspace peer-deps)
npx --yes npm@10 install

# Build → dist/mws.js (+ stub dist/mws.d.ts type)
npm run build

# Initialise the SQLite store (creates admin user, applies migrations, imports defaults)
npm start init-store

# Run (binds IPv6 loopback [::1]:8080 by default; http, no path prefix)
npm start
```

To change the listener (host/port/prefix/TLS), create the git-ignored
`dev/mws.dev.json` (an array of listen args). `npm start` sets `ENABLE_DEV_SERVER=mws`,
which now only gates non-admin development behaviour (wiki tiddler serving, cache); it no
longer builds any client bundle.

For a self-hosted family/household deployment (e.g. Raspberry Pi behind Tailscale), pin the
listener host explicitly and front it with Tailscale Serve for in-tailnet HTTPS. Behind a
TLS-terminating proxy, set `secure=true` on the listener (in `dev/mws.dev.json`) so the
session cookie carries the `Secure` attribute even though MWS itself speaks plain HTTP to the
proxy. See `docs/operations.md` for the full deployment runbook.

## Document history

- The admin UI was migrated from React/Material-UI to HTMX in a phased cutover
  (front-door redirect → inline error responder → HTMX login with self-hosted OPAQUE →
  fallback repoint → deletion of `packages/react-admin` and `public/react-admin/` →
  build/skill cleanup). The `mws-cutover-check` skill guards against regression.
- Historical notes from the migration are archived under `archive/htmx-migration/`
  (`HTMX_ADMIN_POC.md`, `HTMX_SECURITY_FIXES.md`, `admin-refactor.md`) and the Bun-era test
  docs under `archive/testing-bun/` — all superseded by this document, `docs/testing.md`, and
  `docs/security.md`.
