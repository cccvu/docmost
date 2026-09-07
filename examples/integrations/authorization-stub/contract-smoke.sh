#!/usr/bin/env bash
# Contract-replacement smoke for the Docmost fork (issue #172, epic #157, ADR 0014).
#
# Proves, using ONLY this fork + the ZERO-DEPENDENCY reference authorization stub in this directory (no CCC
# platform, no SpiceDB), that a third party can implement the authorization service from the published
# contract (../../../docs/integrations/authorization/authorization-service.openapi.json) ALONE:
#
#   1. the fork boots in AUTHZ_MODE=remote, fail-closed, delegating every fine-grained decision to the stub,
#   2. native credential login is disabled in remote mode (POST /api/auth/login -> 404),
#   3. a DOCUMENTED-ALLOW decision round-trips through the real PEP: a user the stub grants reads a page (200),
#   4. a NON-FIXTURE decision denies: a user the stub does NOT grant is denied the same page (403/404).
#
# Because the stub matches EXACT { externalId, permission, resourceType, resourceId } tuples and the fork
# generates its own UUIDs, we first bootstrap real data in a NATIVE-mode boot (native credential routes are
# 404 in remote — #184), capture the real ids, seed the stub policy with them, then recreate the fork in
# remote mode pointed at the stub. The Postgres volume persists across the mode swap and APP_SECRET is stable,
# so native-phase session cookies stay valid in remote mode (existing sessions work; only the login ROUTE 404s).
#
# Run from anywhere; the script cds to this directory. Requires docker (compose v2), curl, jq, openssl.
#   docmost/examples/integrations/authorization-stub/contract-smoke.sh
# Env: KEEP_UP=1 leaves the stack running; DOCMOST_PORT overrides the host port (default 13400).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

export DOCMOST_PORT="${DOCMOST_PORT:-13400}"
export MAILPIT_UI_PORT="${MAILPIT_UI_PORT:-18026}"
export APP_SECRET="${APP_SECRET:-$(openssl rand -hex 32)}"
# The shared east-west secret: identical for the fork's PEP and the stub, so the only thing under test is the
# authorization DECISION, never the transport auth.
export PLATFORM_AUTHZ_SERVICE_SECRET="${PLATFORM_AUTHZ_SERVICE_SECRET:-$(openssl rand -hex 32)}"
# The seeded policy lives INSIDE this dir (Docker can always share the build-context tree) and is git-ignored.
POLICY_GEN="$HERE/.stub-policy.generated.json"
export STUB_POLICY_FILE="./.stub-policy.generated.json"

COMPOSE=(docker compose -p docmost-contract-stub -f docker-compose.yml)
BASE="http://localhost:${DOCMOST_PORT}"
TMP="$(mktemp -d)"
A_JAR="$TMP/a.cookies"
B_JAR="$TMP/b.cookies"
fail=0

log()  { printf '\n=== %s ===\n' "$*"; }
pass() { printf '  PASS: %s\n' "$*"; }
bad()  { printf '  FAIL: %s\n' "$*"; fail=1; }

cleanup() {
  if [ "${KEEP_UP:-}" = "1" ]; then
    printf '\n[smoke] KEEP_UP=1 -> leaving the stack running (%s). Tear down with:\n  %s down -v\n' "$BASE" "${COMPOSE[*]}"
  else
    "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
    rm -f "$POLICY_GEN"
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

for bin in docker curl jq openssl; do command -v "$bin" >/dev/null || { echo "missing required tool: $bin"; exit 2; }; done

# A placeholder policy so the file exists for any early compose evaluation; overwritten with real ids below.
echo '{"grants":[]}' > "$POLICY_GEN"

wait_ready() { # $1 = human label
  local ready=0
  for _ in $(seq 1 120); do
    if curl -fsS -o /dev/null "${BASE}/"; then ready=1; break; fi
    sleep 2
  done
  [ "$ready" = "1" ] && pass "$1" || { bad "app never came up ($1)"; "${COMPOSE[@]}" logs docmost --tail 80 || true; exit 1; }
}
psql() { "${COMPOSE[@]}" exec -T postgres psql -U docmost -d docmost -tAc "$1" | tr -d '[:space:]'; }

# ── Phase 1: NATIVE bootstrap — build + boot the fork in native mode and create real data ──────────────
log "build + boot the fork in NATIVE mode to bootstrap real ids (stub not needed yet)"
export DOCMOST_AUTHZ_MODE=native
"${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --build postgres redis docmost
wait_ready "fork booted (native bootstrap phase)"

log "first-run setup (workspace + owner Alice)"
setup_code=""
for _ in $(seq 1 30); do
  setup_code="$(curl -s -o "$TMP/setup.json" -w '%{http_code}' -c "$A_JAR" -H 'content-type: application/json' \
    -d '{"name":"Alice","email":"alice@example.com","password":"AlicePw123!","workspaceName":"Contract"}' \
    "${BASE}/api/auth/setup" || true)"
  case "$setup_code" in 200|201|400|409) break ;; *) sleep 2 ;; esac
done
case "$setup_code" in
  200|201) pass "setup succeeded" ;;
  400|409) curl -s -o /dev/null -c "$A_JAR" -H 'content-type: application/json' \
             -d '{"email":"alice@example.com","password":"AlicePw123!"}' "${BASE}/api/auth/login"
           pass "workspace already initialized; logged in as owner" ;;
  *) bad "setup failed (HTTP $setup_code): $(cat "$TMP/setup.json" 2>/dev/null)"; exit 1 ;;
esac

log "owner creates a private space + page"
curl -s -o "$TMP/space.json" -b "$A_JAR" -H 'content-type: application/json' \
  -d '{"name":"Alice Private","slug":"alice-private"}' "${BASE}/api/spaces/create"
