#!/usr/bin/env bash
# Backup ÚNICO de PostgreSQL de la plataforma (prod). Corre en el HOST por cron.
#
# Instalación: cp scripts/mutualyf-pg-backup.sh /usr/local/bin/ && chmod +x
# Cron (UTC, el host está en UTC):  30 3 * * * /usr/local/bin/mutualyf-pg-backup.sh
#
# Historia:
#   2026-08-12  reescrito tras 69 días sin backup (el `source .env` moría por
#               un `<` en EMAIL_FROM). Validación + métrica dead-man.
#   2026-08-26  absorbe al contenedor ia_pgbackrest (que hacía un segundo dump
#               en paralelo, sin alerta, pero con semanales y en el formato que
#               lee el panel del super admin). Queda UN solo backup:
#                 - formato custom de pg_dump (-Fc): permite restaurar UN tenant
#                   (`pg_restore -n tenant_x`) sin tocar a los demás
#                 - daily/ (7 días) + weekly/ (8 semanas) en el volumen que
#                   montan el backend (/backups, tarjeta Backups) y postgres
#                   (/var/lib/pgbackrest, para validar y restaurar)
#                 - globals/ con roles del cluster (pg_dumpall --globals-only),
#                   que el formato custom no incluye
#                 - métricas para diario Y semanal → alertas Backup*
#
# Qué NO hace todavía: copia fuera del VPS. Si existe y es ejecutable
# $OFFSITE_HOOK se lo invoca con la ruta del dump; si no, se loguea el faltante.
set -euo pipefail

ENV_FILE="/opt/mutualyf/.env"
PG_CONTAINER="ia_postgres"
VOLUME_NAME="mutualyf_pgbackrest_data"       # nombre histórico; es "el volumen de backups"
IN_CONTAINER_ROOT="/var/lib/pgbackrest"       # mismo volumen visto desde ia_postgres
DAILY_RETENTION_DAYS=7
WEEKLY_RETENTION_DAYS=56
GLOBALS_RETENTION_DAYS=7
MIN_SIZE_BYTES=102400                          # alineado con la alerta BackupDemasiadoChico (<100 KB)
TEXTFILE_DIR="/var/lib/node_exporter/textfile_collector"
METRIC_FILE="$TEXTFILE_DIR/mutualyf_backup.prom"
LOG_FILE="/var/log/mutualyf-backup.log"
OFFSITE_HOOK="/usr/local/bin/mutualyf-backup-offsite.sh"
LEGACY_DIR="/backups/pg"                       # dumps .sql.gz del esquema anterior (hasta 2026-08-26)

# Todo lo que salga (stdout y stderr, incluidas advertencias de pg_dump) va a
# pantalla Y al log, una sola vez. El cron NO debe redirigir al log.
exec > >(tee -a "$LOG_FILE") 2>&1

log() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S')Z] $1"; }
trap 'log "FALLO en la linea $LINENO — NO se genero backup"' ERR

log "=== Iniciando backup ==="

