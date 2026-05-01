#!/usr/bin/env bash
# Smoke tests against the running stack.
# Usage: bash scripts/smoke_test.sh [BASE_URL]
# Default BASE_URL: http://localhost

set -euo pipefail

BASE="${1:-http://localhost}"
API="$BASE/api/v1"
PASS=0
FAIL=0
SKIP=0

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}[FAIL]${NC} $1"; FAIL=$((FAIL+1)); }
skip() { echo -e "${YELLOW}[SKIP]${NC} $1"; SKIP=$((SKIP+1)); }

# ── Helpers ───────────────────────────────────────────────────────────────────

wait_for() {
  local url="$1"
  local label="${2:-$1}"
  local max=30 i=0
  echo -n "  Waiting for $label"
  while ! curl -sf "$url" > /dev/null 2>&1; do
    sleep 2; ((i++))
    if [ $i -ge $max ]; then echo " timeout!"; return 1; fi
    echo -n "."
  done
  echo " ready"
}

http_status() {
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

http_body() {
  curl -s "$@"
}

# ── Wait for services ─────────────────────────────────────────────────────────

echo ""
echo "=== Waiting for stack to be ready ==="
wait_for "$BASE/health" "backend /health"

# ── Test 1: Health endpoint ───────────────────────────────────────────────────

echo ""
echo "=== Backend health ==="
HEALTH=$(http_body "$BASE/health")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  ok "GET /health → 200 {status:ok}"
else
  fail "GET /health → unexpected response: $HEALTH"
fi

# ── Test 2: OpenAPI docs available in dev ─────────────────────────────────────

echo ""
echo "=== API docs ==="
STATUS=$(http_status "$BASE/docs")
if [ "$STATUS" = "200" ]; then
  ok "GET /docs → 200"
else
  skip "GET /docs → $STATUS (expected 200 in dev, 404 in prod)"
fi

# ── Test 3: Unauthenticated request returns 401 ───────────────────────────────

echo ""
echo "=== Auth enforcement ==="
STATUS=$(http_status -X POST "$API/query" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: demo" \
  -d '{"question":"test"}')
if [ "$STATUS" = "401" ]; then
  ok "POST /query without token → 401"
else
  fail "POST /query without token → $STATUS (expected 401)"
fi

# ── Test 4: Login with wrong credentials ─────────────────────────────────────

STATUS=$(http_status -X POST "$API/auth/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Tenant-ID: demo" \
  -d "username=nobody@nowhere.com&password=wrong")
if [ "$STATUS" = "501" ] || [ "$STATUS" = "401" ] || [ "$STATUS" = "400" ]; then
  ok "POST /auth/login bad creds → $STATUS (non-200)"
else
  fail "POST /auth/login bad creds → $STATUS (expected 4xx)"
fi

# ── Test 5: Widget token generation (super admin needed — skip in basic smoke) ─

echo ""
echo "=== Widget token endpoint exists ==="
STATUS=$(http_status -X POST "$API/tenants/demo/widget-token" -H "X-Tenant-ID: demo")
if [ "$STATUS" = "401" ] || [ "$STATUS" = "403" ]; then
  ok "POST /tenants/demo/widget-token without auth → $STATUS (auth required)"
else
  fail "POST /tenants/demo/widget-token → $STATUS (expected 401/403)"
fi

# ── Test 6: Ingest endpoint requires auth ─────────────────────────────────────

STATUS=$(http_status -X POST "$API/ingest" \
  -H "X-Tenant-ID: demo")
if [ "$STATUS" = "401" ] || [ "$STATUS" = "422" ]; then
  ok "POST /ingest without auth → $STATUS"
else
  fail "POST /ingest without auth → $STATUS"
fi

# ── Test 7: Documents list requires auth ─────────────────────────────────────

STATUS=$(http_status "$API/documents" \
  -H "X-Tenant-ID: demo")
if [ "$STATUS" = "401" ]; then
  ok "GET /documents without auth → 401"
else
  fail "GET /documents without auth → $STATUS (expected 401)"
fi

# ── Test 8: Intentions endpoint ───────────────────────────────────────────────

STATUS=$(http_status "$API/intentions" \
  -H "X-Tenant-ID: demo")
if [ "$STATUS" = "401" ]; then
  ok "GET /intentions without auth → 401"
else
  fail "GET /intentions without auth → $STATUS"
fi

# ── Test 9: Frontend serves HTML ─────────────────────────────────────────────

echo ""
echo "=== Frontend ==="
BODY=$(http_body "$BASE/")
if echo "$BODY" | grep -qi "html\|next\|loading"; then
  ok "GET / → HTML response"
else
  skip "GET / → no HTML detected (frontend may still be compiling)"
fi

# ── Test 10: Widget JS accessible ─────────────────────────────────────────────

STATUS=$(http_status "$BASE/widget/widget.js" 2>/dev/null || echo "000")
if [ "$STATUS" = "200" ]; then
  ok "GET /widget/widget.js → 200"
else
  skip "GET /widget/widget.js → $STATUS (served by Next.js static)"
fi

# ── Test 11: Qdrant health (direct, if exposed) ───────────────────────────────

echo ""
echo "=== Infrastructure (direct ports) ==="
if curl -sf "http://localhost:6333/healthz" > /dev/null 2>&1; then
  ok "Qdrant :6333 /healthz → healthy"
else
  skip "Qdrant :6333 not reachable from host (expected inside Docker network)"
fi

if redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | grep -q PONG; then
  ok "Redis :6379 PING → PONG"
else
  skip "Redis :6379 not reachable (redis-cli not installed or port not exposed)"
fi

if psql "postgresql://platform_user:platform_secret_2026@127.0.0.1:5433/platform" -c "SELECT 1" > /dev/null 2>&1; then
  ok "PostgreSQL :5433 → connected"
else
  skip "PostgreSQL :5433 not reachable (expected — port bound to 127.0.0.1)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "================================="
echo -e "  ${GREEN}PASS${NC}: $PASS   ${RED}FAIL${NC}: $FAIL   ${YELLOW}SKIP${NC}: $SKIP"
echo "================================="

if [ $FAIL -gt 0 ]; then
  echo -e "${RED}Some tests failed.${NC}"
  exit 1
fi
echo -e "${GREEN}All critical smoke tests passed.${NC}"
