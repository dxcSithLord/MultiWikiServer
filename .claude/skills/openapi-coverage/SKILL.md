---
name: openapi-coverage
description: Read-only validation that openapi.yaml (the MWS OpenAPI 3.1 spec at the repo root) is structurally valid AND documents every HTTP route handled by the server. Use after editing routes (packages/mws/src/managers/**, services/**) or openapi.yaml, or before committing API-doc work, to confirm every registered route — admin/{key} keys, zodRoute/defineRoute paths, session and regex routes — is represented in the spec. Lints with Spectral (oas + OWASP) and diffs handled routes (extracted from source) against documented paths with yq. Never edits files.
---

# openapi-coverage

Verifies that `openapi.yaml` at the repo root stays a faithful, valid description of the
MWS HTTP surface. It does two things and **fails on drift**:

1. **Validity** — lints `openapi.yaml` with Spectral (`spectral:oas` for OpenAPI 3.1
   structure + `@stoplight/spectral-owasp-ruleset` for the OWASP API Top-10 checks) and a
   structural `yq` guard (`openapi`/`info`/`paths` present, valid HTTP verbs).
2. **Coverage** — extracts every route *handled* by the server from
   `packages/mws/src/**` and asserts each is *documented* in `openapi.yaml`. This is the
   "confirm all handled requests are documented" guarantee, enforced programmatically.

It is **read-only**: it runs `yq`, `spectral`, and `rg`/`grep` and reports results. It
never edits, builds, or boots anything.

## When to use

- After adding/removing/renaming a route in `packages/mws/src/managers/**` or
  `packages/mws/src/services/**` (new `zodRoute`/`defineRoute`/`zodSession`, or a new
  key in `UserKeyMap`/`RecipeKeyMap`/`SettingsKeyMap`/`StatusKeyMap`).
- After editing `openapi.yaml`.
- Before committing API-documentation work.

## Prerequisites (target machine is aarch64 / `linux_arm64`)

- **mikefarah `yq` v4** — *not* the Python `yq`. Install for `linux_arm64`:
  ```bash
  curl -L -o /usr/local/bin/yq \
    https://github.com/mikefarah/yq/releases/download/v4.53.3/yq_linux_arm64
  chmod +x /usr/local/bin/yq   # use ~/.local/bin/yq if /usr/local/bin needs sudo
  yq --version                 # → mikefarah/yq … 4.53.3
  ```
- **Spectral** — `npm i -D @stoplight/spectral-cli @stoplight/spectral-owasp-ruleset`
  (the script runs it via `npx spectral`).

The script detects either tool missing and prints the exact install command, then exits
non-zero.

## How to run

```bash
bash .claude/skills/openapi-coverage/check.sh
```

The script prints lines prefixed `PASS:`, `FAIL:`, `WARN:`, `INFO:`, ends with a
`summary: N failure(s)` line, and exits non-zero if any check failed.

## What it checks

1. **Spectral lint** — `npx spectral lint openapi.yaml` (uses `.spectral.yaml`). Any
   Spectral *error* is a `FAIL`.
2. **Structural guard** — `yq` confirms `openapi`, `info`, and `paths` exist.
3. **Admin-key coverage** — extracts the keys of `UserKeyMap` / `RecipeKeyMap` /
   `SettingsKeyMap` / `StatusKeyMap` from source and asserts each appears in the
   `enum` of the `/admin/{key}` `key` path parameter in the spec.
4. **Literal-path coverage** — extracts string `path:` literals and `zodSession("…")`
   paths from `packages/mws/src/**` (skipping `__tests__`), resolves the `RECIPE_PREFIX`
   (`/recipe`) and `BAG_PREFIX` (`/bag`) constants, normalises `:param` → `{param}` and
   the trailing `/$key` → `/{key}`, and asserts each path is a key under `paths:`.
5. **Regex-route coverage** — a small fixed table maps each known regex-literal route
   (e.g. `/^\/wiki\/(.*)$/` → `/wiki/{recipe_name}`, the `/admin-htmx/*` pages, the
   `$cache` plugin route, the `/mws-docs` mount, the `/` front door) to its documented
   path and asserts presence. A new regex `path:` literal not in the table is a `WARN`
   (update the table + spec).

Exit is non-zero if any route is undocumented or Spectral reports an error.

## How to report results

Run the script, then summarise grouped by PASS / FAIL / WARN, and call out any `FAIL`
lines with the route they reference. Do **not** attempt fixes as part of this skill —
report only (update `openapi.yaml` separately if coverage fails).
