# Operaciones — Intellix

> Manual del operador. Todo lo que necesitás para saber si la plataforma está sana, dónde mirar, y cómo arreglarla cuando no lo está.

## 1. Acceso al VPS

```bash
# Conexión SSH
ssh -i ~/.ssh/mutualyf_vps -p 2251 root@200.58.109.110

# Directorio del proyecto
cd /opt/mutualyf
```

### Cómo está asegurado el acceso (2026-08-18)

- **Solo clave pública.** `PasswordAuthentication no` + `PermitRootLogin prohibit-password`,
  en `/etc/ssh/sshd_config.d/01-hardening.conf`. El nombre empieza con `01-` a propósito:
  en OpenSSH **gana la primera directiva que se lee**, no la última (al revés que nginx).
  Un drop-in `99-` no pisa nada — así estuvo meses sin efecto. Verificar siempre con
  `sshd -T | grep -E 'passwordauth|permitroot'`, nunca leyendo los archivos.
- **Firewall = UFW, sin reglas manuales.** Abiertos: 2251 (SSH), 80, 443, y las IPs de
  gestión de DonWeb. El 22 tiene `deny` explícito. Portainer/pgAdmin/Grafana NO están en
  UFW: se protegen con el bind a `127.0.0.1` en el compose (Docker saltea UFW en puertos
  publicados en `0.0.0.0`). Verificar la realidad con `iptables -S INPUT`, no con `ufw status`.
- **fail2ban** cuida el **2251** (`/etc/fail2ban/jail.d/sshd.local`): 5 fallos en 10 min →
  ban 1 día. Ojo: el default de Debian es `port=ssh` (=22) y baneaba en el puerto equivocado.
- **DonWeb (proveedor)** entra con certificados firmados por su CA (`80-step.conf`,
  `/etc/ssh/auth_principals/`). No tocar.
- La contraseña de root queda activa **solo para la consola KVM del panel de DonWeb**
  (rescate si SSH muere); por SSH no sirve.
- Para dar acceso a alguien nuevo: agregar su clave pública a `/root/.ssh/authorized_keys`.

## 2. URLs públicas

| Para | URL |
|---|---|
| Plataforma (cliente) | https://intellix.com.ar |
| Chat público | https://intellix.com.ar/chat |
| Login admin | https://intellix.com.ar/login |
| Health (liveness) | https://intellix.com.ar/health |
| Health (ready) | https://intellix.com.ar/health/ready |
| Metrics Prometheus | https://intellix.com.ar/metrics |

`/health` solo dice "el proceso está vivo". `/health/ready` chequea PG + Redis + Qdrant y devuelve `{checks:{postgres:"ok",...}}`. Si algo no está OK te das cuenta acá primero.

## 3. URLs internas (vía SSH tunnel)

Las dejé en `127.0.0.1` para no exponerlas públicamente. Abrís un túnel y las usás como si estuvieran en tu máquina.

```bash
# Túnel multi-puerto (un solo comando, todo a la vez)
ssh -i ~/.ssh/mutualyf_vps -p 2251 \
  -L 3001:127.0.0.1:3001 \
  -L 9000:127.0.0.1:9000 \
  -L 5050:127.0.0.1:5050 \
  -L 16686:127.0.0.1:16686 \
  -L 9090:127.0.0.1:9090 \
  -L 3100:127.0.0.1:3100 \
  root@200.58.109.110
```

Mientras ese túnel esté abierto, en tu navegador:

| Herramienta | URL local | Para qué sirve |
|---|---|---|
| **Grafana** | http://localhost:3001 | Dashboards de uso, latencia, errores, recursos |
| **Jaeger** | http://localhost:16686 | Trazas distribuidas (qué hizo cada request, dónde tardó) |
| **Prometheus** | http://localhost:9090 | Métricas crudas (avanzado) |
| **Loki** | http://localhost:3100 | Logs agregados — usalo via Grafana, no directo |
| **Portainer** | http://localhost:9000 | Gestión visual de containers Docker |
| **pgAdmin** | http://localhost:5050 | Cliente gráfico de PostgreSQL |

Credenciales en `/opt/mutualyf/.env` (campos `GRAFANA_PASSWORD`, `PGADMIN_DEFAULT_*`).

