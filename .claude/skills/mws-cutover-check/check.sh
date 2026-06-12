#!/usr/bin/env bash
#
# mws-cutover-check — read-only verification of the React -> HTMX admin cutover.
#
# Prints PASS / FAIL / WARN / INFO lines and exits 1 if any FAIL.
# This script NEVER edits files. Run it from anywhere; it locates the repo root
# relative to its own location (.claude/skills/mws-cutover-check/).
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$ROOT" || { echo "FAIL: cannot cd to repo root ($ROOT)"; exit 2; }

fails=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; fails=$((fails + 1)); }
warn() { echo "WARN: $*"; }
info() { echo "INFO: $*"; }

# Fixed-string search: ripgrep if present, else grep. Emits file:line:text.
fs() {
  local pat="$1"; shift
  if command -v rg >/dev/null 2>&1; then
    rg -nF --no-heading -e "$pat" "$@" 2>/dev/null
  else
    grep -rnF -e "$pat" "$@" 2>/dev/null
  fi
}

MGR="packages/mws/src/managers"
TPL="packages/mws/src/templates"

echo "== mws-cutover-check (root: $ROOT) =="
if command -v rg >/dev/null 2>&1; then info "using ripgrep"; else info "ripgrep not found, using grep"; fi

# --- Check 1: no functional sendAdmin left in wiki-index.ts (doc comments allowed) ---
wiki_sa="$(fs 'state.sendAdmin(' "$MGR/wiki-index.ts" | grep -vE '(^|:)[0-9]+:[[:space:]]*(\*|//|/\*)' || true)"
if [ -z "$wiki_sa" ]; then
  pass "wiki-index.ts has no functional sendAdmin call (error rendering re-homed to sendWikiError)"
else
  fail "wiki-index.ts still calls sendAdmin:"; echo "$wiki_sa" | sed 's/^/      /'
fi

# --- Check 2: front-door redirect present and loop-safe ---
if fs '/^\/$/' "$MGR/index.ts" >/dev/null; then
  pass "exact-root redirect route (/^\\/\$/) present in index.ts"
else
  fail "exact-root redirect route (/^\\/\$/) missing in index.ts — front door not pointed at HTMX"
fi
# Count redirect *targets* only (`}/admin-htmx` in a location header), not the
# `./admin-htmx` import line.
ah="$(fs '}/admin-htmx' "$MGR/index.ts" | wc -l | tr -d ' ')"
if [ "$ah" -le 1 ]; then
  pass "index.ts has ${ah} redirect target(s) to /admin-htmx — only exact / is redirected (loop-safe)"
else
  warn "index.ts has ${ah} redirect targets to /admin-htmx — confirm /login is NOT redirected (redirect-loop risk)"
fi

# --- Check 3: HTMX route <-> template coverage (every React admin surface) ---
for tpl in recipes bags poc roles plugins settings frame; do
  f="$TPL/htmx-admin-$tpl.html"
  if [ ! -f "$f" ]; then fail "missing template $f"; continue; fi
  if fs "htmx-admin-$tpl.html" "$MGR/admin-htmx.ts" >/dev/null; then
    pass "htmx-admin-$tpl.html exists and is referenced by admin-htmx.ts"
  else
    fail "htmx-admin-$tpl.html exists but is NOT referenced in admin-htmx.ts (route gap)"
  fi
done

# --- Check 4: gradual-phase state (React dormant, not yet deleted) ---
if [ -d public/react-admin ]; then
  info "public/react-admin/ still present (expected in gradual phase; delete in clean phase)"
else
  info "public/react-admin/ removed (clean phase appears done)"
fi
if fs 'sendAdmin(200, null)' "$MGR/index.ts" >/dev/null; then
  info "React fallback (sendAdmin 200) still active — /login + stragglers served by React (gradual)"
else
  warn "React fallback removed — ensure /login is served by HTMX before relying on this"
fi
if ! grep -q 'case "client-build"' scripts.mjs 2>/dev/null; then
  info "build:admin/client-build is a no-op — React is not built by the pipeline"
fi

echo "== summary: ${fails} failure(s) =="
[ "$fails" -eq 0 ] || exit 1
