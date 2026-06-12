#!/usr/bin/env bash
#
# mws-cutover-check — read-only verification of the React -> HTMX admin cutover.
#
# The cutover is COMPLETE (steps 1-6): the admin UI is HTMX-only and React has
# been deleted. This script asserts that end state and guards against regression
# (any reappearance of React / sendAdmin plumbing is now a FAIL).
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

# Comment-line filter: drop matches whose line is a *, //, or /* comment.
not_comment() { grep -vE '(^|:)[0-9]+:[[:space:]]*(\*|//|/\*)'; }

MGR="packages/mws/src/managers"
SVC="packages/mws/src/services"
TPL="packages/mws/src/templates"

echo "== mws-cutover-check (root: $ROOT) =="
if command -v rg >/dev/null 2>&1; then info "using ripgrep"; else info "ripgrep not found, using grep"; fi

# --- Check 1: no functional sendAdmin left (doc comments allowed) ---
sa="$(fs 'sendAdmin' "$MGR/index.ts" "$MGR/wiki-index.ts" | not_comment || true)"
if [ -z "$sa" ]; then
  pass "no functional sendAdmin in index.ts/wiki-index.ts (errors via sendWikiError, fallback redirects)"
else
  fail "functional sendAdmin still present:"; echo "$sa" | sed 's/^/      /'
fi

# --- Check 2: front-door redirect present ---
if fs '/^\/$/' "$MGR/index.ts" >/dev/null; then
  pass "exact-root redirect route (/^\\/\$/) present in index.ts"
else
  fail "exact-root redirect route (/^\\/\$/) missing in index.ts — front door not pointed at HTMX"
fi

# --- Check 3: loop-safety = the redirect destination /login is SERVED, not redirected ---
# The root route and the catch-all fallback both redirect to /admin-htmx, which
# (when unauthenticated) redirects to /login. That terminates only because /login
# is served by its own HTMX route. Verify that route exists.
if fs '/^\/login$/' "$MGR/admin-htmx.ts" >/dev/null; then
  pass "/login served by an HTMX route — front-door redirects terminate (no loop)"
else
  fail "/login HTMX route (/^\\/login\$/) missing — redirects to /login would not terminate"
fi

# --- Check 4: HTMX login plumbing (template + self-hosted OPAQUE client) ---
if [ -f "$TPL/htmx-login.html" ] && fs 'htmx-login.html' "$MGR/admin-htmx.ts" >/dev/null; then
  pass "htmx-login.html exists and is referenced by admin-htmx.ts"
else
  fail "htmx-login.html missing or not referenced in admin-htmx.ts (login page gap)"
fi
if fs 'getOpaqueJs' "$MGR/admin-htmx.ts" >/dev/null; then
  pass "self-hosted OPAQUE client route present (admin-htmx serves opaque.js)"
else
  fail "OPAQUE client route missing — HTMX login cannot run the handshake"
fi

# --- Check 5: HTMX route <-> template coverage (every admin surface) ---
for tpl in recipes bags poc roles plugins settings frame; do
  f="$TPL/htmx-admin-$tpl.html"
  if [ ! -f "$f" ]; then fail "missing template $f"; continue; fi
  if fs "htmx-admin-$tpl.html" "$MGR/admin-htmx.ts" >/dev/null; then
    pass "htmx-admin-$tpl.html exists and is referenced by admin-htmx.ts"
  else
    fail "htmx-admin-$tpl.html exists but is NOT referenced in admin-htmx.ts (route gap)"
  fi
done

# --- Check 6: React fully removed (cutover complete; any presence = regression) ---
[ -d public/react-admin ]   && fail "public/react-admin/ present — React bundle should be deleted"   || pass "public/react-admin/ removed"
[ -d packages/react-admin ] && fail "packages/react-admin/ present — React source should be deleted" || pass "packages/react-admin/ removed"
[ -f "$SVC/setupDevServer.ts" ] && fail "services/setupDevServer.ts present — React serving plumbing not removed" || pass "setupDevServer.ts removed (React serving plumbing gone)"
if grep -q 'react-admin' package.json tsconfig.base.json 2>/dev/null; then
  fail "react-admin still referenced in package.json/tsconfig.base.json"
else
  pass "no react-admin references in package.json / tsconfig.base.json"
fi
# The frame must not advertise the removed React admin.
if fs 'Switch to React' "$TPL/htmx-admin-frame.html" >/dev/null; then
  fail "htmx-admin-frame.html still has the 'Switch to React Admin' link"
else
  pass "frame nav has no React link"
fi

echo "== summary: ${fails} failure(s) =="
[ "$fails" -eq 0 ] || exit 1
