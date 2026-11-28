#!/usr/bin/env bash
#
# Sprint 6 deploy smoke test (D43).
#
#   scripts/smoke.sh <base-url>        e.g. scripts/smoke.sh http://localhost:4000
#
# Checks the exact acceptance path against a running API:
#   health -> demo-attendee login -> demo event -> available seat ->
#   hold -> checkout URL -> release -> seat AVAILABLE again.
#
# It intentionally stops before paying: the Razorpay/fake checkout URL is only
# asserted to be non-empty, so the demo seat stay reusable.
#
# Pure bash + grep/sed: no jq, python or uuidgen dependency. The response
# shapes are the ones documented in `apps/api/src/routes/*.ts`.
set -euo pipefail

if [ "$#" -lt 1 ] || [ -z "$1" ]; then
  printf 'usage: %s <base-url>\n' "$0" >&2
  printf '  e.g. %s http://localhost:4000\n' "$0" >&2
  exit 2
fi

BASE="${1%/}"
ATTENDEE_EMAIL="demo-attendee@seatsync.demo"
ATTENDEE_PASSWORD="DemoAttendee!2026"
DEMO_EVENT_TITLE="SeatSync Live Demo"
LOGIN_PAYLOAD='{"email":"demo-attendee@seatsync.demo","password":"DemoAttendee!2026"}'

TMP_DIR="$(mktemp -d)"
BODY_FILE="$TMP_DIR/body"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  printf '[fail] %s\n' "$1" >&2
  if [ -s "$BODY_FILE" ]; then
    printf '       response: %s\n' "$(tr -d '\r\n' < "$BODY_FILE")" >&2
  fi
  exit 1
}

ok() {
  printf '[ok] %s\n' "$1"
}

# First string value for a top-level key: "key": "value" (spaces tolerated).
json_string() {
  local json="$1"
  local key="$2"
  local match=""
  match=$(printf '%s' "$json" | grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n 1) || true
  if [ -z "$match" ]; then
    return 0
  fi
  match=${match#*:}
  printf '%s' "$match" | sed -e 's/^[[:space:]]*"//' -e 's/"$//'
}

# Split a JSON array of flat objects on "},{". Works for /events and /events/:id.
json_objects() {
  printf '%s\n' "$1" | sed 's/},{/}\
{/g'
}

# The public list is {"events":[...],"nextCursor":...}; title order is stable.
find_event_id() {
  local json="$1"
  local title="$2"
  local chunk chunk_title
  while IFS= read -r chunk; do
    chunk_title=$(json_string "$chunk" title)
    if [ "$chunk_title" = "$title" ]; then
      json_string "$chunk" id
      return 0
    fi
  done < <(json_objects "$json")
}

# Extract the seats array contents from an event detail object.
seats_json() {
  printf '%s' "$1" | sed -n 's/.*"seats":\[\(.*\)\]}.*/\1/p'
}

find_available_seat_id() {
  local json="$1"
  local chunk status
  while IFS= read -r chunk; do
    status=$(json_string "$chunk" status)
    if [ "$status" = "AVAILABLE" ]; then
      json_string "$chunk" id
      return 0
    fi
  done < <(json_objects "$json")
}

find_seat_status() {
  local json="$1"
  local seat_id="$2"
  local chunk chunk_id
  while IFS= read -r chunk; do
    chunk_id=$(json_string "$chunk" id)
    if [ "$chunk_id" = "$seat_id" ]; then
      json_string "$chunk" status
      return 0
    fi
  done < <(json_objects "$json")
}

# A fresh key per run keeps the hold idempotency record isolated.
new_idempotency_key() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  elif [ -r /proc/sys/kernel/random/uuid ]; then
    tr -d '\r\n' < /proc/sys/kernel/random/uuid
  else
    printf 'smoke-%s-%s\n' "$(date +%s)" "$$"
  fi
}

# ---------------------------------------------------------------------------
# a. GET /health -> 200 with db and redis both ok
# ---------------------------------------------------------------------------
if ! HTTP_STATUS=$(curl -sS --max-time 30 -o "$BODY_FILE" -w '%{http_code}' "$BASE/health"); then
  fail "health: could not reach $BASE/health"
fi
BODY=$(cat "$BODY_FILE")
[ "$HTTP_STATUS" = "200" ] || fail "health: expected HTTP 200, got $HTTP_STATUS"
case "$BODY" in
  *'"db":"ok"'*) ;;
  *) fail 'health: response does not contain "db":"ok"' ;;
esac
case "$BODY" in
  *'"redis":"ok"'*) ;;
  *) fail 'health: response does not contain "redis":"ok"' ;;
esac
ok "health: 200 (db ok, redis ok)"

