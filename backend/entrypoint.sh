#!/bin/sh
set -e

# Métricas multiproceso (uvicorn 4 workers / Celery prefork): el directorio
# tiene que existir y arrancar VACÍO, si no quedan valores de pids muertos.
if [ -n "${PROMETHEUS_MULTIPROC_DIR:-}" ]; then
    rm -rf "${PROMETHEUS_MULTIPROC_DIR:?}"
    mkdir -p "$PROMETHEUS_MULTIPROC_DIR"
fi

echo "[entrypoint] Running Alembic migrations..."
cd /app
python -m alembic -c db/alembic.ini upgrade head

echo "[entrypoint] Starting application..."
exec "$@"
