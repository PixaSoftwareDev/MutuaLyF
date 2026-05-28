#!/usr/bin/env bash
# deploy-staging.sh — Build y deploy al ambiente de staging
#
# Flujo:
#   1. git pull
#   2. Build de imágenes (backend + frontend)
#   3. Levantar/reiniciar staging (sin tocar producción)
#   4. Correr migraciones en staging
#   5. Provisionar tenant "staging" si no existe
#
# Uso: bash scripts/deploy-staging.sh
# Desde el VPS: cd /opt/mutualyf && bash scripts/deploy-staging.sh

set -euo pipefail

COMPOSE_BASE="-f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.staging.yml"
STAGING_SERVICES="backend_staging celery_staging frontend_staging"

echo ""
echo "══════════════════════════════════════════════"
echo "  DEPLOY STAGING"
echo "══════════════════════════════════════════════"

# ── 1. Pull código ────────────────────────────────
echo ""
echo "▶ 1/5  git pull..."
git pull origin main

# ── 2. Build imágenes ─────────────────────────────
echo ""
echo "▶ 2/5  Build backend + frontend..."
docker compose $COMPOSE_BASE build backend_staging celery_staging frontend_staging

# ── 3. Levantar staging ───────────────────────────
echo ""
echo "▶ 3/5  Levantando servicios de staging..."
docker compose $COMPOSE_BASE up -d $STAGING_SERVICES

# Recargar nginx para activar puerto 8080 (si ya estaba corriendo)
echo "       Recargando nginx..."
docker compose $COMPOSE_BASE up -d nginx
docker exec ia_nginx nginx -s reload 2>/dev/null || true

# ── 4. Esperar a que el backend esté listo ────────
echo ""
echo "▶ 4/5  Esperando backend_staging..."
for i in $(seq 1 20); do
    if docker exec ia_backend_staging curl -sf http://localhost:8000/health > /dev/null 2>&1; then
        echo "       ✓ backend_staging listo"
        break
    fi
    echo "       ... intento $i/20"
    sleep 5
done

# ── 5. Migraciones + tenant staging ──────────────
echo ""
echo "▶ 5/5  Migraciones Alembic en staging..."
docker exec ia_backend_staging alembic -c /app/db/alembic.ini upgrade head

# Provisionar tenant "staging" solo si no existe
# Leemos las credenciales del .env y consultamos directamente a postgres
echo ""
echo "       Verificando tenant 'staging'..."
PG_USER=$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2 | tr -d '"' | tr -d "'")
PG_DB=$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2 | tr -d '"' | tr -d "'")
PG_USER="${PG_USER:-postgres}"
PG_DB="${PG_DB:-platform}"
TENANT_EXISTS=$(docker exec ia_postgres psql -U "$PG_USER" -d "$PG_DB" -tAc \
    "SELECT COUNT(*) FROM tenants WHERE id='staging'" 2>/dev/null | tr -d ' ' || echo "0")

if [ "$TENANT_EXISTS" = "0" ]; then
    echo "       Provisionando tenant 'staging' por primera vez..."
    docker exec ia_backend_staging python provision_tenant.py \
        --id staging \
        --name "Staging" \
        --plan professional \
        --admin-email staging@interno.local \
        --admin-password "StagingPass123!" \
        --admin-name "Admin Staging"
    echo "       ✓ Tenant 'staging' creado"
    echo "       ✓ Login staging: staging@interno.local / StagingPass123!"
else
    echo "       ✓ Tenant 'staging' ya existe, saltando"
fi

# ── Resumen ───────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo "  STAGING LISTO"
echo "  Acceso (SSH tunnel):"
echo "  ssh -L 8080:127.0.0.1:8080 root@200.58.109.110 -p 2251"
echo "  → http://localhost:8080"
echo ""
echo "  Credenciales staging:"
echo "  staging@interno.local / StagingPass123!"
echo ""
echo "  Para promover a producción:"
echo "  bash scripts/promote-to-prod.sh"
echo "══════════════════════════════════════════════"