## 4. ¿Está colapsada la plataforma?

Cuatro chequeos en este orden:

### 4.1 Health rápido (5 seg)

```bash
curl -s https://intellix.com.ar/health/ready
```

Debe devolver `{"status":"ok","checks":{"postgres":"ok","redis":"ok","qdrant":"ok"}}`. Si alguno dice `error` ya sabés a dónde apuntar.

### 4.2 Estado de containers

```bash
ssh ... 'docker ps --format "table {{.Names}}\t{{.Status}}"'
```

Todos deben decir `Up X (healthy)`. Si alguno está `Restarting`, hay un loop de crash — ver logs (sección 5).

### 4.3 Recursos del host

```bash
ssh ... 'free -h && df -h /var/lib/docker && uptime'
```

Banderas rojas:
- `free -h` con `available` < 1G → cerca de OOM
- Disco docker > 85% → contenedores van a empezar a fallar
- `load average` > 4× cantidad de cores

### 4.4 Dashboard de Grafana

Túnel + http://localhost:3001 → dashboard "IA Platform". Mirás en tiempo real:
- **Request rate** — picos vs normal
- **p95 latency** — si crece sostenido, algo se atascó
- **Error rate (5xx)** — debe estar cerca de 0
- **CPU / mem por container** — quién está chupando recursos

## 5. Logs — encontrar qué pasó

### 5.1 Backend (último error)

```bash
docker logs ia_backend --tail 100 2>&1 | grep -iE "error|warn|exception"
```

### 5.2 Buscar por palabra clave

```bash
docker logs ia_backend --since 30m 2>&1 | grep -i "groq\|timeout\|tenant_id"
```

### 5.3 En Grafana (Loki)

Túnel + http://localhost:3001 → Explore → datasource Loki:
```logql
{container="ia_backend"} |= "ERROR" | json
{container="ia_backend"} |~ "tenant=.*nexo" | json
```

Loki retiene 30 días (Fase 2).

### 5.4 Trazas en Jaeger

http://localhost:16686 → Service `ia-platform-backend` → query por tag (ej. `http.target=/api/v1/widget/...`). Cada request muestra el árbol de spans con timings. **OTEL_SAMPLE_RATIO=0.1** → solo 10% de las requests están en Jaeger.

## 6. Comandos de reset (por nivel de violencia)

### 6.1 Suave — restart de un servicio

```bash
cd /opt/mutualyf
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart backend
# o celery_worker, frontend, nginx, redis...
```

**Cuándo usarlo:** backend devolviendo 500s intermitentes, memoria creciendo lineal (probable leak), Celery con tareas atascadas.

### 6.2 Medio — recrear container (re-leer .env)

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate backend
```

**Cuándo usarlo:** cambiaste `.env` y querés que el backend lo recoja, container tiene estado corrupto.

### 6.3 Fuerte — rebuild de imagen

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml build backend celery_worker
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend celery_worker
```

**Cuándo usarlo:** pulleaste código nuevo. Tarda 5-10 min por torch/transformers.

### 6.4 Total — restart de toda la plataforma

