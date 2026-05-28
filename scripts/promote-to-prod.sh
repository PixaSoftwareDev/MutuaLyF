#!/usr/bin/env bash
# promote-to-prod.sh — Promover las imágenes de staging a producción
#
# Pre-condición: deploy-staging.sh ya corrió y las imágenes ia_backend:latest
# e ia_frontend:latest están testeadas en staging.
#
# Qué hace:
#   1. Verificar que staging está corriendo (fail-fast si no)
#   2. Reiniciar producción con las mismas imágenes ya buildeadas
#   3. Correr migraciones en producción
#   4. Health check
#   NO hace git pull ni rebuild — usa las imágenes ya construidas por deploy-staging.sh

set -euo pipefail

COMPOSE_PROD="-f docker-compose.yml -f docker-compose.prod.yml"
COMPOSE_ALL="-f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.staging.yml"

echo ""
echo "══════════════════════════════════════════════"
echo "  PROMOTE STAGING → PRODUCCIÓN"
echo "══════════════════════════════════════════════"

# ── Guard: staging debe estar saludable ──────────
echo ""
echo "▶ 1/4  Verificando staging..."
if ! docker exec ia_backend_staging curl -sf http://localhost:8000/health > /dev/null 2>&1; then
    echo "  ✗ ERROR: backend_staging no responde."
    echo "    Corré deploy-staging.sh primero y verificá que staging funciona."
    exit 1
fi
echo "       ✓ Staging OK"

# ── Confirmación manual ───────────────────────────
echo ""
echo "  ⚠  Esto va a reiniciar producción (backend, celery, frontend)."
echo "  ⚠  Producción tendrá ~60 segundos de downtime durante el restart."
echo ""
read -p "  ¿Confirmás la promoción a producción? [s/N]: " CONFIRM
if [[ "$CONFIRM" != "s" && "$CONFIRM" != "S" ]]; then
    echo "  Cancelado."
    exit 0
fi

# ── 2. Reiniciar producción ───────────────────────
echo ""
echo "▶ 2/4  Reiniciando producción (sin rebuild)..."
docker compose $COMPOSE_PROD up -d --no-build backend celery_worker frontend

# Nginx reload para asegurar config correcta
echo "       Recargando nginx..."
docker exec ia_nginx nginx -s reload 2>/dev/null || true

# ── 3. Migraciones producción ─────────────────────
echo ""
echo "▶ 3/4  Esperando backend prod..."
for i in $(seq 1 20); do
    if docker exec ia_backend curl -sf http://localhost:8000/health > /dev/null 2>&1; then
        echo "       ✓ backend prod listo"
        break
    fi
    echo "       ... intento $i/20"
    sleep 5
done

echo ""
echo "       Migraciones Alembic en producción..."
docker exec ia_backend alembic -c /app/db/alembic.ini upgrade head

# ── 4. Health check final ────────────────────────
echo ""
echo "▶ 4/4  Health check final..."
sleep 3
if docker exec ia_backend curl -sf http://localhost:8000/health > /dev/null 2>&1; then
    echo "       ✓ Producción saludable"
else
    echo "  ✗ ADVERTENCIA: backend prod no responde al health check."
    echo "    Revisá los logs: docker logs ia_backend --tail 50"
fi

# ── Resumen ───────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo "  PRODUCCIÓN ACTUALIZADA"
echo ""
echo "  Verificá en: http://200.58.109.110"
echo ""
echo "  Logs producción:"
echo "  docker logs ia_backend --tail 50 -f"
echo "══════════════════════════════════════════════"
