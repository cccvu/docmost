#!/usr/bin/env bash
# Contract-replacement smoke for the Docmost fork (issue #172, epic #157, ADR 0014).
#
# Proves, using ONLY this fork + the ZERO-DEPENDENCY reference authorization stub in this directory (no CCC
# platform, no SpiceDB), that a third party can implement the authorization service from the published
# contract (../../../docs/integrations/authorization/authorization-service.openapi.json) ALONE:
#
#   1. the fork boots in AUTHZ_MODE=remote, fail-closed, delegating every fine-grained decision to the stub,
#   2. native credential login is disabled in remote mode (POST /api/auth/login -> 404),
#   3. a DOCUMENTED-ALLOW round-trips through the real PEP: a stub-granted user reads a page (200),
#   4. the fork's decisions track the STUB, not native ACLs — a non-member the stub GRANTS reads page1 (200,
#      native would DENY), while the same user, ungranted on page2, is DENIED (403/404). That divergence from
#      native can only come from a real delegation to the stub, closing the OUTBOUND contract-parse gap that is
#      the reciprocal of #181's INBOUND envelope break (a fork ignoring the stub or fail-opening would flip it).
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

# The stub port (4000) is internal (not published), so probe it from INSIDE the stub container. Any HTTP
# response (the stub answers 405 to a GET) means it is listening; connection-refused/timeout means not ready.
# Guards the race where the fork boots in remote mode and delegates a decision before the stub is up.
wait_stub() {
  for _ in $(seq 1 60); do
    if "${COMPOSE[@]}" exec -T stub node -e \
      'const r=require("http").get({host:"127.0.0.1",port:4000,path:"/",timeout:2000},()=>process.exit(0));r.on("timeout",()=>{r.destroy();process.exit(1)});r.on("error",()=>process.exit(1))' \
      >/dev/null 2>&1; then
      pass "stub ready (authorization service listening on :4000)"; return 0
    fi
    sleep 1
  done
  bad "stub never became ready"; "${COMPOSE[@]}" logs stub --tail 40 || true; exit 1
}

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

# Two independent spaces, each with a page. The stub will GRANT Bob the FIRST (space1/page1) and grant him
# NOTHING on the SECOND (space2/page2). Because space2 shares no grant with Bob, his denial there is
# unambiguous regardless of the fork's space→page inheritance model — the divergence assertions below need
# both a stub-driven ALLOW (native would deny) and a stub-driven DENY that can't be an inheritance artifact.
mkspace() { # $1 = name, $2 = slug  -> echoes the new space id
  curl -s -o "$TMP/space.json" -b "$A_JAR" -H 'content-type: application/json' \
    -d "{\"name\":\"$1\",\"slug\":\"$2\"}" "${BASE}/api/spaces/create"
  jq -r '.id // .data.id // empty' "$TMP/space.json"
}
mkpage() { # $1 = spaceId, $2 = title  -> echoes the new page id
  curl -s -o "$TMP/page.json" -b "$A_JAR" -H 'content-type: application/json' \
    -d "{\"spaceId\":\"$1\",\"title\":\"$2\"}" "${BASE}/api/pages/create"
  jq -r '.id // .data.id // empty' "$TMP/page.json"
}

log "owner creates TWO private spaces, each with a page (space1 -> Bob will be granted; space2 -> never)"
SPACE_ID="$(mkspace 'Alice Private' 'alice-private')"
[ -n "$SPACE_ID" ] && pass "space1 created ($SPACE_ID)" || { bad "space1 create failed: $(cat "$TMP/space.json")"; exit 1; }
PAGE_ID="$(mkpage "$SPACE_ID" 'Secret page')"
[ -n "$PAGE_ID" ] && pass "page1 created ($PAGE_ID)" || { bad "page1 create failed: $(cat "$TMP/page.json")"; exit 1; }
SPACE2_ID="$(mkspace 'Alice Private 2' 'alice-private-2')"
[ -n "$SPACE2_ID" ] && pass "space2 created ($SPACE2_ID)" || { bad "space2 create failed: $(cat "$TMP/space.json")"; exit 1; }
PAGE2_ID="$(mkpage "$SPACE2_ID" 'Other secret page')"
[ -n "$PAGE2_ID" ] && pass "page2 created ($PAGE2_ID)" || { bad "page2 create failed: $(cat "$TMP/page.json")"; exit 1; }

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

# The exact subject the fork's PEP sends is { provider:'docmost', externalId: <users.id UUID> } — capture
# both users' ids so the stub policy can grant them by the SAME externalId the fork will present.
ALICE_ID="$(psql "select id from users where email='alice@example.com'")"
[ -n "$ALICE_ID" ] && pass "captured Alice's externalId ($ALICE_ID)" || { bad "could not read Alice's user id"; exit 1; }
BOB_ID="$(psql "select id from users where email='bob@example.com'")"
[ -n "$BOB_ID" ] && pass "captured Bob's externalId ($BOB_ID)" || { bad "could not read Bob's user id"; exit 1; }