```bash
cd /opt/mutualyf
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

**Cuándo usarlo:** último recurso. ~3 min de downtime. Notificar al cliente antes.

### 6.5 Nuclear — restart del VPS

```bash
ssh ... 'reboot'
# esperar 2-3 min, reconectar
```

**Cuándo usarlo:** solo si el VPS no responde a nada. Los containers vuelven solos por `restart: unless-stopped`.

## 7. Limpiezas rutinarias

### 7.1 Cache de Redis (si responde algo viejo)

```bash
# Cache de respuestas (DB 1)
docker exec ia_redis redis-cli -n 1 FLUSHDB
# Rate limiting (DB 2)
docker exec ia_redis redis-cli -n 2 FLUSHDB
# Broker Celery (DB 0) — NO TOCAR salvo emergencia, perdés jobs en cola
```

### 7.2 Logs viejos de Docker

```bash
docker system df             # ver cuánto pesa
docker system prune -a -f    # limpia imágenes/containers no usados
```

### 7.3 Backups viejos

Se rotan solos (7 días daily, 28 días weekly). Verificar:

```bash
ls -lh /var/lib/docker/volumes/mutualyf_pgbackrest_data/_data/daily/
ls -lh /var/lib/docker/volumes/mutualyf_pgbackrest_data/_data/weekly/
```

## 8. Backup y restore

Desde el 2026-08-12 el backup de Postgres lo hace un script del host
(`/usr/local/bin/mutualyf-pg-backup.sh`, cron 03:30 -3, `pg_dumpall` a
`/backups/pg/`, retención 7 días) y publica una métrica para node_exporter:
si pasan 36 h sin un dump validado, o la métrica desaparece, salta la alerta
`BackupDesactualizado` / `BackupMetricaAusente` (dead-man switch). El
contenedor `ia_pgbackrest` sigue arriba pero ya no es la fuente de verdad.

### 8.1 Verificar que el cron de backup corre

```bash
tail -5 /var/log/mutualyf-backup.log      # "Backup OK: ..." cada noche
ls -lh /backups/pg/ | tail -3
```

### 8.2 Forzar backup manual ahora

```bash
/usr/local/bin/mutualyf-pg-backup.sh
```

### 8.3 Restore — ver `RUNBOOK.md` sección "Restore desde backup"

### 8.4 Backups de las apps satélite (2026-08-21)

`/usr/local/bin/satelites-backup.sh` (en el repo: `scripts/satelites-backup.sh`),
cron 03:45 -3, deja en `/backups/satelites/<app>/` un `pg_dump` de Handicapp,
Las Marías y Ecuestre y una copia **en línea** del SQLite del CRM-Pixs (vía
`better-sqlite3` dentro del contenedor: la base está en modo WAL y copiar el
archivo a secas puede salir inconsistente). Retención 7 días, mismas
validaciones que el de Intellix, y una métrica por app
(`satelite_backup_*{app=...}`) con sus alertas `SateliteBackup*` (warning).

```bash
tail -8 /var/log/satelites-backup.log
/usr/local/bin/satelites-backup.sh        # forzar a mano; sale 1 si alguna falló
# Restore PG:  zcat pg_X.sql.gz | docker exec -i <contenedor-pg> psql -U <user> <db>
# Restore SQLite: zcat pixs_X.sqlite.gz > /opt/crm-pixs/data/pixs.sqlite (con la api parada)
```

## 9. Métricas clave que mirar todos los días

Si lo hacés 2 min al día, te enterás antes que el cliente:

1. **`/health/ready`** — verde
2. **Grafana → p95 RAG** — debe ser < 4s (target 1.6s post-Fase 2)
3. **Grafana → error rate 5xx** — < 1%
4. **`df -h`** — disco < 80%
5. **`docker logs ia_backend --since 1h | grep -c ERROR`** — < 10

## 10. Cambios al `.env` en producción

```bash
ssh ... 'vim /opt/mutualyf/.env'
cd /opt/mutualyf
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate backend celery_worker
```

**Cuidado con:** `JWT_SECRET_KEY` — si la cambiás, **todos los usuarios se deslogean**. Solo rotar si sospechás compromiso.

## 11. Renovación de SSL

Automática. Verificar:

```bash
ssh ... 'certbot certificates'
ssh ... 'systemctl status certbot.timer'
```

El cert se renueva sólo cuando faltan <30 días. Si alguna vez no se renovó:

```bash
ssh ... 'certbot renew --force-renewal'
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart nginx
```

## 12. Despliegue de código nuevo

```bash
# En tu máquina
git push origin main

# En VPS
ssh ... 'cd /opt/mutualyf && git pull --rebase'

# Si tocaste código BACKEND: el código está BIND-MONTEADO → basta un restart
# (rebuild solo si cambiaron dependencias). Frontend SÍ requiere rebuild (horneado).
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart backend celery_worker celery_beat
docker compose -f docker-compose.yml -f docker-compose.prod.yml build frontend
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps frontend