# ---------------------------------------------------------------------------
# b. POST /auth/login as the demo attendee -> 200 + accessToken
# ---------------------------------------------------------------------------
if ! HTTP_STATUS=$(curl -sS --max-time 30 -o "$BODY_FILE" -w '%{http_code}' \
  -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$LOGIN_PAYLOAD"); then
  fail "login: could not reach $BASE/auth/login"
fi
BODY=$(cat "$BODY_FILE")
[ "$HTTP_STATUS" = "200" ] || fail "login: expected HTTP 200, got $HTTP_STATUS"
ACCESS_TOKEN=$(json_string "$BODY" accessToken)
[ -n "$ACCESS_TOKEN" ] || fail "login: response has no accessToken"
ok "login: 200 ($ATTENDEE_EMAIL, access token captured)"

# ---------------------------------------------------------------------------
# c. GET /events -> find the published "SeatSync Live Demo" event
# ---------------------------------------------------------------------------
if ! HTTP_STATUS=$(curl -sS --max-time 30 -o "$BODY_FILE" -w '%{http_code}' \
  "$BASE/events?limit=100"); then
  fail "events: could not reach $BASE/events"
fi
BODY=$(cat "$BODY_FILE")
[ "$HTTP_STATUS" = "200" ] || fail "events: expected HTTP 200, got $HTTP_STATUS"
EVENT_ID=$(find_event_id "$BODY" "$DEMO_EVENT_TITLE")
[ -n "$EVENT_ID" ] || fail "events: no event titled '$DEMO_EVENT_TITLE' (run pnpm --filter api seed:demo)"
ok "demo event: $DEMO_EVENT_TITLE ($EVENT_ID)"

# ---------------------------------------------------------------------------
# d. GET /events/:id -> pick one AVAILABLE seat
# ---------------------------------------------------------------------------
if ! HTTP_STATUS=$(curl -sS --max-time 30 -o "$BODY_FILE" -w '%{http_code}' \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  "$BASE/events/$EVENT_ID"); then
  fail "event detail: could not reach $BASE/events/$EVENT_ID"
fi
BODY=$(cat "$BODY_FILE")
[ "$HTTP_STATUS" = "200" ] || fail "event detail: expected HTTP 200, got $HTTP_STATUS"
SEATS=$(seats_json "$BODY")
[ -n "$SEATS" ] || fail "event detail: response has no seats array"
SEAT_ID=$(find_available_seat_id "$SEATS")
[ -n "$SEAT_ID" ] || fail "event detail: no AVAILABLE seat left in $EVENT_ID"
ok "event detail: 200, picked AVAILABLE seat $SEAT_ID"

# ---------------------------------------------------------------------------
# e. POST /events/:id/holds (fresh Idempotency-Key) -> 201 + holdId
# ---------------------------------------------------------------------------
IDEMPOTENCY_KEY=$(new_idempotency_key)
HOLD_PAYLOAD=$(printf '{"seatIds":["%s"]}' "$SEAT_ID")
if ! HTTP_STATUS=$(curl -sS --max-time 30 -o "$BODY_FILE" -w '%{http_code}' \
  -X POST "$BASE/events/$EVENT_ID/holds" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -H 'Content-Type: application/json' \
  --data "$HOLD_PAYLOAD"); then
  fail "hold: could not reach $BASE/events/$EVENT_ID/holds"
fi
BODY=$(cat "$BODY_FILE")
[ "$HTTP_STATUS" = "201" ] || fail "hold: expected HTTP 201, got $HTTP_STATUS"
HOLD_ID=$(json_string "$BODY" holdId)
[ -n "$HOLD_ID" ] || fail "hold: response has no holdId"
case "$BODY" in
  *"\"$SEAT_ID\""*) ;;
  *) fail "hold: response does not echo seat id $SEAT_ID" ;;
esac
ok "hold: 201 (hold $HOLD_ID, seat echoed)"

# ---------------------------------------------------------------------------
# f. POST /holds/:id/checkout -> 200/201 with a non-empty checkoutUrl.
#    Deliberately NOT followed/paid.
# ---------------------------------------------------------------------------
if ! HTTP_STATUS=$(curl -sS --max-time 30 -o "$BODY_FILE" -w '%{http_code}' \
  -X POST "$BASE/holds/$HOLD_ID/checkout" \
  -H "Authorization: Bearer $ACCESS_TOKEN"); then
  fail "checkout: could not reach $BASE/holds/$HOLD_ID/checkout"
fi
BODY=$(cat "$BODY_FILE")
case "$HTTP_STATUS" in
  200|201) ;;
  *) fail "checkout: expected HTTP 200 or 201, got $HTTP_STATUS" ;;
esac
CHECKOUT_URL=$(json_string "$BODY" checkoutUrl)
[ -n "$CHECKOUT_URL" ] || fail "checkout: response has an empty checkoutUrl"
ok "checkout: $HTTP_STATUS (checkout URL captured, not followed)"

# ---------------------------------------------------------------------------
# g. DELETE /holds/:id -> 204
# ---------------------------------------------------------------------------
if ! HTTP_STATUS=$(curl -sS --max-time 30 -o "$BODY_FILE" -w '%{http_code}' \
  -X DELETE "$BASE/holds/$HOLD_ID" \
  -H "Authorization: Bearer $ACCESS_TOKEN"); then
  fail "release: could not reach $BASE/holds/$HOLD_ID"
fi
[ "$HTTP_STATUS" = "204" ] || fail "release: expected HTTP 204, got $HTTP_STATUS"
ok "release: 204 (hold $HOLD_ID deleted)"

# ---------------------------------------------------------------------------
# h. GET /events/:id again -> the seat is AVAILABLE again
# ---------------------------------------------------------------------------
if ! HTTP_STATUS=$(curl -sS --max-time 30 -o "$BODY_FILE" -w '%{http_code}' \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  "$BASE/events/$EVENT_ID"); then
  fail "seat recheck: could not reach $BASE/events/$EVENT_ID"
fi
BODY=$(cat "$BODY_FILE")
[ "$HTTP_STATUS" = "200" ] || fail "seat recheck: expected HTTP 200, got $HTTP_STATUS"
SEAT_STATUS=$(find_seat_status "$(seats_json "$BODY")" "$SEAT_ID")
[ "$SEAT_STATUS" = "AVAILABLE" ] || fail "seat recheck: seat $SEAT_ID is '$SEAT_STATUS', expected AVAILABLE"
ok "seat recheck: $SEAT_ID is AVAILABLE again"

printf 'smoke test passed: %s\n' "$BASE"
