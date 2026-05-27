#!/bin/sh
# Container de backup para PostgreSQL.
#
# Estrategia (simple y funcional):
#   - Lunes a Sabado 03:00 → backup DIARIO (retencion 7 dias)
#   - Domingo 02:00       → backup SEMANAL (retencion 4 semanas)
#
# Usa pg_dump (incluido en postgres:16-alpine). Sin WAL archiving en
# esta etapa (requiere imagen postgres custom). RPO en peor caso: 24h.
#
# Naming:
#   /backups/daily-YYYYMMDD-HHMM.dump
#   /backups/weekly-YYYYMMDD-HHMM.dump
#
# Restore:
#   docker exec ia_postgres pg_restore -U platform_user -d platform \
#     --clean --if-exists < /backups/daily-XXXXXXX.dump
set -e

BACKUP_DIR=/var/lib/pgbackrest
DAILY_RETENTION_DAYS=7
WEEKLY_RETENTION_DAYS=28

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly" /var/log/pgbackrest

# Script de backup que el cron va a invocar
cat > /usr/local/bin/do-backup.sh <<'BACKUP_SCRIPT'
#!/bin/sh
set -e
TYPE="$1"  # daily | weekly
BACKUP_DIR=/var/lib/pgbackrest
TS=$(date -u +%Y%m%d-%H%M)
OUT="$BACKUP_DIR/$TYPE/${TYPE}-${TS}.dump"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Iniciando backup $TYPE -> $OUT"

# pg_dump custom format (-Fc): comprimido, restaurable selectivamente con pg_restore
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
  -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -Fc -Z 6 \
  --no-owner --no-acl \
  -f "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)
echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Backup $TYPE completado: $OUT ($SIZE)"

# Rotacion
if [ "$TYPE" = "daily" ]; then
  RETENTION_DAYS=7
else
  RETENTION_DAYS=28
fi
DELETED=$(find "$BACKUP_DIR/$TYPE" -name "${TYPE}-*.dump" -mtime +$RETENTION_DAYS -print -delete | wc -l)
if [ "$DELETED" -gt 0 ]; then
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Rotacion $TYPE: $DELETED backup(s) viejo(s) eliminado(s)"
fi
BACKUP_SCRIPT
chmod +x /usr/local/bin/do-backup.sh

# Cron jobs.
mkdir -p /etc/crontabs
cat > /etc/crontabs/root <<'CRON'
# Backup diario L-S 03:00 UTC (lun=1, mar=2, ..., sab=6)
0 3 * * 1-6 POSTGRES_USER="$POSTGRES_USER" POSTGRES_DB="$POSTGRES_DB" POSTGRES_PASSWORD="$POSTGRES_PASSWORD" /usr/local/bin/do-backup.sh daily
# Backup semanal Dom 02:00 UTC
0 2 * * 0   POSTGRES_USER="$POSTGRES_USER" POSTGRES_DB="$POSTGRES_DB" POSTGRES_PASSWORD="$POSTGRES_PASSWORD" /usr/local/bin/do-backup.sh weekly
CRON

echo "[pgbackrest] Cron configurado:"
cat /etc/crontabs/root
echo

# Si nunca se hizo backup, hacer uno ahora para tener al menos uno desde dia 1
if [ -z "$(ls -A "$BACKUP_DIR/daily" 2>/dev/null)" ] && [ -z "$(ls -A "$BACKUP_DIR/weekly" 2>/dev/null)" ]; then
  echo "[pgbackrest] Sin backups previos — esperando postgres y haciendo backup inicial"
  for i in $(seq 1 30); do
    if PGPASSWORD="$POSTGRES_PASSWORD" pg_isready -h postgres -U "$POSTGRES_USER" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  /usr/local/bin/do-backup.sh daily || echo "[pgbackrest] Backup inicial fallo — el cron reintentara"
fi

# crond en foreground (PID 1) para que docker logs muestre los outputs.
exec crond -f -L /dev/stdout
