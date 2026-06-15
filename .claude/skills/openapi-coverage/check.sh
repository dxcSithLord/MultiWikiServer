#!/usr/bin/env bash
#
# openapi-coverage — read-only validation that openapi.yaml is a valid OpenAPI 3.1
# document AND documents every HTTP route the MWS server actually handles.
#
# Two guarantees, both FAIL on drift:
#   1. Validity — Spectral (spectral:oas + OWASP ruleset) + a yq structural guard.
#   2. Coverage — every route registered in packages/mws/src/** is present in openapi.yaml.
#
# Prints PASS / FAIL / WARN / INFO lines and a "summary: N failure(s)" line; exits 1 if
# any FAIL. NEVER edits files. Locates the repo root relative to its own location.
#
# Requires mikefarah yq v4 (NOT python yq) and Spectral; a missing tool prints the exact
# install command and exits non-zero. Target host is aarch64 (linux_arm64).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$ROOT" || { echo "FAIL: cannot cd to repo root ($ROOT)"; exit 2; }

SPEC="openapi.yaml"
SRC="packages/mws/src"

fails=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; fails=$((fails + 1)); }
warn() { echo "WARN: $*"; }
info() { echo "INFO: $*"; }

# ── tool checks ──────────────────────────────────────────────────────────────
YQ_INSTALL='curl -L -o /usr/local/bin/yq https://github.com/mikefarah/yq/releases/download/v4.53.3/yq_linux_arm64 && chmod +x /usr/local/bin/yq'

if ! command -v yq >/dev/null 2>&1; then
  fail "mikefarah yq v4 not found. Install (linux_arm64): $YQ_INSTALL"
  echo "summary: $fails failure(s)"; exit 1
fi
# Reject the python yq (jq wrapper); we need mikefarah v4 eval syntax.
if ! yq --version 2>&1 | grep -qi 'mikefarah'; then
  fail "found a non-mikefarah 'yq' ($(yq --version 2>&1)). Install mikefarah v4: $YQ_INSTALL"
  echo "summary: $fails failure(s)"; exit 1
fi

if [ ! -f "$SPEC" ]; then
  fail "$SPEC not found at repo root"; echo "summary: $fails failure(s)"; exit 1
fi

# ── 1. Spectral lint (validity + OWASP) ──────────────────────────────────────
# Gate on errors only; OWASP advisories are down-ranked to warnings in .spectral.yaml and
# are summarised (not dumped) to keep this report readable.
if npx --no-install spectral --version >/dev/null 2>&1; then
  lint_out="$(npx --no-install spectral lint "$SPEC" --fail-severity=error 2>&1)"
  lint_rc=$?
  warn_n="$(printf '%s\n' "$lint_out" | grep -cE '[0-9]+:[0-9]+[[:space:]]+warning')"
  if [ "$lint_rc" -eq 0 ]; then
    pass "spectral lint clean (oas + OWASP, 0 errors; $warn_n OWASP advisory warning(s))"
  else
    fail "spectral reported error-level problems in $SPEC:"
    printf '%s\n' "$lint_out" | grep -E '[0-9]+:[0-9]+[[:space:]]+error' | head -40
  fi
else
  # Spectral is the validity gate (guarantee #1). If it is missing we cannot prove the
  # spec is valid, so fail rather than silently skipping and reporting success.
  fail "Spectral not installed (validity gate cannot run). Install: npm i -D @stoplight/spectral-cli @stoplight/spectral-owasp-ruleset"
  echo "summary: $fails failure(s)"; exit 1
fi

# ── 2. Structural guard ──────────────────────────────────────────────────────
if [ "$(yq e 'has("openapi") and has("info") and has("paths")' "$SPEC" 2>/dev/null)" = "true" ]; then
  pass "structural: openapi + info + paths present"
else
  fail "structural: $SPEC is missing one of openapi/info/paths (or is not valid YAML)"
fi

ver="$(yq e '.openapi' "$SPEC" 2>/dev/null)"
case "$ver" in
  3.1*) pass "openapi version $ver" ;;
  *)    warn "openapi version is '$ver' (expected 3.1.x)" ;;
esac

# ── spec lookups ─────────────────────────────────────────────────────────────
mapfile -t SPEC_PATHS < <(yq e '.paths | keys | .[]' "$SPEC" 2>/dev/null)
mapfile -t SPEC_ADMIN_KEYS < <(
  yq e '.paths."/admin/{key}".post.parameters[] | select(.name == "key") | .schema.enum[]' "$SPEC" 2>/dev/null
)