# Si tocaste migración — OJO: la base es COMPARTIDA con staging y la versión de
# alembic es global. Regla de oro: ambas ramas (main y dev) deben tener el
# archivo de la revisión ANTES de correr el upgrade (ver CLAUDE.md).
docker exec -w /app ia_backend alembic -c db/alembic.ini upgrade head
```

> **Reranker: ELIMINADO (2026-07-23).** El TEI reranker ya no existe en el
> pipeline ni en el compose — su función la cumple el trust gate
> (`services/trust_gate.py`). Si ves referencias a `tei-reranker` o
> `RERANKER_PROVIDER`, son restos históricos: no hay nada que levantar.
>
> **Deploy con red**: existe `scripts/deploy.sh` (pre-flight de drift, deploy
> selectivo según diff, health checks). Los pasajes se coordinan con Alejo —
> no deployar por iniciativa propia.

## 13. Tabla rápida — "qué hago si..."

| Síntoma | Primer paso |
|---|---|
| Bot tarda mucho | Grafana → p95 RAG. Si está alto, Jaeger para ver dónde |
| Bot devuelve "no sé" siempre | Logs backend, buscar `low_confidence` |
| Operador no ve nuevas conversaciones | Restart nginx (SSE puede colgarse) |
| Login no funciona | `/health/ready` PG, si OK ver logs auth |
| Widget no responde | F12 → Network: ¿401? token revocado o tenant suspendido |
| Plataforma "caída" general | `docker ps` → ¿algún container restarting? |
| Disco lleno | `docker system prune -a -f` + revisar backups viejos |

---

**Última actualización:** 2026-05-29 (Fase 2 + OTEL@10% en prod)

## Staging con stack propio (Fase 1 consolidación, 2026-08-20)

Desde el 2026-08-20 staging NO comparte bases con prod: tiene Postgres,
Qdrant, Redis, MinIO y Celery (worker+beat) propios, definidos en
`docker-compose.staging.yml` (red `staging_internal`; `mutualyf_internal`
queda solo para el ruteo del nginx). Paridad con prod: 4 workers uvicorn,
celery concurrency 4, mismas imágenes de bases.

### Reclonar staging desde prod (cuando se ensucia de tanto testear)

```bash
cd /opt/mutualyf-staging
# 1. PG (~1,5MB)
docker exec ia_postgres pg_dump -U platform_user -Fc platform > /root/staging_clone/platform.dump
docker exec -i ia_postgres_staging pg_restore -U platform_user -d platform \
  --clean --if-exists --no-owner < /root/staging_clone/platform.dump
