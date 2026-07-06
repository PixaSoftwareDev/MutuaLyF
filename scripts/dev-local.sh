#!/usr/bin/env bash
# ============================================================================
# dev-local.sh — Maneja el ambiente de desarrollo LOCAL aislado.
# Todo corre en tu PC, con volúmenes propios. NUNCA toca el VPS ni producción.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker-compose.local.yml --env-file .env.local)

case "${1:-help}" in
  up)
    "${COMPOSE[@]}" up -d --build postgres neo4j qdrant redis minio backend frontend
    echo
    echo "✅ Ambiente local levantado:"
    echo "   Frontend  → http://localhost:3010"
    echo "   Backend   → http://localhost:8010  (docs: /docs · health: /health)"
    echo "   Postgres  → localhost:5440   Neo4j → http://localhost:7475"
    echo "   Qdrant    → http://localhost:6340   MinIO → http://localhost:9011"
    echo
    echo "   Ver arranque del backend (migraciones + uvicorn):"
    echo "     ./scripts/dev-local.sh logs backend"
    ;;
  up-workers)
    "${COMPOSE[@]}" --profile workers up -d --build
    echo "✅ Stack + celery_worker (ingesta habilitada)."
    ;;
  down)
    "${COMPOSE[@]}" --profile workers down
    echo "🛑 Stack local detenido (datos conservados en los volúmenes)."
    ;;
  nuke)
    read -r -p "⚠️  Esto BORRA todos los datos locales (volúmenes). ¿Seguro? [escribí SI] " ok
    [ "$ok" = "SI" ] && "${COMPOSE[@]}" --profile workers down -v && echo "💥 Volúmenes locales borrados." || echo "Cancelado."
    ;;
  migrate)
    "${COMPOSE[@]}" exec backend python -m alembic -c db/alembic.ini upgrade head
    ;;
  makemigration)
    shift
    "${COMPOSE[@]}" exec backend python -m alembic -c db/alembic.ini revision --autogenerate -m "${*:-cambio}"
    ;;
  seed)
    "${COMPOSE[@]}" exec backend python ../scripts/seed_dev.py
    ;;
  logs)
    shift; "${COMPOSE[@]}" logs -f "${@:-}"
    ;;
  ps)
    "${COMPOSE[@]}" ps
    ;;
  psql)
    "${COMPOSE[@]}" exec postgres psql -U platform_user -d platform
    ;;
  *)
    cat <<'HELP'
Uso: ./scripts/dev-local.sh <comando>

  up             Levanta el stack liviano (db + backend + frontend)
  up-workers     Igual + celery_worker (para probar ingesta de documentos)
  down           Detiene todo, conserva los datos
  nuke           Detiene y BORRA los volúmenes locales (reset total)
  migrate        Corre 'alembic upgrade head' en el backend
  makemigration "msg"   Autogenera una migración nueva
  seed           Corre scripts/seed_dev.py
  logs [servicio]       Sigue logs (ej: logs backend)
  ps             Estado de los contenedores
  psql           Abre psql contra la DB local
HELP
    ;;
esac