# ── Phase 2: seed the stub policy with the REAL ids, then flip the fork to REMOTE ──────────────────────
# Grant Alice AND Bob view on space1/page1; grant NEITHER anything on space2/page2. Bob is a plain workspace
# member with NO native membership of either space, so in NATIVE mode he would be denied BOTH pages. The only
# reason he can read page1 in REMOTE mode is that the stub grants it — a decision native could never make. So
# page1(Bob)=allow and page2(Bob)=deny is a DIVERGENCE from native that ONLY a real delegation to the stub can
# produce; a fork that silently fell back to native authz (or fail-open on a stub DENY) would flip both and RED
# the smoke. This closes the OUTBOUND contract-parse gap symmetric to #181 (which was an INBOUND envelope break).
log "seed the stub policy — grant Alice + Bob view on space1/page1; grant NOTHING on space2/page2"
cat > "$POLICY_GEN" <<JSON
{ "grants": [
  { "externalId": "$ALICE_ID", "permission": "view", "resourceType": "space", "resourceId": "$SPACE_ID" },
  { "externalId": "$ALICE_ID", "permission": "view", "resourceType": "page",  "resourceId": "$PAGE_ID" },
  { "externalId": "$BOB_ID",   "permission": "view", "resourceType": "space", "resourceId": "$SPACE_ID" },
  { "externalId": "$BOB_ID",   "permission": "view", "resourceType": "page",  "resourceId": "$PAGE_ID" }
] }
JSON
pass "policy written ($POLICY_GEN)"

log "boot the reference stub, then recreate the fork in AUTHZ_MODE=remote pointed at it"
"${COMPOSE[@]}" up -d stub
wait_stub   # ensure the stub is accepting decisions BEFORE the fork boots in remote mode (no delegation race)
export DOCMOST_AUTHZ_MODE=remote
"${COMPOSE[@]}" up -d --force-recreate --no-deps docmost
wait_ready "fork re-booted in REMOTE mode (fail-closed validation passed)"

# ── Phase 3: assertions — the boundary + the contract round-trip ──────────────────────────────────────
log "remote mode disables native credential login (route 404s for all callers)"
login_remote="$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"AlicePw123!"}' "${BASE}/api/auth/login")"
[ "$login_remote" = "404" ] && pass "native login route 404 in remote mode (NativeAuthModeGuard)" \
  || bad "native login route not 404 in remote (HTTP $login_remote) — mode boundary broken"

read_page() { # $1 = cookie jar, $2 = pageId  -> echoes HTTP status, body in $TMP/read.json
  curl -s -o "$TMP/read.json" -w '%{http_code}' -b "$1" -H 'content-type: application/json' \
    -d "{\"pageId\":\"$2\"}" "${BASE}/api/pages/info"
}

log "CONTRACT round-trip: the fork's decisions track the STUB, not native ACLs (through the real PEP)"
# (a) documented ALLOW round-trips: Alice, granted by the stub, reads page1.
alice_read="$(read_page "$A_JAR" "$PAGE_ID")"
[ "$alice_read" = "200" ] \
  && pass "Alice (stub-granted) reads page1 (200) — documented ALLOW round-trips fork -> stub -> fork" \
  || bad "Alice was NOT allowed (HTTP $alice_read) — the allow decision did not round-trip: $(cat "$TMP/read.json" 2>/dev/null)"

# (b) DIVERGENCE / stub-driven ALLOW: Bob is a non-member — native would DENY him page1 — but the stub grants
# it, so remote mode must ALLOW (200). This is the proof the fork actually delegated: native could not produce it.
bob_read1="$(read_page "$B_JAR" "$PAGE_ID")"
[ "$bob_read1" = "200" ] \
  && pass "Bob (non-member, stub-GRANTED) reads page1 (200) — the fork honored a stub ALLOW native would refuse" \
  || bad "Bob was NOT allowed page1 (HTTP $bob_read1) — the fork did not honor the stub's grant (fell back to native / broke the OUTBOUND contract?): $(cat "$TMP/read.json" 2>/dev/null)"

# (c) DIVERGENCE / stub-driven DENY: Bob has NO grant on space2/page2, so remote mode must DENY (403/404).
# Paired with (b) this is discriminating — Bob allowed on page1 and denied on page2 can ONLY come from the
# stub (native denies a non-member BOTH); a blanket allow-all or an ignored stub would fail one of the two.
bob_read2="$(read_page "$B_JAR" "$PAGE2_ID")"
if [ "$bob_read2" = "403" ] || [ "$bob_read2" = "404" ]; then
  pass "Bob (no stub grant) is DENIED page2 ($bob_read2) — deny-by-default holds; the page1 allow was not allow-all"
else
  bad "Bob was NOT denied page2 (HTTP $bob_read2) — the stub's deny-by-default did not gate the fork: $(cat "$TMP/read.json" 2>/dev/null)"
fi

log "RESULT"
if [ "$fail" = "0" ]; then
  echo "  ALL CHECKS PASSED — a third party can implement the authorization service from the published contract alone."
  exit 0
else
  echo "  ONE OR MORE CHECKS FAILED."
  exit 1
fi