# 2. Qdrant (snapshot por colección; prod expone 6333, staging 6334 en loopback)
for c in mutualyf_docs intellix_docs galo_docs; do
  SNAP=$(curl -s -X POST "http://127.0.0.1:6333/collections/$c/snapshots" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
  docker cp -q ia_qdrant:/qdrant/snapshots/$c/$SNAP /root/staging_clone/$SNAP
  docker cp -q /root/staging_clone/$SNAP ia_qdrant_staging:/qdrant/snapshots/$SNAP
  curl -s -X PUT "http://127.0.0.1:6334/collections/$c/snapshots/recover" \
    -H "Content-Type: application/json" -d "{\"location\":\"file:///qdrant/snapshots/$SNAP\"}"
done
# 3. MinIO (2 pasos vía mc, credenciales en los .env de cada ambiente)
#    prod→/root/staging_clone/minio→staging (ver historial: mc mirror --overwrite)
# 4. Reiniciar backend para vaciar pools/caches
docker compose -f docker-compose.staging.yml restart backend_staging
```

Staging es DESCARTABLE: no se respalda (pgbackrest cubre solo prod); si se
rompe, se reclona con lo de arriba.

### Pendientes conocidos (2026-08-20)

- El server block de dev en `nginx.prod.conf` fuerza `X-Tenant-ID: nexo`
  (tenant inexistente) → el widget ANÓNIMO en dev.intellix.com.ar rebota con
  "Tenant not found" (preexistente a la Fase 1; el panel funciona por JWT).
  RESUELTO el mismo día: dev ahora fuerza `intellix` (VPS y repo local, sin commitear).
- Basura a limpiar cuando se confirme estabilidad: Redis de prod DBs 3/4/5
  (cola muerta del staging viejo), `docker-compose.staging.yml.bak-20260820`.
  HECHO 2026-08-21: `.bak` borrados y Redis prod DBs 3/4 vaciadas (staging
  ya usa `ia_redis_staging`, verificado).
- Key de OpenAI separada para staging (hoy comparte rate limit con prod).
- `dev.intellix.com.ar/health` ya tiene sonda blackbox propia (job
  `blackbox_health`), así que `PlatformDown` también cubre staging.

## Apps satélite que conviven en el VPS (consolidación 2026-08-20)

Cuatro apps migradas desde el VPS viejo, cada una con su stack Compose en
`/opt/<app>` (`ecuestre`, `lasmarias`, `handicapp`, `crm-pixs`), su propia
base (nunca compartida), `cpuset: "14,15"` (jaula de 2 cores) y `mem_limit`
de 256-512 MB por servicio. Las publica el nginx del edge (`/opt/edge`) con
`proxy_pass` por variable: si una está caída, solo su path da 502 — nunca
arrastra a Intellix.

| App | Cómo se llega | Base | Stack |
|---|---|---|---|
| Las Marías | `http://200.58.109.110/` | `lasmarias-postgres` (5436 loopback) | api + web Node 22, código copiado SIN git |
| CRM-Pixs | `http://200.58.109.110/crmpixs` (+ `/crmpixs/api`) | SQLite `/opt/crm-pixs/data/pixs.sqlite` | web + api tsx; **upstream del conector Pixs de Intellix** |
| Ecuestre | `http://200.58.109.110/ecuestre/` | `ecuestre-db` (5435 loopback) | Next + PG 17; secretos en `/opt/ecuestre/.env` (600, gitignored) |
| Handicapp | `app.handicapp.com.ar` (DNS aún en el VPS viejo) | `handicapp-postgres` (5437 loopback) | api + web; debug port 3004 (3001 lo usa Grafana) |

Monitoreo: sondas `blackbox_satelites` (alerta `SateliteDown`, warning, 5 min)
para Las Marías, CRM-Pixs y Ecuestre; Handicapp se suma cuando el DNS apunte
acá y tenga cert. Backups: sección 8.4.

### Pendientes de la convivencia (2026-08-21)

- ~~Las Marías: `/api/*` daba 500 en el VPS nuevo~~ RESUELTO 2026-08-21. Dos
  causas encadenadas, vale como lección para los demás satélites: (1) los
  `rewrites` de Next se hornean en el **build**, y el build copiado del VPS
  viejo traía `127.0.0.1:4000`; (2) en la red `edge` el nombre de servicio
  `api` lo comparten CRM-Pixs y Handicapp, y el DNS de Docker devolvía esos
  antes que el de la red propia. Por eso el proxy apunta al **nombre de
  contenedor** `lasmarias-api:4000` (único), en el compose y en
  `apps/web/.env.*`. Rebuild (sin tumbar la web, el build corre en un
  contenedor aparte porque el de prod tiene techo de 512 MB):
  ```bash
  cd /opt/lasmarias/apps/web && docker run --rm -v /opt/lasmarias:/app -w /app/apps/web \
      -e API_PROXY_TARGET=http://lasmarias-api:4000 -e NODE_ENV=production -e NEXT_TELEMETRY_DISABLED=1 \
      --memory 3g --cpuset-cpus 14,15 node:22-trixie-slim node_modules/.bin/next build \
    && chown -R 1000:1000 .next && cd /opt/lasmarias && docker compose up -d web
  curl -s -o /dev/null -w "%{http_code}\n" http://200.58.109.110/health   # 200 = proxy hasta la API OK
  ```
  Regla para cualquier satélite en `edge`: referenciar servicios de otro
  contenedor por `container_name`, nunca por el nombre genérico del servicio.
- DNS A de `app.handicapp.com.ar` → 200.58.109.110; después `certbot certonly
  --webroot -w /var/www/certbot -d app.handicapp.com.ar`, bloque 443 en
  `nginx.prod.conf` (patrón intellix) y target `https://app.handicapp.com.ar/`
  en `blackbox_satelites`.
- Avisar la IP nueva a los usuarios de Las Marías, CRM-Pixs y Ecuestre (o
  definirles dominio).
- Apuntar el conector Pixs de Intellix al CRM de este VPS (hoy va al viejo) y
  revisar hosts aprobados del tenant.
- Decomisar el VPS viejo tras 7-14 días de convivencia (desde el 2026-08-20).
