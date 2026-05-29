# Runbook de incidentes — Intellix

> Buscá tu escenario, seguí los pasos. Cada procedimiento empieza por "diagnóstico" (verificar que sí es eso) antes de "fix" (resolver). No te saltees el diagnóstico.

## Escenarios

1. [Backend no responde](#1-backend-no-responde)
2. [PostgreSQL caído](#2-postgresql-caído)
3. [Redis caído](#3-redis-caído)
4. [Qdrant caído](#4-qdrant-caído)
5. [Latencia RAG explotó](#5-latencia-rag-explotó)
6. [Errores 5xx masivos](#6-errores-5xx-masivos)
7. [Cliente reporta "no me responde el bot"](#7-cliente-reporta-no-me-responde-el-bot)
8. [Restore desde backup](#8-restore-desde-backup)
9. [Disco lleno](#9-disco-lleno)
10. [Certificado SSL no se renovó](#10-certificado-ssl-no-se-renovó)
11. [Rotación de JWT_SECRET (sospecha de compromiso)](#11-rotación-de-jwt_secret-sospecha-de-compromiso)
12. [Suspender un tenant inmediatamente](#12-suspender-un-tenant-inmediatamente)

---

## 1. Backend no responde

### Diagnóstico

```bash
curl -sk https://intellix.com.ar/health/ready
docker ps --filter name=ia_backend
docker logs ia_backend --tail 50
```

### Fix por causa

**Container en `Restarting`** → ver logs, hay crash loop. Causas comunes:
- DB no conectó → ver sección 2
- OOM killed → `dmesg | tail -20` muestra `oom-kill`. Subir mem limit o reducir batch.

**Container `Up (unhealthy)`** → healthcheck falla. Probablemente `/health` lento o cuelga:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart backend
```

**Container `Up (healthy)` pero igual 502 desde nginx** → conectividad red Docker:
```bash
docker network inspect mutualyf_internal | grep -A2 ia_backend
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart nginx backend
```

## 2. PostgreSQL caído

### Diagnóstico

```bash
docker exec ia_postgres pg_isready -U platform_user
docker logs ia_postgres --tail 80
```

### Fix

**Si el container está down:**
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d postgres
```

**Si arranca pero rechaza conexiones (`FATAL: too many connections`):**
```bash
docker exec ia_postgres psql -U platform_user -d platform -c \
  "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"
# Si hay muchas idle, kill conexiones idle viejas:
docker exec ia_postgres psql -U platform_user -d platform -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
   WHERE state='idle' AND state_change < NOW() - INTERVAL '10 minutes';"
docker compose ... restart backend celery_worker
```

**Si PG arranca pero "database does not exist"** → desastre, ir a sección 8 (restore).

## 3. Redis caído

### Diagnóstico

```bash
docker exec ia_redis redis-cli ping   # debe decir PONG
docker logs ia_redis --tail 50
```

### Fix

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart redis
```

**Importante:** restart de Redis pierde:
- DB 0 (broker Celery) → tareas pendientes se pierden. Aceptable.
- DB 1 (cache respuestas) → primera consulta de cada query será cache miss. Aceptable.
- DB 2 (rate limit) → contadores resetean. Aceptable.

No hay backup de Redis a propósito.

## 4. Qdrant caído

### Diagnóstico

```bash
curl -s http://localhost:6333/healthz 2>/dev/null || \
  ssh ... 'docker exec ia_qdrant wget -qO- http://localhost:6333/healthz'
docker logs ia_qdrant --tail 50
```

### Fix

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart qdrant
```

**Si las colecciones se corrompieron** (caso extremo):
```bash
# Verificar colecciones
ssh ... 'docker exec ia_qdrant curl -s localhost:6333/collections'

# Reingest desde documentos originales (MinIO los tiene):
# UI admin → Documentos → seleccionar todos → "Reingestar"
# o por API:
docker exec ia_backend python -c "from workers.ingest_tasks import process_document; ..."
```

## 5. Latencia RAG explotó

### Diagnóstico

1. Grafana → p95 RAG en últimas 6h
2. Jaeger → traces lentos (`min duration > 5s`), ver qué span domina

### Fix por causa más probable

**Groq responde lento** (el span LLM domina, >3s):
- Verificar status: https://groqstatus.com
- Workaround: forzar uso del modelo rápido para todas las queries (edit `orchestrator.py:choose_model`).

**Embeddings lentos** (span embed >500ms):
- Modelo `multilingual-e5-large` corre en CPU. Si el VPS está saturado, embed sube.
- `top -o %CPU` → ¿quién consume? Si Celery está reingestando, esperá que termine.

**Qdrant lento** (span qdrant_search >300ms):
- ¿Colección con >100k chunks? Probable. Ver sección "scale-up" del CLAUDE.md.

**Postgres lento** (span pg_query >200ms):
- ¿Falta vacuum?
  ```bash
  docker exec ia_postgres psql -U platform_user -d platform -c "VACUUM ANALYZE;"
  ```

## 6. Errores 5xx masivos

### Diagnóstico

```bash
# Ratio de 5xx en última hora
docker logs ia_nginx --since 1h 2>&1 | awk '{print $9}' | sort | uniq -c | sort -rn
```

### Fix

**Si todos los 5xx son del mismo endpoint** → bug específico, ver logs backend del endpoint:
```bash
docker logs ia_backend --since 1h 2>&1 | grep -B2 -A5 "ERROR"
```

**Si están distribuidos** → backend saturado:
- Restart backend para liberar leaks
- Verificar mem/CPU: si VPS al 100% → escalar vertical

## 7. Cliente reporta "no me responde el bot"

### Diagnóstico

```bash
# Identificar el tenant (ej. "nexo")
TID=nexo

# 1. ¿Tenant activo?
docker exec ia_postgres psql -U platform_user -d platform -c \
  "SELECT id, status FROM tenants WHERE id='$TID';"

# 2. ¿Documentos cargados?
docker exec ia_postgres psql -U platform_user -d platform -c \
  "SELECT count(*) FROM tenant_$TID.documentos WHERE status='ready';"

# 3. ¿Colección Qdrant tiene chunks?
docker exec ia_qdrant curl -s http://localhost:6333/collections/${TID}_docs

# 4. Smoke query directa
docker exec ia_backend python -c "
import asyncio
from services.orchestrator import handle_query
async def main():
    r = await handle_query(question='hola', tenant_id='$TID', user_id=None, language='es')
    print('sources:', len(r.get('sources', [])), 'answer:', r.get('answer', '')[:200])
asyncio.run(main())
"
```

Resultado esperado: `sources >= 1` y `answer` con texto coherente.

### Fix por causa

- Tenant `suspended` → activar desde panel super-admin
- Documentos no `ready` → ver columna `status` y `quality_gate_status`, reingestar si quedaron `failed`
- Colección Qdrant vacía → reingestar documentos
- Smoke query OK pero el cliente no recibe → es del lado del cliente (token expirado, widget mal embebido)

## 8. Restore desde backup

> **PROCEDIMIENTO DESTRUCTIVO.** Esto sobreescribe la DB actual. Solo usar si la DB está corrupta o se perdió.

### 8.1 Listar backups disponibles

```bash
ssh ... 'ls -lht /var/lib/docker/volumes/mutualyf_pgbackrest_data/_data/daily/ | head -10'
ssh ... 'ls -lht /var/lib/docker/volumes/mutualyf_pgbackrest_data/_data/weekly/ | head -10'
```

### 8.2 Restore en producción (¡destructivo!)

```bash
# 1. Frenar tráfico
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop backend celery_worker nginx

# 2. Elegir el backup más reciente
BACKUP=/var/lib/pgbackrest/daily/daily-YYYYMMDD-HHMM.dump

# 3. Drop y recrear DB (pg_restore --clean lo hace pero con esto es atómico)
docker exec ia_postgres psql -U platform_user -d postgres -c "DROP DATABASE platform WITH (FORCE);"
docker exec ia_postgres psql -U platform_user -d postgres -c "CREATE DATABASE platform;"

# 4. Restaurar
docker exec ia_pgbackrest sh -c "PGPASSWORD=\$POSTGRES_PASSWORD pg_restore \
  -h postgres -U \$POSTGRES_USER -d \$POSTGRES_DB --no-owner --no-acl $BACKUP"

# 5. Verificar
docker exec ia_postgres psql -U platform_user -d platform -c \
  "SELECT id, status, created_at FROM tenants ORDER BY created_at;"

# 6. Levantar tráfico
docker compose -f docker-compose.yml -f docker-compose.prod.yml start backend celery_worker nginx
```

### 8.3 Validación post-restore

```bash
curl -s https://intellix.com.ar/health/ready
# y luego smoke query del paso 7
```

**Importante:** Qdrant y Neo4j no están en este backup. Si la DB se perdió pero Qdrant/Neo4j siguen vivos, los datos quedan **desincronizados**. En ese caso después del restore:
```bash
# Re-procesar documentos para reconstruir Qdrant/Neo4j si hace falta
docker exec ia_backend python -c "..."  # ver scripts/reingest.py
```

## 9. Disco lleno

### Diagnóstico

```bash
df -h
du -sh /var/lib/docker/volumes/*/ | sort -h | tail -10
du -sh /var/lib/docker/overlay2/ | head -5
```

### Fix

```bash
# 1. Eliminar imágenes Docker no usadas
docker image prune -a -f

# 2. Eliminar containers viejos
docker container prune -f

# 3. Truncar logs Docker grandes (>500MB)
for f in $(find /var/lib/docker/containers -name "*-json.log" -size +500M); do
  truncate -s 0 "$f"
done

# 4. Si todavía está lleno, revisar:
#    - Backups (sección 7.3 de OPERACIONES.md)
#    - Volumen MinIO (originales de docs)
```

## 10. Certificado SSL no se renovó

### Diagnóstico

```bash
ssh ... 'certbot certificates'
# Buscar "Expiry Date" — si está pasado o próximo, hay problema
ssh ... 'journalctl -u certbot.timer --since "7 days ago" | tail -30'
```

### Fix

```bash
# Renovación manual forzada
ssh ... 'certbot renew --force-renewal'

# Reload nginx para tomar el cert nuevo
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec nginx nginx -s reload
```

Si certbot falla con "challenge failed":
- Verificar que el puerto 80 esté llegando a nginx
- Verificar que `/var/www/certbot` está montado en nginx
- DNS de `intellix.com.ar` apuntando al IP correcto

## 11. Rotación de JWT_SECRET (sospecha de compromiso)

**Efecto colateral:** todos los usuarios y widgets se deslogean.

```bash
# 1. Generar nuevo secret
NEW_SECRET=$(openssl rand -base64 64)

# 2. Editar .env
ssh ... "sed -i 's|^JWT_SECRET_KEY=.*|JWT_SECRET_KEY=$NEW_SECRET|' /opt/mutualyf/.env"

# 3. Recrear backend + celery (NO frontend, no usa el secret)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate backend celery_worker

# 4. Notificar a clientes que regeneren widget_token desde admin
```

## 12. Suspender un tenant inmediatamente

Caso: cliente con abuso, no pagó, comprometido.

```bash
# Vía API (desde super-admin)
curl -X POST https://intellix.com.ar/api/v1/tenants/$TID/suspend \
  -H "Authorization: Bearer $SUPER_ADMIN_TOKEN"

# Verificar — el cache se invalida automáticamente (Fase 2 #8).
# JWTs vigentes empiezan a dar 403 en <5 segundos.
docker exec ia_postgres psql -U platform_user -d platform -c \
  "SELECT id, status FROM tenants WHERE id='$TID';"
```

Reactivar:
```bash
curl -X POST https://intellix.com.ar/api/v1/tenants/$TID/activate \
  -H "Authorization: Bearer $SUPER_ADMIN_TOKEN"
```

---

## Apéndice: contactos / escalación

- **Groq down:** workaround = forzar modelo rápido o devolver 503 con mensaje al cliente
- **Let's Encrypt down:** los certs duran 90 días, no es urgente
- **Dattaweb (VPS provider):** soporte a través de panel web — incidentes de red/host
- **DNS:** registrar dónde está delegado intellix.com.ar (registrador)

---

**Cuando termines un incidente:**
1. Anotá en un log qué pasó, cómo lo solucionaste y cuánto tardó.
2. Si la causa raíz es sistémica, abrí un task para el fix permanente.
3. Si es algo que va a volver a pasar, agregalo a este runbook.
