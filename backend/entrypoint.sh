#!/bin/sh
set -e

echo "[entrypoint] Running Alembic migrations..."
cd /app
python -m alembic -c db/alembic.ini upgrade head

echo "[entrypoint] Starting application..."

# UVICORN_WORKERS (opcional): cantidad de procesos worker de uvicorn.
# Sin la variable, arranca con 1 worker (comportamiento histórico, no rompe dev).
# En prod se setea UVICORN_WORKERS=4 para atender consultas en paralelo y evitar
# que el embed local (CPU-bound) bloquee el único event loop bajo carga concurrente.
# Se appendea a $@ (el CMD del Dockerfile) en vez de hardcodearlo allí.
if [ -n "$UVICORN_WORKERS" ]; then
  echo "[entrypoint] uvicorn workers = $UVICORN_WORKERS"
  exec "$@" --workers "$UVICORN_WORKERS"
else
  exec "$@"
fi
