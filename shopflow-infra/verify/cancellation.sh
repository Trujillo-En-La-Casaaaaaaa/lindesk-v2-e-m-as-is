#!/bin/sh
# ---------------------------------------------------------------------------
# ShopFlow order-cancellation black-box verification.
#
# Runs against a running stack (docker compose up --build) and asserts the
# full end-to-end cancellation contract:
#   * freshly initialized schema (CANCELLED + cancelled_at/cancellation_reason)
#   * create order -> stock decrement -> one ORDER_CONFIRMATION
#   * cancel order -> stock restore -> one ORDER_CANCELLATION (idempotent)
#   * concurrent cancels restore stock and notify exactly once
#   * reason validation, shipped-order conflict, unknown order
#   * notification emulator accept/reject contract
#   * storefront is served on :3000
#
# Exit code 0 only when every assertion passes, non-zero otherwise.
#
# Requires: sh, curl, grep, sed, wc. Database assertions additionally use
# `docker compose exec` against the running `db` service; if the Docker CLI is
# unavailable they are reported as skipped (the HTTP scenarios still run).
#
# It must be run from a freshly initialized stack:
#   docker compose down -v && docker compose up --build -d
#   ./verify/cancellation.sh
# ---------------------------------------------------------------------------
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR/.." || exit 1

