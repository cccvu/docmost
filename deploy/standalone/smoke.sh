#!/usr/bin/env bash
# Standalone native-mode boot + authorization smoke for the Docmost fork.
#
# Proves, using ONLY this fork (no super-repo, no CCC platform, no SpiceDB), that:
#   1. the fork builds and boots with AUTHZ_MODE=native,
#   2. native credential auth works (first-run setup + native login),
#   3. native authorization is really ENFORCED, not allow-all: a second user is DENIED (403) a page in a
#      space they were never made a member of, while the owner reads it (200),
#   4. no CCC services (platform / spicedb) are present.
#
# Run from anywhere; the script cds to the fork root. Requires docker (compose v2), curl, jq.
#   docmost/deploy/standalone/smoke.sh
# Env: KEEP_UP=1 leaves the stack running for debugging; DOCMOST_PORT overrides the port (default 3000).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
FORK_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$FORK_ROOT"

# Use high, uncommon host ports (exported so compose interpolation and .env both see them) so the smoke
# never collides with a running dev stack on 3000 / 8025.
export DOCMOST_PORT="${DOCMOST_PORT:-13300}"
export MAILPIT_UI_PORT="${MAILPIT_UI_PORT:-18025}"
# Own compose project (-p) so the smoke's `down -v` can NEVER wipe a persistent `make standalone` stack
# (which uses the compose file's default project name `docmost-standalone`).
COMPOSE=(docker compose -p docmost-standalone-smoke -f deploy/standalone/docker-compose.yml)
PORT="$DOCMOST_PORT"
BASE="http://localhost:${PORT}"
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
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

for bin in docker curl jq openssl; do command -v "$bin" >/dev/null || { echo "missing required tool: $bin"; exit 2; }; done

# Ensure an env file exists (self-contained run).
if [ ! -f deploy/standalone/.env ]; then
  log "creating deploy/standalone/.env (generated secret)"
  {
    echo "APP_SECRET=$(openssl rand -hex 32)"
    echo "POSTGRES_PASSWORD=docmost"
    echo "APP_URL=${BASE}"
    echo "DOCMOST_PORT=${PORT}"
  } > deploy/standalone/.env
fi

log "build + boot standalone stack (AUTHZ_MODE=native)"
"${COMPOSE[@]}" down -v >/dev/null 2>&1 || true   # clean slate (idempotent re-runs)
"${COMPOSE[@]}" up -d --build

log "wait for the app to serve"
ready=0
for i in $(seq 1 120); do
  if curl -fsS -o /dev/null "${BASE}/"; then ready=1; break; fi
  sleep 2
done
[ "$ready" = "1" ] && pass "app responding at ${BASE}" || { bad "app never came up"; exit 1; }

# psql helper against the bundled db
psql() { "${COMPOSE[@]}" exec -T postgres psql -U docmost -d docmost -tAc "$1"; }

# --- 2. native credential auth: first-run setup (retry while migrations settle) --------------------
log "first-run setup (creates workspace + owner Alice) — native setup route"
setup_code=""
for i in $(seq 1 30); do
  setup_code="$(curl -s -o "$TMP/setup.json" -w '%{http_code}' -c "$A_JAR" \
    -H 'content-type: application/json' \
    -d '{"name":"Alice","email":"alice@example.com","password":"AlicePw123!","workspaceName":"Standalone"}' \
    "${BASE}/api/auth/setup" || true)"
  case "$setup_code" in
    200|201) break ;;
    400|409) break ;;  # already set up (idempotent re-run)
    *) sleep 2 ;;
  esac
done
if [ "$setup_code" = "200" ] || [ "$setup_code" = "201" ]; then
  pass "setup succeeded (native setup route live)"
elif [ "$setup_code" = "400" ] || [ "$setup_code" = "409" ]; then
  # already initialized on a KEEP_UP re-run: log Alice in instead
  curl -s -o /dev/null -c "$A_JAR" -H 'content-type: application/json' \
    -d '{"email":"alice@example.com","password":"AlicePw123!"}' "${BASE}/api/auth/login"
  pass "workspace already initialized; logged in as owner"
else
  bad "setup failed (HTTP $setup_code): $(cat "$TMP/setup.json" 2>/dev/null)"; exit 1
fi

# native credential route is LIVE (native mode): a wrong password is 401, NOT 404 (which is remote mode)
login_bad="$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"wrong"}' "${BASE}/api/auth/login")"
[ "$login_bad" = "401" ] && pass "native login route live (bad password -> 401, not 404)" \
  || bad "native login route not behaving as native (bad password -> $login_bad, expected 401)"

# --- 3a. owner creates a private space + a page ----------------------------------------------------
log "owner creates a private space and a page in it"
curl -s -o "$TMP/space.json" -b "$A_JAR" -H 'content-type: application/json' \
  -d '{"name":"Alice Private","slug":"alice-private"}' "${BASE}/api/spaces/create"
