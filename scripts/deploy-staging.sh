#!/usr/bin/env bash
# deploy-staging.sh — Actualizar el entorno de staging con el último código.
#
# Qué hace:
#   1. git fetch + ff-only del worktree de STAGING (/opt/mutualyf-staging, rama dev).
#      NUNCA toca el checkout de prod (/opt/mutualyf) — ese solo lo mueve el
#      deploy de producción.
#   2. Rebuild y restart de backend_staging + frontend_staging (--no-deps:
#      no reinicia servicios compartidos con prod).
#   3. Guard de migraciones: staging COMPARTE la base Postgres con prod, así
#      que acá NUNCA se corre `alembic upgrade` — una migración desde staging
#      cambiaría el schema de producción. Si hay migraciones pendientes se
#      avisa fuerte y quedan para el deploy de prod.
#   4. Health check
#
# Para promover a producción después: bash scripts/promote-to-prod.sh

set -euo pipefail

PROD_DIR="/opt/mutualyf"
STAGING_DIR="/opt/mutualyf-staging"
STAGING_BRANCH="dev"
COMPOSE="docker compose -f $PROD_DIR/docker-compose.yml -f $PROD_DIR/docker-compose.staging.yml"

echo ""
echo "══════════════════════════════════════════════"
echo "  DEPLOY → STAGING"
echo "══════════════════════════════════════════════"

# ── 1. Actualizar el worktree de staging ──────────
echo ""
echo "▶ 1/4  Actualizando código de staging ($STAGING_DIR, rama $STAGING_BRANCH)..."
git -C "$STAGING_DIR" fetch origin
git -C "$STAGING_DIR" checkout "$STAGING_BRANCH" --quiet
git -C "$STAGING_DIR" merge --ff-only "origin/$STAGING_BRANCH"
echo "       staging HEAD = $(git -C "$STAGING_DIR" rev-parse --short HEAD)"
echo "       prod    HEAD = $(git -C "$PROD_DIR" rev-parse --short HEAD) (sin tocar)"

# ── 2. Rebuild staging ────────────────────────────
echo ""
echo "▶ 2/4  Rebuilding staging (backend + frontend)..."
$COMPOSE build backend_staging frontend_staging

echo "       Reiniciando containers de staging..."
$COMPOSE up -d --no-deps backend_staging frontend_staging

# ── 3. Esperar backend + guard de migraciones ─────
echo ""
echo "▶ 3/4  Esperando backend_staging..."
for i in $(seq 1 24); do
    if docker exec ia_backend_staging curl -sf http://localhost:8000/health > /dev/null 2>&1; then
        echo "       ✓ backend_staging listo (${i}x5s)"
        break
    fi
    if [ "$i" -eq 24 ]; then
        echo "  ✗ ERROR: backend_staging no levantó en 2 minutos."
        docker logs ia_backend_staging --tail 30
        exit 1
    fi
    sleep 5
done

# Guard: detectar migraciones pendientes SIN aplicarlas. La base es compartida
# con prod — migrar desde staging cambiaría el schema de producción.
echo "       Verificando migraciones (solo lectura)..."
CURRENT=$(docker exec ia_backend_staging alembic -c /app/db/alembic.ini current 2>/dev/null | grep -oE '^[0-9a-f]+' | sort | tr '\n' ' ' || true)
HEADS=$(docker exec ia_backend_staging alembic -c /app/db/alembic.ini heads 2>/dev/null | grep -oE '^[0-9a-f]+' | sort | tr '\n' ' ' || true)
if [ "$CURRENT" != "$HEADS" ]; then
    echo ""
    echo "  ⚠⚠⚠  MIGRACIONES PENDIENTES — NO SE APLICARON  ⚠⚠⚠"
    echo "  La base Postgres es COMPARTIDA con producción: las migraciones se"
    echo "  aplican únicamente durante el deploy de prod (deploy.sh)."
    echo "  current: ${CURRENT:-<vacío>}   heads: ${HEADS:-<vacío>}"
    echo "  El código nuevo puede fallar si depende del schema nuevo — probá"
    echo "  igual, pero promové a prod antes de confiar en esas features."
    echo ""
else
    echo "       ✓ Sin migraciones pendientes (schema al día con el código)."
fi

# ── 4. Health check ───────────────────────────────
echo ""
echo "▶ 4/4  Health check final..."
sleep 2
if docker exec ia_backend_staging curl -sf http://localhost:8000/health > /dev/null 2>&1; then
    STATUS="✓ Staging saludable"
else
    STATUS="⚠ backend_staging no responde — revisá: docker logs ia_backend_staging --tail 50"
fi

echo ""
echo "══════════════════════════════════════════════"
echo "  STAGING ACTUALIZADO"
echo "  $STATUS"
echo ""
echo "  Probá en: https://dev.intellix.com.ar"
echo "  Logs:     docker logs ia_backend_staging --tail 50 -f"
echo ""
echo "  Para promover a prod:"
echo "  bash $PROD_DIR/scripts/promote-to-prod.sh"
echo "══════════════════════════════════════════════"