API_URL=${API_URL:-http://localhost:3001}
NOTIFICATION_URL=${NOTIFICATION_URL:-http://localhost:4010}
WEB_URL=${WEB_URL:-http://localhost:3000}

PASSED=0
FAILED=0
SKIPPED=0

TMP_DIR=$(mktemp -d 2>/dev/null) || TMP_DIR="/tmp/shopflow-verify.$$"
mkdir -p "$TMP_DIR" || exit 1
BODY_FILE="$TMP_DIR/body"
STATUS=""
BODY=""
NOTIFS=""
PRODUCTS=""

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

ok() { PASSED=$((PASSED + 1)); printf 'ok   %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf 'FAIL %s\n' "$1"; }
skip() { SKIPPED=$((SKIPPED + 1)); printf 'skip %s\n' "$1"; }
note() { printf 'note %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }

# check <description> <expected> <actual>
check() {
  if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 [expected: $2 | actual: $3]"; fi
}

# check_present <description> <value>   (non-empty and not JSON null)
check_present() {
  if [ -n "$2" ] && [ "$2" != "null" ]; then ok "$1"; else fail "$1 [value: ${2:-<empty>}]"; fi
}

# has <description> <haystack> <needle>
has() {
  case "$2" in
    *"$3"*) ok "$1" ;;
    *) fail "$1 [missing: $3]" ;;
  esac
}

# --- HTTP -------------------------------------------------------------------
# request <method> <url> [json-payload]  -> sets STATUS and BODY
request() {
  method=$1
  url=$2
  payload=${3-}
  STATUS="000"
  if [ "$method" = "GET" ]; then
    STATUS=$(curl -sS -o "$BODY_FILE" -w '%{http_code}' "$url" 2>"$TMP_DIR/curl.err") || STATUS="000"
  else
    STATUS=$(curl -sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" \
      -H 'content-type: application/json' --data "$payload" "$url" 2>"$TMP_DIR/curl.err") || STATUS="000"
  fi
  BODY=$(cat "$BODY_FILE" 2>/dev/null) || BODY=""
  return 0
}

# wait_for <url> <label> [attempts]
wait_for() {
  url=$1
  label=$2
  attempts=${3:-90}
  i=1
  while [ "$i" -le "$attempts" ]; do
    code=$(curl -sS -o /dev/null -w '%{http_code}' "$url" 2>/dev/null) || code="000"
    if [ "$code" = "200" ]; then
      ok "$label is reachable ($url)"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  fail "$label did not become reachable at $url within ${attempts}s"
  return 1
}

# --- JSON extraction (no jq dependency) -------------------------------------
# json_string <json> <key>  -> value of a string field ("" when absent)
json_string() {
  printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -n 1 | sed -e "s/^\"$2\":\"//" -e 's/"$//'
}

# json_raw <json> <key>  -> literal token of a scalar field (numbers/null/true)
json_raw() {
  printf '%s' "$1" | grep -o "\"$2\":[^,}]*" | head -n 1 | sed -e "s/^\"$2\"://"
}

# records_to_lines <json-list>  -> one object per line
records_to_lines() {
  printf '%s' "$1" | sed -e 's/},{/}\n{/g'
}

# notification_records <json-list> <type> [orderId] -> matching records, one per line
notification_records() {
  if [ -n "${3-}" ]; then
    records_to_lines "$1" | grep -F "\"type\":\"$2\"" | grep -F "\"orderId\":\"$3\""
  else
    records_to_lines "$1" | grep -F "\"type\":\"$2\""
  fi
}

# notif_count <type> [orderId]
notif_count() {
  if [ -n "${2-}" ]; then
    notification_records "$NOTIFS" "$1" "$2" | wc -l | tr -d ' '
  else
    notification_records "$NOTIFS" "$1" | wc -l | tr -d ' '
  fi
}

# notif_reason_count <orderId> <reason>
notif_reason_count() {
  notification_records "$NOTIFS" ORDER_CANCELLATION "$1" | grep -cF "\"reason\":\"$2\"" | tr -d ' '
}

# product_stock <products-json> <productId>
product_stock() {
  records_to_lines "$1" | grep -F "\"id\":\"$2\"" | head -n 1 | grep -o '"stock":[0-9]*' | head -n 1 | sed -e 's/^"stock"://'
}

# --- SQL (optional, uses the running compose db service) --------------------
DB_MODE="run"
if command -v docker >/dev/null 2>&1; then
  if ! docker compose version >/dev/null 2>&1; then DB_MODE="skip"; fi
else
  DB_MODE="skip"
fi

sql() {
  docker compose exec -T db psql -U shopflow -d shopflow -tA -c "$1" 2>"$TMP_DIR/psql.err" \
    | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | head -n 1
}

echo "ShopFlow cancellation verification"
echo "api=$API_URL notifications=$NOTIFICATION_URL web=$WEB_URL"
echo "repository=$SCRIPT_DIR/.."

# --- 0. stack is up and deterministic ---------------------------------------
section "0. stack readiness"
wait_for "$API_URL/health" "api health"
wait_for "$NOTIFICATION_URL/health" "notification emulator health"
wait_for "$WEB_URL/" "storefront"

request GET "$API_URL/health"
check "api /health returns 200" 200 "$STATUS"

if [ "$DB_MODE" = "run" ]; then
  request GET "$API_URL/products"
  PRODUCTS=$BODY
  check "fresh stack: product-a stock is 10" 10 "$(product_stock "$PRODUCTS" product-a)"
  check "fresh stack: product-b stock is 5" 5 "$(product_stock "$PRODUCTS" product-b)"
  if [ "$(product_stock "$PRODUCTS" product-a)" != "10" ]; then
    note "stock is not in seed state - recreate the stack with 'docker compose down -v' for a deterministic run"
  fi
else
  skip "fresh seed stock check (docker CLI unavailable)"
fi

# --- 1. schema ---------------------------------------------------------------
section "1. schema allows CANCELLED and stores cancellation columns"
if [ "$DB_MODE" = "run" ]; then
  check "orders has cancelled_at and cancellation_reason columns" 2 \
    "$(sql "SELECT count(*) FROM information_schema.columns WHERE table_name='orders' AND column_name IN ('cancelled_at','cancellation_reason')")"
  check "orders status CHECK constraint includes CANCELLED" 1 \
    "$(sql "SELECT count(*) FROM pg_constraint WHERE conrelid='orders'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%CANCELLED%'")"
  check "cancelled_at is nullable TIMESTAMPTZ" "timestamp with time zone|YES" \
    "$(sql "SELECT data_type || '|' || is_nullable FROM information_schema.columns WHERE table_name='orders' AND column_name='cancelled_at'")"
  check "cancellation_reason is nullable TEXT" "text|YES" \
    "$(sql "SELECT data_type || '|' || is_nullable FROM information_schema.columns WHERE table_name='orders' AND column_name='cancellation_reason'")"
  check "products table still has 2 seed rows" 2 "$(sql "SELECT count(*) FROM products")"
else
  skip "schema assertions (docker CLI unavailable)"
fi

# --- scenario 1: create order ------------------------------------------------
section "scenario 1. create order decrements stock and records ORDER_CONFIRMATION"
request POST "$API_URL/orders" '{"productId":"product-a","quantity":2,"customerEmail":"buyer@example.com"}'
check "POST /orders returns 201" 201 "$STATUS"
ORDER_ID=$(json_string "$BODY" id)
check_present "order has an id" "$ORDER_ID"
check "order status is CONFIRMED" CONFIRMED "$(json_string "$BODY" status)"
check "order productId is product-a" product-a "$(json_string "$BODY" productId)"
check "order quantity is 2" 2 "$(json_raw "$BODY" quantity)"
check "order totalCents is 2400" 2400 "$(json_raw "$BODY" totalCents)"
check "cancelledAt is null" null "$(json_raw "$BODY" cancelledAt)"
check "cancellationReason is null" null "$(json_raw "$BODY" cancellationReason)"

request GET "$API_URL/products"
PRODUCTS=$BODY
check "product-a stock decremented to 8" 8 "$(product_stock "$PRODUCTS" product-a)"

request GET "$NOTIFICATION_URL/notifications"
NOTIFS=$BODY
check "exactly one ORDER_CONFIRMATION for the order" 1 "$(notif_count ORDER_CONFIRMATION "$ORDER_ID")"
check "no ORDER_CANCELLATION yet" 0 "$(notif_count ORDER_CANCELLATION)"

# --- scenario 2: cancel ------------------------------------------------------
section "scenario 2. cancel restores stock and records ORDER_CANCELLATION"
request POST "$API_URL/orders/$ORDER_ID/cancel" '{"reason":"changed my mind"}'
check "cancel returns 200" 200 "$STATUS"
check "status is CANCELLED" CANCELLED "$(json_string "$BODY" status)"
CANCELLED_AT=$(json_string "$BODY" cancelledAt)
check_present "cancelledAt is non-null" "$CANCELLED_AT"
check "cancellationReason is 'changed my mind'" "changed my mind" "$(json_string "$BODY" cancellationReason)"

request GET "$API_URL/products"
PRODUCTS=$BODY
check "product-a stock restored to 10" 10 "$(product_stock "$PRODUCTS" product-a)"

request GET "$NOTIFICATION_URL/notifications"
NOTIFS=$BODY
check "exactly one ORDER_CANCELLATION for the order" 1 "$(notif_count ORDER_CANCELLATION "$ORDER_ID")"
check "the ORDER_CANCELLATION carries the reason" 1 "$(notif_reason_count "$ORDER_ID" "changed my mind")"
check "still exactly one ORDER_CONFIRMATION for the order" 1 "$(notif_count ORDER_CONFIRMATION "$ORDER_ID")"

request GET "$API_URL/orders/$ORDER_ID"
check "GET /orders/:id status is CANCELLED" CANCELLED "$(json_string "$BODY" status)"
check "GET /orders/:id keeps cancelledAt" "$CANCELLED_AT" "$(json_string "$BODY" cancelledAt)"
check "GET /orders/:id keeps cancellationReason" "changed my mind" "$(json_string "$BODY" cancellationReason)"

# --- scenario 3: repeated cancel is an idempotent no-op ----------------------
section "scenario 3. repeated cancel restores stock and notifies exactly once"
request POST "$API_URL/orders/$ORDER_ID/cancel" '{"reason":"changed my mind"}'
check "second cancel returns 200" 200 "$STATUS"
check "second cancel keeps status CANCELLED" CANCELLED "$(json_string "$BODY" status)"
check "second cancel keeps the original cancelledAt" "$CANCELLED_AT" "$(json_string "$BODY" cancelledAt)"
check "second cancel keeps the original reason" "changed my mind" "$(json_string "$BODY" cancellationReason)"

request GET "$API_URL/products"
PRODUCTS=$BODY
check "product-a stock is still 10 (restored exactly once)" 10 "$(product_stock "$PRODUCTS" product-a)"

request GET "$NOTIFICATION_URL/notifications"
NOTIFS=$BODY
check "still exactly one ORDER_CANCELLATION for the order" 1 "$(notif_count ORDER_CANCELLATION "$ORDER_ID")"
check "still exactly one ORDER_CONFIRMATION for the order" 1 "$(notif_count ORDER_CONFIRMATION "$ORDER_ID")"

# --- scenario 4: reason validation ------------------------------------------
section "scenario 4. invalid reasons are rejected without side effects"
request POST "$API_URL/orders" '{"productId":"product-a","quantity":1,"customerEmail":"buyer@example.com"}'
check "fresh order 1 returns 201" 201 "$STATUS"
EMPTY_ORDER_ID=$(json_string "$BODY" id)
check_present "fresh order 1 has an id" "$EMPTY_ORDER_ID"

request POST "$API_URL/orders" '{"productId":"product-a","quantity":1,"customerEmail":"buyer@example.com"}'
check "fresh order 2 returns 201" 201 "$STATUS"
LONG_ORDER_ID=$(json_string "$BODY" id)
check_present "fresh order 2 has an id" "$LONG_ORDER_ID"

request GET "$API_URL/products"
PRODUCTS=$BODY
STOCK_BEFORE_INVALID=$(product_stock "$PRODUCTS" product-a)
check "product-a stock is 8 after two fresh orders" 8 "$STOCK_BEFORE_INVALID"

request POST "$API_URL/orders/$EMPTY_ORDER_ID/cancel" '{"reason":""}'
check "empty reason returns 400" 400 "$STATUS"
check "empty reason error code is INVALID" INVALID "$(json_string "$BODY" code)"

LONG_REASON=$(awk 'BEGIN { for (i = 0; i < 201; i++) printf "a" }')
request POST "$API_URL/orders/$LONG_ORDER_ID/cancel" "{\"reason\":\"$LONG_REASON\"}"
check "201-character reason returns 400" 400 "$STATUS"
check "201-character reason error code is INVALID" INVALID "$(json_string "$BODY" code)"

request GET "$API_URL/products"
PRODUCTS=$BODY
check "product-a stock unchanged by rejected cancels" "$STOCK_BEFORE_INVALID" "$(product_stock "$PRODUCTS" product-a)"

request GET "$API_URL/orders/$EMPTY_ORDER_ID"
check "order 1 is still CONFIRMED" CONFIRMED "$(json_string "$BODY" status)"
check "order 1 has no cancellationReason" null "$(json_raw "$BODY" cancellationReason)"

request GET "$API_URL/orders/$LONG_ORDER_ID"
check "order 2 is still CONFIRMED" CONFIRMED "$(json_string "$BODY" status)"
check "order 2 has no cancellationReason" null "$(json_raw "$BODY" cancellationReason)"

request GET "$NOTIFICATION_URL/notifications"
NOTIFS=$BODY
check "no ORDER_CANCELLATION for the empty-reason order" 0 "$(notif_count ORDER_CANCELLATION "$EMPTY_ORDER_ID")"
check "no ORDER_CANCELLATION for the long-reason order" 0 "$(notif_count ORDER_CANCELLATION "$LONG_ORDER_ID")"

# --- scenario 5: shipped orders cannot be cancelled -------------------------
section "scenario 5. shipped order cannot be cancelled"
request POST "$API_URL/orders" '{"productId":"product-a","quantity":2,"customerEmail":"buyer@example.com"}'
check "shipping candidate returns 201" 201 "$STATUS"
SHIPPED_ORDER_ID=$(json_string "$BODY" id)
check_present "shipping candidate has an id" "$SHIPPED_ORDER_ID"

request POST "$API_URL/admin/orders/$SHIPPED_ORDER_ID/ship" '{}'
check "ship returns 200" 200 "$STATUS"
check "shipped status is SHIPPED" SHIPPED "$(json_string "$BODY" status)"

request GET "$API_URL/products"
PRODUCTS=$BODY
STOCK_BEFORE_CONFLICT=$(product_stock "$PRODUCTS" product-a)
check "product-a stock is 6 after shipping" 6 "$STOCK_BEFORE_CONFLICT"

request POST "$API_URL/orders/$SHIPPED_ORDER_ID/cancel" '{"reason":"too late"}'
check "cancelling a shipped order returns 409" 409 "$STATUS"
check "shipped conflict error code is INVALID_STATUS" INVALID_STATUS "$(json_string "$BODY" code)"

request GET "$API_URL/products"
PRODUCTS=$BODY
check "stock not restored for the shipped order" "$STOCK_BEFORE_CONFLICT" "$(product_stock "$PRODUCTS" product-a)"

request GET "$API_URL/orders/$SHIPPED_ORDER_ID"
check "shipped order stays SHIPPED" SHIPPED "$(json_string "$BODY" status)"

request GET "$NOTIFICATION_URL/notifications"
NOTIFS=$BODY
check "no ORDER_CANCELLATION for the shipped order" 0 "$(notif_count ORDER_CANCELLATION "$SHIPPED_ORDER_ID")"
check "exactly one ORDER_CONFIRMATION for the shipped order" 1 "$(notif_count ORDER_CONFIRMATION "$SHIPPED_ORDER_ID")"

# --- scenario 6: unknown order ----------------------------------------------
section "scenario 6. cancelling an unknown order returns 404"
UNKNOWN_ID="11111111-1111-1111-1111-111111111111"
request POST "$API_URL/orders/$UNKNOWN_ID/cancel" '{"reason":"changed my mind"}'
check "unknown order cancel returns 404" 404 "$STATUS"
check "unknown order error code is NOT_FOUND" NOT_FOUND "$(json_string "$BODY" code)"

# --- scenario 7: concurrent cancels -----------------------------------------
section "scenario 7. concurrent cancels restore stock and notify exactly once"
request POST "$API_URL/orders" '{"productId":"product-a","quantity":2,"customerEmail":"buyer@example.com"}'
check "concurrent candidate returns 201" 201 "$STATUS"
CONCURRENT_ORDER_ID=$(json_string "$BODY" id)
check_present "concurrent candidate has an id" "$CONCURRENT_ORDER_ID"

request GET "$API_URL/products"
PRODUCTS=$BODY
check "product-a stock is 4 before the concurrent cancels" 4 "$(product_stock "$PRODUCTS" product-a)"

CONC_A="$TMP_DIR/conc-a"
CONC_B="$TMP_DIR/conc-b"
curl -sS -o "$CONC_A.body" -w '%{http_code}' -X POST -H 'content-type: application/json' \
  --data '{"reason":"race one"}' "$API_URL/orders/$CONCURRENT_ORDER_ID/cancel" >"$CONC_A.status" 2>/dev/null &
PID_A=$!
curl -sS -o "$CONC_B.body" -w '%{http_code}' -X POST -H 'content-type: application/json' \
  --data '{"reason":"race two"}' "$API_URL/orders/$CONCURRENT_ORDER_ID/cancel" >"$CONC_B.status" 2>/dev/null &
PID_B=$!
wait "$PID_A"
wait "$PID_B"

STATUS_A=$(cat "$CONC_A.status" 2>/dev/null)
STATUS_B=$(cat "$CONC_B.status" 2>/dev/null)
check "first concurrent cancel returns 200" 200 "$STATUS_A"
check "second concurrent cancel returns 200" 200 "$STATUS_B"

request GET "$API_URL/orders/$CONCURRENT_ORDER_ID"
check "concurrently cancelled order is CANCELLED" CANCELLED "$(json_string "$BODY" status)"
check_present "concurrently cancelled order has cancelledAt" "$(json_string "$BODY" cancelledAt)"

request GET "$API_URL/products"
PRODUCTS=$BODY
check "product-a stock restored exactly once (back to 6)" 6 "$(product_stock "$PRODUCTS" product-a)"

request GET "$NOTIFICATION_URL/notifications"
NOTIFS=$BODY
check "exactly one ORDER_CANCELLATION after the concurrent cancels" 1 "$(notif_count ORDER_CANCELLATION "$CONCURRENT_ORDER_ID")"

# --- notification emulator contract -----------------------------------------
section "notification emulator contract"
request POST "$NOTIFICATION_URL/notifications" '{"type":"ORDER_CONFIRMATION"}'
check "missing orderId returns 400" 400 "$STATUS"

request POST "$NOTIFICATION_URL/notifications" '{"orderId":"22222222-2222-2222-2222-222222222222"}'
check "missing type returns 400" 400 "$STATUS"

request POST "$NOTIFICATION_URL/notifications" '{"type":"ORDER_PIGEON","orderId":"22222222-2222-2222-2222-222222222222"}'
check "unknown type returns 400" 400 "$STATUS"

request POST "$NOTIFICATION_URL/notifications" '{"type":"ORDER_CONFIRMATION","orderId":"33333333-3333-3333-3333-333333333333","customerEmail":"buyer@example.com"}'
check "raw ORDER_CONFIRMATION returns 201" 201 "$STATUS"
has "raw ORDER_CONFIRMATION record is stored with an id" "$BODY" '"id":"notification-'
check "raw ORDER_CONFIRMATION record keeps its type" ORDER_CONFIRMATION "$(json_string "$BODY" type)"

request POST "$NOTIFICATION_URL/notifications" '{"type":"ORDER_CANCELLATION","orderId":"44444444-4444-4444-4444-444444444444","customerEmail":"buyer@example.com","reason":"changed my mind"}'
check "raw ORDER_CANCELLATION returns 201" 201 "$STATUS"
has "raw ORDER_CANCELLATION record is stored with an id" "$BODY" '"id":"notification-'
check "raw ORDER_CANCELLATION record keeps its type" ORDER_CANCELLATION "$(json_string "$BODY" type)"
check "raw ORDER_CANCELLATION record keeps its reason" "changed my mind" "$(json_string "$BODY" reason)"

request GET "$NOTIFICATION_URL/notifications"
NOTIFS=$BODY
check "emulator still lists both message types" 1 "$(notif_count ORDER_CANCELLATION "44444444-4444-4444-4444-444444444444")"

# --- scenario 8: storefront -------------------------------------------------
section "scenario 8. storefront is served"
request GET "$WEB_URL/"
check "web / returns 200" 200 "$STATUS"
has "served bundle is the storefront shell" "$BODY" 'id="root"'
note "the cancel action itself is a browser-level check; without a browser this script only proves the storefront bundle is served (shopflow-web unit tests cover the UI)"

# --- summary ----------------------------------------------------------------
section "summary"
echo "assertions passed: $PASSED"
echo "assertions failed: $FAILED"
echo "assertions skipped: $SKIPPED"

if [ "$FAILED" -ne 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi

echo "RESULT: PASS"
exit 0
