# Security

Security standards, controls, and known gaps for this fork. This is the consolidated
security home; the canonical design detail lives in [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
§9 and the decision/standards record in [`SDP.md`](SDP.md) §6–8.

## Standards posture

| Standard | Status |
|---|---|
| **NIST** | SP 800-63B-style authentication via OPAQUE (no password transmitted or stored as a recoverable hash). Session cookie is `HttpOnly` + `SameSite=Strict` + `Secure` (behind a TLS-terminating proxy with `secure=true`). **Gap:** no SP 800-53 control mapping; no documented key-rotation procedure for the password master key (`passwords.key`). |
| **OWASP** | API Top-10 ruleset wired via `.spectral.yaml`, enforced by the `openapi-coverage` skill at `--fail-severity=error`. CSRF (`X-Requested-With` + same-origin referer **host**), output escaping, and the broken-access-control + error-handling fixes (see below). **Gap:** no rate limiting (OWASP API4 is `warn`-only); no anti-CSRF token (defense-in-depth). |
| **FIPS 140-3** | **Not FIPS-validated**, and largely cannot be without major change (OPAQUE's WASM crypto, Tailscale transport, and the Pi/Debian host are not validated modules). **Recorded decision: FIPS-140-3 is a documented non-goal for this tailnet-only family app.** Do not claim FIPS compliance. See [`SDP.md`](SDP.md) §7 for the full analysis and the phased path if it ever becomes a requirement. |

> Note: the workspace standard references FIPS 140-2; 140-2 is superseded by **140-3**, which
> is the version assessed here.

## Implemented controls

- **OPAQUE authentication** — two-step handshake (`POST /login/1` → `/login/2`); the server
  never sees the plaintext password and stores no recoverable hash.
- **Session cookies** — `HttpOnly`, `SameSite=Strict`, and `Secure` when the listener runs
  with `secure=true` (`expectSecure`). See `packages/mws/src/managers/sessions.ts`.
- **CSRF** — admin APIs require the `X-Requested-With: TiddlyWiki` header (primary guard) and
  a same-origin `referer` whose **host** matches the request Host. The host check closed an
  `evil.com/admin` bypass that the earlier pathname-only check allowed; verified live behind
  `tailscale serve`. See `packages/mws/src/managers/admin-utils.ts`.
- **Authorization (ACL)** — role-based read/write on bags and recipes. A high-severity fix
  corrected `getRecipeACL`/`getBagACL` to read `roles.map(r => r.role_id)` (the code previously
  read an always-`undefined` `role_ids`, so non-admins could only reach resources they owned).
  See `packages/mws/src/RequestState.ts`.
- **Error contract** — `Streamer.catcher` honours `SendError.status`/`reason` instead of
  blanket-500ing, so an unauthorized request surfaces as `403`, not `500`.
- **Open-redirect guard** — the login `redirect` parameter accepts only same-origin
  single-slash paths.
- **Output encoding** — server-injected values in admin/login/error HTML are HTML-escaped;
  login config is passed via `data-*` attributes, never inlined into JS.
- **Headers** — Helmet defaults; a Content-Security-Policy is applied to rendered wiki routes.
- **Dependency audit** — `npm audit --omit=dev` reports **0** vulnerabilities; the pre-push
  gate enforces `npm audit --omit=dev --audit-level=high`.

## Threat model

> **Gap — starting point only.** A full STRIDE threat model with documented trust boundaries
> does not yet exist (tracked in [`SDP.md`](SDP.md) §8 and [`TODO.md`](TODO.md)). The table
> below is a seed to be completed, not an assessment of record.

| STRIDE | Surface | Current mitigation | Open |
|---|---|---|---|
| **S**poofing | Login | OPAQUE; session cookie | Brute-force throttling |
| **T**ampering | Admin/sync APIs | CSRF header + referer-host; ACL | Anti-CSRF token |
| **R**epudiation | Admin actions | Server event log | Audit-log retention policy |
| **I**nfo disclosure | Tiddler/bag reads | ACL; `Secure` cookie over TLS | At-rest encryption |
| **D**oS | All routes | Tailnet-only exposure | Rate limiting |
| **E**levation | ACL | Role-grant model; admin bypass is explicit | Control mapping (SP 800-53) |

## Operational guidance

- **Rotate the default `admin`/`1234` credential immediately** with
  `npm start reset-password admin <new-password>`.
- Keep the deployment **tailnet-only** (Tailscale Serve); do not expose it on the public
  internet without an independent review.
- Protect `passwords.key` (the password master salt) — losing or changing it invalidates all
  stored passwords.

See also: [`operations.md`](operations.md) for deployment hardening and [`testing.md`](testing.md)
for the security-relevant tests and the pre-push gate.
