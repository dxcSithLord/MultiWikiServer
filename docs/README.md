# Documentation map

Where everything lives, and which document is canonical for each topic. One home per topic —
do not duplicate prose across documents; link to the canonical home instead.

## Top level

| Document | Canonical for |
|---|---|
| [`../README.md`](../README.md) | Quickstart + entry-point links. |
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | **Design** — request pipeline, storage model, auth, ACL, security posture. |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | Event flow + how the server is wired together. |
| [`../openapi.yaml`](../openapi.yaml) | **API contract** — every HTTP route, with schemas (+ `.spectral.yaml`). |

## `docs/`

| Document | Canonical for |
|---|---|
| [`SDP.md`](SDP.md) | **Decisions** — engineering decisions, tooling, dependencies, standards, gaps. |
| [`security.md`](security.md) | Security standards (NIST/OWASP), CSRF/cookie model, FIPS position, threat model. |
| [`testing.md`](testing.md) | The vitest suite, headless admin smoke, and the pre-push gate. |
| [`operations.md`](operations.md) | Deployment: listener config, systemd, Tailscale Serve, backups. |
| [`TEST-PLAN.md`](TEST-PLAN.md) | Test-case inventory + gap analysis. |
| [`DOCUMENTATION-PLAN.md`](DOCUMENTATION-PLAN.md) | The documentation restructure plan (this work). |
| [`TODO.md`](TODO.md) | Consolidated parked/outstanding work. |
| [`roadmap/PLANNING.md`](roadmap/PLANNING.md) | Upstream-flavoured backlog (relocated; not this fork's plan). |

## Elsewhere in the repo

- **`archive/htmx-migration/`** — historical React→HTMX migration notes (superseded).
- **`archive/testing-bun/`** — the Bun-era test docs (superseded by [`testing.md`](testing.md)).
- **`.claude/skills/`** — `mws-cutover-check` and `openapi-coverage` guard skills.
- **`editions/mws-docs/tiddlers/`** — vendored upstream end-user wiki docs (sync from
  upstream; don't fork-edit topic-by-topic).

## Topic → home (avoid duplication)

| Topic | Canonical home |
|---|---|
| OPAQUE login flow | `ARCHITECTURE.md` §5–6 + `openapi.yaml` |
| Bag / Recipe / ACL model | `ARCHITECTURE.md` §7–8 |
| Build / run / deploy | `ARCHITECTURE.md` §10 + `docs/operations.md` |
| Test harness / how-to | `docs/testing.md` |
| CSRF + cookies | `ARCHITECTURE.md` §9 + `docs/security.md` |
| Engineering decisions / migration narrative | `docs/SDP.md` |