SPACE_ID="$(jq -r '.id // .data.id // empty' "$TMP/space.json")"
[ -n "$SPACE_ID" ] && pass "space created ($SPACE_ID)" || { bad "space create failed: $(cat "$TMP/space.json")"; exit 1; }

curl -s -o "$TMP/page.json" -b "$A_JAR" -H 'content-type: application/json' \
  -d "{\"spaceId\":\"$SPACE_ID\",\"title\":\"Secret page\"}" "${BASE}/api/pages/create"
PAGE_ID="$(jq -r '.id // .data.id // empty' "$TMP/page.json")"
[ -n "$PAGE_ID" ] && pass "page created ($PAGE_ID)" || { bad "page create failed: $(cat "$TMP/page.json")"; exit 1; }

# owner can read it (positive)
owner_read="$(curl -s -o /dev/null -w '%{http_code}' -b "$A_JAR" -H 'content-type: application/json' \
  -d "{\"pageId\":\"$PAGE_ID\"}" "${BASE}/api/pages/info")"
[ "$owner_read" = "200" ] && pass "owner reads the page (200)" || bad "owner could not read own page ($owner_read)"

# --- 3b. invite + provision a SECOND user (Bob), not a member of the space -------------------------
log "invite a second user (Bob) as a plain workspace member"
curl -s -o "$TMP/invite.json" -b "$A_JAR" -H 'content-type: application/json' \
  -d '{"emails":["bob@example.com"],"role":"member","groupIds":[]}' "${BASE}/api/workspace/invites/create" >/dev/null || true
INV="$(psql "select id||' '||token from workspace_invitations where email='bob@example.com' order by created_at desc limit 1" | tr -d '\r')"
INV_ID="${INV%% *}"; INV_TOKEN="${INV##* }"
[ -n "$INV_ID" ] && [ -n "$INV_TOKEN" ] && pass "invitation created ($INV_ID)" || { bad "could not read invitation token from db"; exit 1; }

curl -s -o "$TMP/accept.json" -H 'content-type: application/json' \
  -d "{\"invitationId\":\"$INV_ID\",\"token\":\"$INV_TOKEN\",\"name\":\"Bob\",\"password\":\"BobPw123!\"}" \
  "${BASE}/api/workspace/invites/accept" >/dev/null || true

blogin="$(curl -s -o /dev/null -w '%{http_code}' -c "$B_JAR" -H 'content-type: application/json' \
  -d '{"email":"bob@example.com","password":"BobPw123!"}' "${BASE}/api/auth/login")"
[ "$blogin" = "200" ] && pass "Bob provisioned + logged in via native auth" || { bad "Bob login failed ($blogin)"; exit 1; }

# Positive control: Bob's session is REAL and discriminating. An authenticated user can read their own
# profile (POST /api/users/me -> 200); a broken/unauthenticated session would 401 here. Without this, the
# denial below could pass for the WRONG reason (a silently-broken Bob session), not "authenticated
# non-member is denied".
bob_me="$(curl -s -o /dev/null -w '%{http_code}' -b "$B_JAR" -H 'content-type: application/json' -d '{}' "${BASE}/api/users/me")"
[ "$bob_me" = "200" ] && pass "Bob's session is authenticated (POST /api/users/me -> 200)" \
  || bad "Bob positive control failed (/api/users/me -> $bob_me); the denial below would be inconclusive"

# --- 3c. THE native-ACL assertion: Bob is DENIED Alice's page -------------------------------------
log "native authorization enforcement: authenticated Bob (non-member) must be denied Alice's page"
bob_read="$(curl -s -o "$TMP/bobread.json" -w '%{http_code}' -b "$B_JAR" -H 'content-type: application/json' \
  -d "{\"pageId\":\"$PAGE_ID\"}" "${BASE}/api/pages/info")"
if [ "$bob_read" = "403" ] || [ "$bob_read" = "404" ]; then
  pass "Bob is DENIED the page ($bob_read) — native ACLs are enforced, not allow-all"
else
  bad "Bob was NOT denied (HTTP $bob_read) — native authorization is not enforcing! body: $(cat "$TMP/bobread.json")"
fi

# --- 4. no CCC services present --------------------------------------------------------------------
log "assert no CCC services (platform / spicedb) in the stack"
services="$("${COMPOSE[@]}" config --services | sort | tr '\n' ' ')"
printf '  services: %s\n' "$services"
if echo "$services" | grep -qiE 'platform|spicedb'; then
  bad "a CCC service is present in the standalone stack: $services"
else
  pass "only OSS services present ($services)"
fi

log "RESULT"
if [ "$fail" = "0" ]; then
  echo "  ALL CHECKS PASSED — the fork boots and enforces authorization standalone (AUTHZ_MODE=native)."
  exit 0
else
  echo "  ONE OR MORE CHECKS FAILED."
  exit 1
fi