doc_has_path() { printf '%s\n' "${SPEC_PATHS[@]}" | grep -qxF -- "$1"; }
doc_has_key()  { printf '%s\n' "${SPEC_ADMIN_KEYS[@]}" | grep -qxF -- "$1"; }

# ── 3. Admin-key coverage ────────────────────────────────────────────────────
# Each admin method is declared as `<key> = admin(` in the admin managers + index.ts.
# These are exactly the keys registered behind POST /admin/{key}.
echo "── admin /admin/{key} coverage ──"
mapfile -t ADMIN_KEYS < <(
  grep -rhoE '^[[:space:]]*[a-z_]+ = admin\(' \
    "$SRC/managers/admin-users.ts" "$SRC/managers/admin-recipes.ts" \
    "$SRC/managers/admin-settings.ts" "$SRC/managers/index.ts" 2>/dev/null \
  | sed -E 's/[[:space:]]*([a-z_]+) = admin\(/\1/' | sort -u
)
if [ "${#ADMIN_KEYS[@]}" -eq 0 ]; then
  fail "could not extract any admin keys from source (grep pattern drift?)"
else
  for k in "${ADMIN_KEYS[@]}"; do
    if doc_has_key "$k"; then pass "admin key '$k' documented in /admin/{key} enum"
    else fail "admin key '$k' handled but MISSING from /admin/{key} enum in $SPEC"; fi
  done
  info "found ${#ADMIN_KEYS[@]} admin keys in source; ${#SPEC_ADMIN_KEYS[@]} in spec enum"
fi

# ── 4. Literal-path coverage ─────────────────────────────────────────────────
# String `path:` literals (incl. RECIPE_PREFIX/BAG_PREFIX concatenations) and the
# zodSession("…") session routes. Normalises :param -> {param} and $key -> {key}.
echo "── literal-path coverage ──"
normalize() {
  local p="$1"
  p="${p//\$key/\{key\}}"
  printf '%s\n' "$p" | sed -E 's/:([A-Za-z_][A-Za-z0-9_]*)/{\1}/g'
}

declare -A HANDLED=()

