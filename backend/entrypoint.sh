#!/bin/sh
set -e

echo "[entrypoint] Running Alembic migrations..."
cd /app
python -m alembic -c db/alembic.ini upgrade head

echo "[entrypoint] Starting application..."
exec "$@"
