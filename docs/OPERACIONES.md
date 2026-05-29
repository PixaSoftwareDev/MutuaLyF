# Operaciones — Intellix

> Manual del operador. Todo lo que necesitás para saber si la plataforma está sana, dónde mirar, y cómo arreglarla cuando no lo está.

## 1. Acceso al VPS

```bash
# Conexión SSH
ssh -i ~/.ssh/mutualyf_vps -p 2251 root@200.58.109.110

# Directorio del proyecto
cd /opt/mutualyf
```

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

### 8.1 Verificar que el cron de backup corre

```bash
docker logs ia_pgbackrest --tail 30
# Debería mostrar "Backup daily completado: ..." cada noche 03:00 UTC
```

### 8.2 Forzar backup manual ahora

```bash
docker exec ia_pgbackrest /usr/local/bin/do-backup.sh daily
```

### 8.3 Restore — ver `RUNBOOK.md` sección "Restore desde backup"

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

# Si tocaste código backend/frontend
docker compose -f docker-compose.yml -f docker-compose.prod.yml build backend frontend
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate backend frontend celery_worker

# Si tocaste migración
docker exec -w /app ia_backend alembic -c db/alembic.ini upgrade head
```

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