# Lee una variable del .env sin interpretarla (nada de source: los valores
# pueden traer <, >, |, $ y demas, como EMAIL_FROM).
leer_env() {
    local clave="$1" linea valor
    linea=$(grep -m1 -E "^[[:space:]]*${clave}=" "$ENV_FILE") || {
        log "ERROR: falta $clave en $ENV_FILE"; return 1
    }
    valor="${linea#*=}"
    valor="${valor%$'\r'}"
    [[ "$valor" == \"*\" ]] && valor="${valor:1:-1}"
    [[ "$valor" == \'*\' ]] && valor="${valor:1:-1}"
    printf '%s' "$valor"
}

POSTGRES_DB=$(leer_env POSTGRES_DB)
POSTGRES_USER=$(leer_env POSTGRES_USER)
POSTGRES_PASSWORD=$(leer_env POSTGRES_PASSWORD)

# El volumen se resuelve por nombre: si algún día cambia el mountpoint, el
# script sigue apuntando al lugar correcto (y al que lee el panel).
BACKUP_ROOT=$(docker volume inspect "$VOLUME_NAME" --format '{{.Mountpoint}}')
[[ -d "$BACKUP_ROOT" ]] || { log "ERROR: volumen $VOLUME_NAME sin mountpoint"; exit 1; }
mkdir -p "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly" "$BACKUP_ROOT/globals" "$TEXTFILE_DIR"

TS=$(date -u +%Y%m%d-%H%M)
DAILY_OUT="$BACKUP_ROOT/daily/daily-${TS}.dump"
TMP="${DAILY_OUT}.parcial"

# ── 1. Dump en formato custom ─────────────────────────────────────────────────
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$PG_CONTAINER" \
    pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z 6 --no-owner --no-acl \
    > "$TMP"

# ── 2. Validar ANTES de dar nada por bueno ────────────────────────────────────
BYTES=$(stat -c%s "$TMP")
if [[ "$BYTES" -lt "$MIN_SIZE_BYTES" ]]; then
    log "ERROR: dump sospechosamente chico ($BYTES bytes, minimo $MIN_SIZE_BYTES)"
    rm -f "$TMP"; exit 1
fi

# pg_restore -l lee la tabla de contenidos: si el archivo está truncado o
# corrupto, falla. Y de paso contamos los schemas de tenant que trae.
TOC=$(docker exec "$PG_CONTAINER" pg_restore -l "$IN_CONTAINER_ROOT/daily/$(basename "$TMP")") || {
    log "ERROR: pg_restore no puede leer el dump (corrupto o truncado)"
    rm -f "$TMP"; exit 1
}
SCHEMAS=$(printf '%s\n' "$TOC" | grep -cE ' SCHEMA - tenant_' || true)
if [[ "$SCHEMAS" -lt 1 ]]; then
    log "ERROR: el dump no trae schemas de tenant"
    rm -f "$TMP"; exit 1
fi
log "Validado: $SCHEMAS schemas de tenant, $(printf '%s\n' "$TOC" | grep -c '^[0-9]') entradas en el TOC"

mv "$TMP" "$DAILY_OUT"
log "Backup diario OK: $DAILY_OUT ($(du -h "$DAILY_OUT" | cut -f1))"

# ── 3. Roles del cluster (el formato custom no los incluye) ──────────────────
GLOBALS_OUT="$BACKUP_ROOT/globals/globals-${TS}.sql.gz"
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$PG_CONTAINER" \
    pg_dumpall -U "$POSTGRES_USER" --globals-only | gzip -9 > "${GLOBALS_OUT}.parcial"
gzip -t "${GLOBALS_OUT}.parcial" && mv "${GLOBALS_OUT}.parcial" "$GLOBALS_OUT"
log "Roles OK: $GLOBALS_OUT"

# ── 4. Semanal: los domingos el diario se copia a weekly/ ────────────────────
if [[ "$(date -u +%u)" == "7" ]]; then
    WEEKLY_OUT="$BACKUP_ROOT/weekly/weekly-${TS}.dump"
    cp "$DAILY_OUT" "$WEEKLY_OUT"
    log "Backup semanal OK: $WEEKLY_OUT"
fi

# ── 5. Copia fuera del VPS (pendiente de credenciales) ───────────────────────
if [[ -x "$OFFSITE_HOOK" ]]; then
    "$OFFSITE_HOOK" "$DAILY_OUT" && log "Off-site OK" || log "AVISO: off-site fallo (el backup local esta sano)"
else
    log "AVISO: sin copia off-site — backup y datos viven en el mismo disco"
fi

# ── 6. Rotación: recién ahora, con el backup de hoy ya validado ──────────────
purgar() {  # dir patron dias
    local n; n=$(find "$1" -maxdepth 1 -name "$2" -mtime +"$3" -delete -print | wc -l)
    [[ "$n" -gt 0 ]] && log "Rotacion $(basename "$1"): $n archivo(s) mas viejo(s) de $3 dias eliminado(s)"
    return 0
}
purgar "$BACKUP_ROOT/daily"   'daily-*.dump'   "$DAILY_RETENTION_DAYS"
purgar "$BACKUP_ROOT/weekly"  'weekly-*.dump'  "$WEEKLY_RETENTION_DAYS"
purgar "$BACKUP_ROOT/globals" 'globals-*.sql.gz' "$GLOBALS_RETENTION_DAYS"
[[ -d "$LEGACY_DIR" ]] && purgar "$LEGACY_DIR" 'pg_*.sql.gz' "$DAILY_RETENTION_DAYS"
find "$BACKUP_ROOT" -name '*.parcial' -mmin +120 -delete 2>/dev/null || true

# ── 7. Métricas para node_exporter → alertas Backup* ─────────────────────────
# El semanal se lee del archivo más nuevo en weekly/ (no de "hoy"): así la
# métrica dice la verdad cualquier día de la semana.
WEEKLY_LATEST=$(ls -t "$BACKUP_ROOT"/weekly/weekly-*.dump 2>/dev/null | head -1 || true)
WEEKLY_TS=0; [[ -n "$WEEKLY_LATEST" ]] && WEEKLY_TS=$(stat -c%Y "$WEEKLY_LATEST")
N_DAILY=$(ls "$BACKUP_ROOT"/daily/daily-*.dump 2>/dev/null | wc -l)
N_WEEKLY=$(ls "$BACKUP_ROOT"/weekly/weekly-*.dump 2>/dev/null | wc -l)

cat > "${METRIC_FILE}.tmp" <<EOF
# HELP mutualyf_backup_last_success_timestamp_seconds Epoch del ultimo backup diario de Postgres validado OK.
# TYPE mutualyf_backup_last_success_timestamp_seconds gauge
mutualyf_backup_last_success_timestamp_seconds $(date +%s)
# HELP mutualyf_backup_last_size_bytes Tamano del ultimo backup diario validado OK.
# TYPE mutualyf_backup_last_size_bytes gauge
mutualyf_backup_last_size_bytes $BYTES
# HELP mutualyf_backup_weekly_last_success_timestamp_seconds Epoch (mtime) del backup semanal mas reciente.
# TYPE mutualyf_backup_weekly_last_success_timestamp_seconds gauge
mutualyf_backup_weekly_last_success_timestamp_seconds $WEEKLY_TS
# HELP mutualyf_backup_count Cantidad de backups guardados por tipo.
# TYPE mutualyf_backup_count gauge
mutualyf_backup_count{kind="daily"} $N_DAILY
mutualyf_backup_count{kind="weekly"} $N_WEEKLY
EOF
mv "${METRIC_FILE}.tmp" "$METRIC_FILE"

log "=== Backup completo ($N_DAILY diarios, $N_WEEKLY semanales) ==="
