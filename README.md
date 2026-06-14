# MultiWikiServer (fork: `Alternative-to-react`)

A fork of [TiddlyWiki MultiWikiServer](https://github.com/TiddlyWiki/MultiWikiServer) that keeps
the upstream purpose — **host multiple TiddlyWikis for many concurrent users** — while replacing
the React/Material-UI admin with a **zero-build, server-rendered HTMX** admin. The rewrite
**reduces dependencies, lowers the runtime resource footprint, and shrinks the supply-chain
attack surface** (no large client bundle, no client build toolchain to compromise), so MWS can
run on modest hardware with less third-party code to trust.

The change was driven by a concrete use case — a self-hosted, multi-user family task app (see
the separate [`moving-house-app`](#upstream) repo) — but the server itself stays general-purpose:
any multi-user, multi-wiki deployment.

Multiple users, multiple wikis for TiddlyWiki:

- Bag & Recipe system for storing tiddlers (per-tiddler SQLite via Prisma).
- User, Role and ACL management.
- **OPAQUE** password authentication — no password is transmitted, nor stored as a
  recoverable hash.
- HTMX admin UI — no client bundle, no build step.
- `reset-password` CLI for account recovery.
- OpenAPI 3.1 contract (`openapi.yaml`) covering the full HTTP surface.

## Documentation

| Doc | What |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Canonical design: request pipeline, storage, auth, ACL, security posture. |
| [`docs/SDP.md`](docs/SDP.md) | Software Development Plan — decisions, tooling, dependencies, standards. |
| [`docs/security.md`](docs/security.md) | Security standards (NIST/OWASP), CSRF/cookie model, FIPS position, threat-model status. |
| [`docs/testing.md`](docs/testing.md) | The vitest unit suite, headless admin smoke, and pre-push gate. |
| [`docs/operations.md`](docs/operations.md) | systemd + Tailscale Serve deployment, `secure=true`, backups. |
| [`openapi.yaml`](openapi.yaml) | OpenAPI 3.1 API contract (lint with Spectral via the `openapi-coverage` skill). |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Event flow + how the server is wired together. |

See [`docs/README.md`](docs/README.md) for the full documentation map.

## Quickstart (development)

This tree needs **npm 10+** (npm 9's Arborist crashes on the workspace peer-deps):

```sh
npx --yes npm@10 install     # install dependencies
npm run build                # compile dist/mws.js (tsup; no client bundle)
npm start init-store         # create the SQLite store + the initial admin user
npm start                    # build + listen (loopback [::1]:8080 by default)
```

`init-store` creates the `admin` user with a **unique, randomly generated password printed
once** to the console (no universal default — see [`docs/security.md`](docs/security.md) for the
UK PSTI alignment). **Record it**, then change it any time with:

```sh
npm start reset-password admin <new-password>
```

To change the listener (host / port / TLS / `secure`), create the git-ignored
`dev/mws.dev.json`. See [`docs/operations.md`](docs/operations.md) for production deployment.

## Security

A guiding goal of this fork is a **smaller, more auditable footprint** — fewer dependencies and
no client build chain mean less third-party code to trust. See [`docs/security.md`](docs/security.md)
and [`ARCHITECTURE.md`](ARCHITECTURE.md) §9 for the auth model (OPAQUE), CSRF defenses, cookie
attributes, dependency-audit status, and the documented FIPS position. As upstream notes, the
security model is still maturing — review it yourself and choose an exposure appropriate to your
deployment (the reference family deployment keeps it tailnet-only behind Tailscale).

## This is a database — make backups

Back up the **entire `store` folder** (every file there is a data file — never delete them)
plus `package.json` / `package-lock.json`. The `cache` folder is regenerated on each start and
can be excluded from backups.

## Upstream

This fork tracks [TiddlyWiki/MultiWikiServer](https://github.com/TiddlyWiki/MultiWikiServer)
(upstream: *"Multiple Users, Multiple Wikis"*) and aims to stay mergeable with it while carrying
the HTMX admin and the dependency/attack-surface reductions.

The **example use case** that drove these changes — a shared family task list — lives in a
separate `moving-house-app` repository (content + deployment tooling only); it consumes this
server but is not part of it.
