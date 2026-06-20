#!/usr/bin/env bash
# deploy.sh — Deploy a PRODUCCIÓN (rama main, /opt/mutualyf en el VPS).
#
# Reemplaza la secuencia manual (git pull + restart/rebuild + migraciones +
# health checks). Hace SOLO lo que hace falta según qué archivos cambiaron.
#
# Uso (en el VPS):
#   cd /opt/mutualyf && bash scripts/deploy.sh
#   RUN_MIGRATIONS=1 bash scripts/deploy.sh   # si hay migración nueva y la querés aplicar
#
# Diseño:
#   - Aborta si hay cambios sin commitear (hot-fixes) — no los pisa.
#   - Backend bind-monteado -> restart (sin rebuild). Frontend horneado -> rebuild.
#   - nginx: valida con `nginx -t` ANTES de recrear (gotcha inode).
#   - Migraciones (base COMPARTIDA prod<->staging): NO se corren por defecto;
#     requieren RUN_MIGRATIONS=1 explícito.
#   - Health checks al final; si fallan, imprime el comando de rollback.

set -euo pipefail

DIR="/opt/mutualyf"
BRANCH="main"
COMPOSE="docker compose -f $DIR/docker-compose.yml -f $DIR/docker-compose.prod.yml"
SITE_HOST="intellix.com.ar"

cd "$DIR"

log() { echo ""; echo "▶ $*"; }
ok()  { echo "  ✓ $*"; }
warn(){ echo "  ⚠ $*"; }
die() { echo "  ✗ ERROR: $*" >&2; exit 1; }

# ── 0. Pre-flight ──────────────────────────────────────────────────────────────
log "Pre-flight"
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || die "No estás en la rama '$BRANCH'."
# Drift = cambios sin commitear (ignoramos respaldos locales conocidos).
DRIFT="$(git status --porcelain | grep -vE '\.env\.bak|whatsapp_cols_backup' || true)"
if [ -n "$DRIFT" ]; then
    echo "$DRIFT"
    die "Hay cambios sin commitear en el VPS (¿hot-fixes?). Rescatalos a git antes de deployar."
fi
ROLLBACK_SHA="$(git rev-parse HEAD)"
ok "rama '$BRANCH', sin drift. Commit actual: ${ROLLBACK_SHA:0:7}"

# ── 1. ¿Hay algo nuevo? ─────────────────────────────────────────────────────────
log "Buscando cambios en origin/$BRANCH"
git fetch origin "$BRANCH" -q
NEW_SHA="$(git rev-parse "origin/$BRANCH")"
if [ "$ROLLBACK_SHA" = "$NEW_SHA" ]; then
    ok "Ya está al día (${NEW_SHA:0:7}). Nada que deployar."
    exit 0
fi
CHANGED="$(git diff --name-only "$ROLLBACK_SHA" "$NEW_SHA")"
echo "  Archivos cambiados:"; echo "$CHANGED" | sed 's/^/    /'

# ── 2. Pull ─────────────────────────────────────────────────────────────────────
log "Actualizando código (${ROLLBACK_SHA:0:7} → ${NEW_SHA:0:7})"
git pull --ff-only origin "$BRANCH" || die "git pull falló (divergencia/drift)."
ok "código actualizado"

# ── 3. Migraciones — gate consciente (base compartida) ─────────────────────────
if echo "$CHANGED" | grep -q "backend/db/migrations/versions/"; then
    log "Migración(es) nueva(s) detectada(s):"
    echo "$CHANGED" | grep "backend/db/migrations/versions/" | sed 's/^/    /'
    if [ "${RUN_MIGRATIONS:-0}" = "1" ]; then
        echo "  Aplicando (RUN_MIGRATIONS=1)..."
        $COMPOSE restart backend >/dev/null
        sleep 5
        docker exec ia_backend alembic -c /app/db/alembic.ini upgrade head || die "migración falló."
        ok "migración aplicada"
    else
        warn "NO aplicada (por seguridad)."
        echo "    Base COMPARTIDA prod<->staging: confirmá que staging tenga el archivo,"
        echo "    hacé respaldo si la migración dropea datos, y re-corré con:"
        echo "        RUN_MIGRATIONS=1 bash scripts/deploy.sh"
        echo "    (el deploy sigue; el backend levanta igual con el código nuevo)"
    fi
fi

# ── 4. Backend (bind-mount → restart) ──────────────────────────────────────────
if echo "$CHANGED" | grep -qE "^backend/"; then
    log "Reiniciando backend + celery (bind-mount, sin rebuild)"
    $COMPOSE restart backend celery_worker celery_beat >/dev/null
    ok "backend/celery reiniciados"
fi

# ── 5. Frontend (horneado → rebuild) ───────────────────────────────────────────
if echo "$CHANGED" | grep -qE "^frontend/"; then
    log "Rebuild frontend (sin downtime hasta el swap)"
    $COMPOSE build frontend
    $COMPOSE up -d --no-deps frontend >/dev/null
    ok "frontend actualizado"
fi

# ── 6. nginx (validar ANTES de recrear — gotcha inode) ─────────────────────────
if echo "$CHANGED" | grep -q "nginx/nginx.prod.conf"; then
    log "Validando y recreando nginx"
    docker cp "$DIR/nginx/nginx.prod.conf" ia_nginx:/tmp/new_nginx.conf
    docker exec ia_nginx nginx -t -c /tmp/new_nginx.conf || die "nginx config inválida — NO se recreó."
    $COMPOSE up -d --no-deps --force-recreate nginx >/dev/null
    ok "nginx recreado (config validada)"
fi

# ── 7. Health checks ───────────────────────────────────────────────────────────
log "Health checks"
HEALTHY=0
for i in $(seq 1 20); do
    if docker exec ia_backend curl -sf http://localhost:8000/health >/dev/null 2>&1; then
        HEALTHY=1; break
    fi
    sleep 3
done
if [ "$HEALTHY" != "1" ]; then
    echo "  ✗ backend NO responde tras el deploy."
    echo "  ROLLBACK:  git reset --hard $ROLLBACK_SHA  &&  $COMPOSE restart backend celery_worker celery_beat"
    die "health check del backend falló."
fi
ok "backend healthy"
CODE="$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$SITE_HOST:443:127.0.0.1" "https://$SITE_HOST/" || echo 000)"
[ "$CODE" = "200" ] && ok "sitio $SITE_HOST → 200" || warn "sitio devolvió $CODE (revisar)"

# ── Resumen ─────────────────────────────────────────────────────────────────────
log "DEPLOY OK  ${ROLLBACK_SHA:0:7} → ${NEW_SHA:0:7}"
echo "  Rollback si hiciera falta:"
echo "    cd $DIR && git reset --hard $ROLLBACK_SHA && $COMPOSE restart backend celery_worker celery_beat"
echo ""