SPACE_ID="$(jq -r '.id // .data.id // empty' "$TMP/space.json")"
[ -n "$SPACE_ID" ] && pass "space created ($SPACE_ID)" || { bad "space create failed: $(cat "$TMP/space.json")"; exit 1; }
curl -s -o "$TMP/page.json" -b "$A_JAR" -H 'content-type: application/json' \
  -d "{\"spaceId\":\"$SPACE_ID\",\"title\":\"Secret page\"}" "${BASE}/api/pages/create"
PAGE_ID="$(jq -r '.id // .data.id // empty' "$TMP/page.json")"
[ -n "$PAGE_ID" ] && pass "page created ($PAGE_ID)" || { bad "page create failed: $(cat "$TMP/page.json")"; exit 1; }

log "invite + provision a second user (Bob), NOT granted anything"
curl -s -o "$TMP/invite.json" -b "$A_JAR" -H 'content-type: application/json' \
  -d '{"emails":["bob@example.com"],"role":"member","groupIds":[]}' "${BASE}/api/workspace/invites/create" >/dev/null || true
# The psql helper strips whitespace, so read id + token as separate single-value queries.
INV_ID="$(psql "select id from workspace_invitations where email='bob@example.com' order by created_at desc limit 1")"
INV_TOKEN="$(psql "select token from workspace_invitations where email='bob@example.com' order by created_at desc limit 1")"
[ -n "$INV_ID" ] && [ -n "$INV_TOKEN" ] && pass "invitation created ($INV_ID)" || { bad "could not read invitation token"; exit 1; }
curl -s -o /dev/null -H 'content-type: application/json' \
  -d "{\"invitationId\":\"$INV_ID\",\"token\":\"$INV_TOKEN\",\"name\":\"Bob\",\"password\":\"BobPw123!\"}" \
  "${BASE}/api/workspace/invites/accept" || true
blogin="$(curl -s -o /dev/null -w '%{http_code}' -c "$B_JAR" -H 'content-type: application/json' \
  -d '{"email":"bob@example.com","password":"BobPw123!"}' "${BASE}/api/auth/login")"
[ "$blogin" = "200" ] && pass "Bob provisioned + logged in (native)" || { bad "Bob login failed ($blogin)"; exit 1; }

# The exact subject the fork's PEP sends is { provider:'docmost', externalId: <users.id UUID> } — capture it.
ALICE_ID="$(psql "select id from users where email='alice@example.com'")"
[ -n "$ALICE_ID" ] && pass "captured Alice's externalId ($ALICE_ID)" || { bad "could not read Alice's user id"; exit 1; }

# ── Phase 2: seed the stub policy with the REAL ids, then flip the fork to REMOTE ──────────────────────
log "seed the stub policy — grant ONLY Alice view on the space + page (Bob gets nothing)"
cat > "$POLICY_GEN" <<JSON
{ "grants": [
  { "externalId": "$ALICE_ID", "permission": "view", "resourceType": "space", "resourceId": "$SPACE_ID" },
  { "externalId": "$ALICE_ID", "permission": "view", "resourceType": "page",  "resourceId": "$PAGE_ID" }
] }
JSON
pass "policy written ($POLICY_GEN)"

log "boot the reference stub, then recreate the fork in AUTHZ_MODE=remote pointed at it"
"${COMPOSE[@]}" up -d stub
export DOCMOST_AUTHZ_MODE=remote
"${COMPOSE[@]}" up -d --force-recreate --no-deps docmost
wait_ready "fork re-booted in REMOTE mode (fail-closed validation passed)"

# ── Phase 3: assertions — the boundary + the contract round-trip ──────────────────────────────────────
log "remote mode disables native credential login (route 404s for all callers)"
login_remote="$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"AlicePw123!"}' "${BASE}/api/auth/login")"
[ "$login_remote" = "404" ] && pass "native login route 404 in remote mode (NativeAuthModeGuard)" \
  || bad "native login route not 404 in remote (HTTP $login_remote) — mode boundary broken"

log "CONTRACT round-trip: a stub-GRANTED read succeeds, a NON-fixture read is denied — through the real PEP"
alice_read="$(curl -s -o "$TMP/aread.json" -w '%{http_code}' -b "$A_JAR" -H 'content-type: application/json' \
  -d "{\"pageId\":\"$PAGE_ID\"}" "${BASE}/api/pages/info")"
[ "$alice_read" = "200" ] \
  && pass "Alice (stub-granted) reads the page (200) — documented ALLOW round-trips fork -> stub -> fork" \
  || bad "Alice was NOT allowed (HTTP $alice_read) — the allow decision did not round-trip: $(cat "$TMP/aread.json" 2>/dev/null)"

bob_read="$(curl -s -o "$TMP/bread.json" -w '%{http_code}' -b "$B_JAR" -H 'content-type: application/json' \
  -d "{\"pageId\":\"$PAGE_ID\"}" "${BASE}/api/pages/info")"
if [ "$bob_read" = "403" ] || [ "$bob_read" = "404" ]; then
  pass "Bob (no stub grant) is DENIED the page ($bob_read) — non-fixture denies, deny-by-default holds"
else
  bad "Bob was NOT denied (HTTP $bob_read) — the stub's deny-by-default did not gate the fork: $(cat "$TMP/bread.json" 2>/dev/null)"
fi

log "RESULT"
if [ "$fail" = "0" ]; then
  echo "  ALL CHECKS PASSED — a third party can implement the authorization service from the published contract alone."
  exit 0
else
  echo "  ONE OR MORE CHECKS FAILED."
  exit 1
fi
