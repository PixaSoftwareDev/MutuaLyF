#!/usr/bin/env bash
# Backup diario de las apps satélite que conviven en el VPS de Intellix
# (consolidación 2026-08-20): las 3 Postgres chicas (Handicapp, Las Marías,
# Ecuestre) y el SQLite del CRM-Pixs. Va a /backups/satelites/<app>/,
# retención 7 días. Programado por cron a las 03:45 -3, después del de Intellix.
#
# Mismas reglas que mutualyf-pg-backup.sh: cada dump se valida antes de
# reemplazar nada, los viejos se purgan solo si el de hoy salió bien, y cada
# app publica su propia métrica en node_exporter -> alertas por app.
# Un fallo en una app NO frena a las demás: se registra, se marca la métrica
# como fallida y se sigue con la siguiente.
set -uo pipefail

BACKUP_ROOT="/backups/satelites"
RETENTION_DAYS=7
TEXTFILE_DIR="/var/lib/node_exporter/textfile_collector"
METRIC_FILE="$TEXTFILE_DIR/satelites_backup.prom"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="/var/log/satelites-backup.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

mkdir -p "$TEXTFILE_DIR"

# app|contenedor|usuario|db|min_bytes — el mínimo es un piso anti-dump-vacío,
# bien por debajo de lo que pesa cada una hoy.
PG_APPS=(
    "handicapp|handicapp-postgres|handicapp|handicapp|20000"
    "lasmarias|lasmarias-postgres|lasmarias|lasmarias|5000"
    "ecuestre|ecuestre-db|ecuestre|ecuestre|5000"
)

# Se va armando en memoria y se escribe atómico al final.
METRICS=""
publicar() {   # app ok(0/1) bytes
    METRICS+="satelite_backup_last_run_ok{app=\"$1\"} $2"$'\n'
    if [[ "$2" == "1" ]]; then
        METRICS+="satelite_backup_last_success_timestamp_seconds{app=\"$1\"} $(date +%s)"$'\n'
        METRICS+="satelite_backup_last_size_bytes{app=\"$1\"} $3"$'\n'
    fi
}

# Si una app falla hoy, conserva el timestamp del último éxito que tenía
# publicado (si no, la alerta "atrasado" nunca dispararía: la métrica
# desaparecería y solo saltaría la de "ausente").
conservar_ultimo_exito() {   # app
    local prev
    prev=$(grep -E "^satelite_backup_last_success_timestamp_seconds\{app=\"$1\"\}" "$METRIC_FILE" 2>/dev/null || true)
    [[ -n "$prev" ]] && METRICS+="$prev"$'\n'
}

validar_y_mover() {   # app tmp out min_bytes
    local app="$1" tmp="$2" out="$3" min="$4" bytes
    if ! gzip -t "$tmp" 2>/dev/null; then
        log "[$app] ERROR: el dump quedó corrupto"; rm -f "$tmp"; return 1
    fi
    bytes=$(stat -c%s "$tmp")
    if [[ "$bytes" -lt "$min" ]]; then
        log "[$app] ERROR: dump sospechosamente chico ($bytes bytes, mínimo $min)"
        rm -f "$tmp"; return 1
    fi
    mv "$tmp" "$out"
    log "[$app] Backup OK: $out ($(du -h "$out" | cut -f1))"
    local borrados
    borrados=$(find "$(dirname "$out")" -name "*.gz" -mtime +$RETENTION_DAYS -delete -print | wc -l)
    [[ "$borrados" -gt 0 ]] && log "[$app] Borrados $borrados backups más viejos de $RETENTION_DAYS días"
    publicar "$app" 1 "$bytes"
}

log "=== Iniciando backup de satélites ==="
FALLOS=0

for spec in "${PG_APPS[@]}"; do
    IFS='|' read -r app cont user db min <<< "$spec"
    dir="$BACKUP_ROOT/$app"; mkdir -p "$dir"
    out="$dir/pg_${db}_${TIMESTAMP}.sql.gz"; tmp="${out}.parcial"
    # La imagen oficial de Postgres confía en las conexiones por socket local,
    # por eso alcanza con -U y no hace falta sacar la contraseña del .env.
    if docker exec "$cont" pg_dump -U "$user" --clean --if-exists "$db" 2>>"$LOG_FILE" | gzip -9 > "$tmp" \
       && validar_y_mover "$app" "$tmp" "$out" "$min"; then
        :
    else
        log "[$app] FALLÓ — NO se generó backup"
        rm -f "$tmp"; publicar "$app" 0 0; conservar_ultimo_exito "$app"; FALLOS=$((FALLOS+1))
    fi
done

# CRM-Pixs: SQLite en modo WAL. Copiar el archivo a secas puede dar una base
# inconsistente, así que se usa la API de backup en línea de better-sqlite3
# (la que ya trae la app) y recién después se saca el archivo del contenedor.
app="crmpixs"; cont="crm-pixs-api"
dir="$BACKUP_ROOT/$app"; mkdir -p "$dir"
out="$dir/pixs_${TIMESTAMP}.sqlite.gz"; tmp="${out}.parcial"
if docker exec "$cont" node -e '
    const db = require("better-sqlite3")("/app/data/pixs.sqlite", { readonly: true });
    db.backup("/tmp/pixs-backup.sqlite").then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
' 2>>"$LOG_FILE" \
   && docker exec "$cont" cat /tmp/pixs-backup.sqlite | gzip -9 > "$tmp" \
   && docker exec "$cont" rm -f /tmp/pixs-backup.sqlite \
   && validar_y_mover "$app" "$tmp" "$out" 5000; then
    :
else
    log "[$app] FALLÓ — NO se generó backup"
    rm -f "$tmp"; publicar "$app" 0 0; conservar_ultimo_exito "$app"; FALLOS=$((FALLOS+1))
fi

{
    echo "# HELP satelite_backup_last_success_timestamp_seconds Epoch del último backup validado OK, por app satélite."
    echo "# TYPE satelite_backup_last_success_timestamp_seconds gauge"
    echo "# HELP satelite_backup_last_size_bytes Tamaño del último backup validado OK, por app satélite."
    echo "# TYPE satelite_backup_last_size_bytes gauge"
    echo "# HELP satelite_backup_last_run_ok 1 si la última corrida de esa app salió bien, 0 si falló."
    echo "# TYPE satelite_backup_last_run_ok gauge"
    printf '%s' "$METRICS"
} > "${METRIC_FILE}.tmp"
mv "${METRIC_FILE}.tmp" "$METRIC_FILE"

log "=== Backup de satélites completo ($FALLOS fallos) ==="
exit $(( FALLOS > 0 ? 1 : 0 ))
