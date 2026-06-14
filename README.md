# MultiWikiServer (fork: `Alternative-to-react`)

A fork of [TiddlyWiki MultiWikiServer](https://github.com/TiddlyWiki/MultiWikiServer) whose
admin UI has been rewritten from React/Material-UI to a **zero-build, server-rendered HTMX**
admin. It powers a self-hosted, multi-user family task app reached over a private Tailscale
network.

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

The initial user is `admin` / `1234` — **rotate it immediately**:

```sh
npm start reset-password admin <new-password>
```

To change the listener (host / port / TLS / `secure`), create the git-ignored
`dev/mws.dev.json`. See [`docs/operations.md`](docs/operations.md) for production deployment.

## Security

This is a self-hosted app intended for a trusted, tailnet-only audience. See
[`docs/security.md`](docs/security.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md) §9 for the
auth model (OPAQUE), CSRF defenses, cookie attributes, dependency-audit status, and the
documented FIPS position. Review it yourself before exposing it on any untrusted network.

## This is a database — make backups

Back up the **entire `store` folder** (every file there is a data file — never delete them)
plus `package.json` / `package-lock.json`. The `cache` folder is regenerated on each start and
can be excluded from backups.

## Upstream

This fork tracks [TiddlyWiki/MultiWikiServer](https://github.com/TiddlyWiki/MultiWikiServer).
The shared family task-list content and deployment tooling live in a separate `moving-house-app`
repository.