# 4a. `path:` string / prefix-concat literals (skip regex, RegExp, bare `path,`).
while IFS= read -r line; do
  val="${line#*path:}"
  val="${val#"${val%%[![:space:]]*}"}"   # ltrim
  case "$val" in
    '"'*|"'"*)
      lit="$(printf '%s' "$val" | sed -nE "s/^[\"']([^\"']*)[\"'].*/\1/p")"
      [ -n "$lit" ] && HANDLED["$(normalize "$lit")"]=1 ;;
    'RECIPE_PREFIX'*+*)
      lit="$(printf '%s' "$val" | sed -nE 's/.*"([^"]*)".*/\1/p')"
      [ -n "$lit" ] && HANDLED["$(normalize "/recipe$lit")"]=1 ;;
    'BAG_PREFIX'*+*)
      lit="$(printf '%s' "$val" | sed -nE 's/.*"([^"]*)".*/\1/p')"
      [ -n "$lit" ] && HANDLED["$(normalize "/bag$lit")"]=1 ;;
    *) : ;;  # regex literal, `new RegExp`, `path,` variable, or `[]` — handled elsewhere
  esac
done < <(grep -rEn 'path:' "$SRC" --include=*.ts | grep -v '/__tests__/')

# 4b. zodSession("/login/1", …) etc.
while IFS= read -r lit; do
  [ -n "$lit" ] && HANDLED["$(normalize "$lit")"]=1
done < <(grep -rhoE 'zodSession\("[^"]+"' "$SRC" --include=*.ts | sed -E 's/zodSession\("([^"]+)"/\1/')

for p in $(printf '%s\n' "${!HANDLED[@]}" | sort); do
  if doc_has_path "$p"; then pass "route $p documented"
  else fail "route $p handled but MISSING from $SPEC paths"; fi
done

# ── 5. Regex-route coverage ──────────────────────────────────────────────────
# Regex-literal / RegExp paths can't be auto-normalised reliably, so each known one is
# pinned to its documented template here. (recipe_name parent matcher `^(?=/recipe/)` has
# method:[] / denyFinal — it is a matcher, not an endpoint, so it is intentionally absent.)
echo "── regex-route coverage ──"
REGEX_DOC_PATHS=(
  "/"                              # index.ts  /^\/$/  (front door) + /^\/.*/ (fallback)
  "/wiki/{recipe_name}"            # wiki-index.ts  /^\/wiki\/(.*)$/
  "/\$cache/{plugin}/plugin.js"    # cache.ts  /^\/\$cache\/(.*)\/plugin\.js$/
  "/mws-docs/{path}"               # tw-routes.ts  ^/mws-docs(/|$)
  "/login"                         # admin-htmx.ts  /^\/login$/
  "/home"                          # admin-htmx.ts  /^\/home$/
  "/resume-sso"                    # admin-htmx.ts  /^\/resume-sso$/
  "/admin-htmx"                    # admin-htmx.ts  /^\/admin-htmx\/?$/
  "/admin-htmx/bags"               # admin-htmx.ts
  "/admin-htmx/plugins"            # admin-htmx.ts
  "/admin-htmx/users"              # admin-htmx.ts
  "/admin-htmx/roles"              # admin-htmx.ts
  "/admin-htmx/settings"           # admin-htmx.ts
  "/admin-htmx/profile"            # admin-htmx.ts
  "/admin-htmx/styles.css"         # admin-htmx.ts  /^\/admin-htmx\/styles\.css$/
  "/admin-htmx/opaque.js"          # admin-htmx.ts  /^\/admin-htmx\/opaque\.js$/
)
for p in "${REGEX_DOC_PATHS[@]}"; do
  if doc_has_path "$p"; then pass "regex route → $p documented"
  else fail "regex route → $p MISSING from $SPEC paths"; fi
done

# Drift guard: diff every regex `path:` declaration found in source against the known set
# below. Each known signature maps to a documented route in the pinned table above (or is an
# intentional non-endpoint matcher). A new/changed regex declaration that is NOT in this set
# is surfaced as a WARN so it cannot slip past the pinned table unnoticed — prompting whoever
# added it to document the route and extend both lists. (Regex literals can't be auto-
# normalised to path templates, so this diffs the raw source signatures.)
REGEX_SRC_KNOWN=(
  '/^\/$/'                                 # index.ts front door         -> /
  '/^\/.*/'                                # index.ts fallback           -> /
  '/^\/wiki\/(.*)$/'                       # wiki-index.ts               -> /wiki/{recipe_name}
  '/^\/\$cache\/(.*)\/plugin\.js$/'        # cache.ts                    -> /$cache/{plugin}/plugin.js
  '/^\/login$/'                            # admin-htmx.ts               -> /login
  '/^\/home$/'                             # admin-htmx.ts               -> /home
  '/^\/resume-sso$/'                       # admin-htmx.ts               -> /resume-sso
  '/^\/admin-htmx\/?$/'                    # admin-htmx.ts               -> /admin-htmx
  '/^\/admin-htmx\/bags$/'                 # admin-htmx.ts
  '/^\/admin-htmx\/plugins$/'              # admin-htmx.ts
  '/^\/admin-htmx\/users$/'                # admin-htmx.ts
  '/^\/admin-htmx\/roles$/'                # admin-htmx.ts
  '/^\/admin-htmx\/settings$/'             # admin-htmx.ts
  '/^\/admin-htmx\/profile$/'              # admin-htmx.ts
  '/^\/admin-htmx\/styles\.css$/'          # admin-htmx.ts
  '/^\/admin-htmx\/opaque\.js$/'           # admin-htmx.ts
  'new RegExp(`^(?=${RECIPE_PREFIX}/)`)'   # wiki-index.ts parent matcher (method:[], not an endpoint)
  'new RegExp("^" + mountPath + "(/|$)")'  # tw-routes.ts docs mount     -> /mws-docs/{path}
)
unmapped=0; regex_total=0
while IFS= read -r sig; do
  [ -n "$sig" ] || continue
  regex_total=$((regex_total + 1))
  if ! printf '%s\n' "${REGEX_SRC_KNOWN[@]}" | grep -qxF -- "$sig"; then
    warn "undocumented regex route declaration: $sig"
    warn "  → add it to openapi.yaml, REGEX_DOC_PATHS, and REGEX_SRC_KNOWN"
    unmapped=$((unmapped + 1))
  fi
done < <(
  grep -rEn 'path:[[:space:]]*(/\^|new RegExp)' "$SRC" --include=*.ts | grep -v '/__tests__/' \
    | sed -E 's#.*:[0-9]+:[[:space:]]*path:[[:space:]]*##; s#,[[:space:]]*$##'
)
if [ "$unmapped" -eq 0 ]; then
  pass "regex drift: all $regex_total regex path declaration(s) in source map to a known documented route"
else
  warn "regex drift: $unmapped of $regex_total regex declaration(s) are unmapped (see above)"
fi

echo "summary: $fails failure(s)"
[ "$fails" -eq 0 ] || exit 1
