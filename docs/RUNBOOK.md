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
13. [Crash-loop tras deploy (cadena de migraciones rota)](#13-crash-loop-tras-deploy-cadena-de-migraciones-rota)
14. [El sitio se cayó tras un `docker compose up` (segundo nginx)](#14-el-sitio-se-cayó-tras-un-docker-compose-up-segundo-nginx)
15. [El widget de un cliente devuelve 401](#15-el-widget-de-un-cliente-devuelve-401)
16. [OpenAI rechaza (429 / sin cuota)](#16-openai-rechaza-429--sin-cuota)

---

## 1. Backend no responde

### Diagnóstico

```bash
curl -sk https://app.intellix.com.ar/health/ready
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

**El LLM responde lento** (el span LLM domina, >3s — el proveedor real es
**OpenAI** `gpt-4o-mini`, aunque el código use nombres "groq" por herencia):
- Verificar status: https://status.openai.com
- Verificar saldo/límites: https://platform.openai.com (ver `docs/OPERACION_OPENAI_KEYS_Y_SALDO.md`).

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

Los dumps son formato custom de `pg_dump` (`-Fc`), generados por el cron del host
(ver OPERACIONES.md §8). El volumen está montado en `ia_postgres` en
`/var/lib/pgbackrest`, así que `pg_restore` corre desde ese contenedor.

### 8.1 Listar backups disponibles

```bash
V=/var/lib/docker/volumes/mutualyf_pgbackrest_data/_data
ls -lht $V/daily/ | head -10      # últimos 7 días
ls -lht $V/weekly/ | head -10     # últimos domingos (8 semanas)
ls -lht $V/globals/ | head -3     # roles del cluster
```

### 8.2 Restore completo en producción (¡destructivo!)

```bash
# 1. Frenar tráfico (nginx vive en /opt/edge, no en este compose)
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop backend celery_worker celery_beat

# 2. Elegir el backup
BACKUP=/var/lib/pgbackrest/daily/daily-YYYYMMDD-HHMM.dump   # ruta DENTRO de ia_postgres

# 3. Recrear la base vacía
docker exec ia_postgres psql -U platform_user -d postgres -c "DROP DATABASE platform WITH (FORCE);"
docker exec ia_postgres psql -U platform_user -d postgres -c "CREATE DATABASE platform;"

# 4. Restaurar (sin --clean: la base ya está vacía)
docker exec ia_postgres pg_restore -U platform_user -d platform --no-owner --no-acl $BACKUP

# 5. Verificar
docker exec ia_postgres psql -U platform_user -d platform -c \
  "SELECT id, status, created_at FROM tenants ORDER BY created_at;"

# 6. Levantar tráfico (el backend corre alembic al arrancar: la base restaurada
#    debe estar en la misma revisión que el código, ver alembic_version)
docker compose -f docker-compose.yml -f docker-compose.prod.yml start backend celery_worker celery_beat
```

Si el rol `platform_user` no existe (cluster nuevo), primero los globals:
`zcat $V/globals/globals-*.sql.gz | docker exec -i ia_postgres psql -U postgres -d postgres`.

### 8.2b Restore de UN solo tenant (los demás siguen andando)

Caso típico: un admin borró documentos de `tenant_galo` y hay que volver a ayer.
`pg_restore -n` NO crea el schema (esa entrada queda fuera del filtro): hay que
crearlo antes. Probado el 2026-08-26.

```bash
BACKUP=/var/lib/pgbackrest/daily/daily-YYYYMMDD-HHMM.dump
T=tenant_galo
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop backend celery_worker
docker exec ia_postgres psql -U platform_user -d platform -c "DROP SCHEMA $T CASCADE; CREATE SCHEMA $T;"
docker exec ia_postgres pg_restore -U platform_user -d platform --no-owner --no-acl -n $T $BACKUP
docker exec ia_postgres psql -U platform_user -d platform -c "SELECT count(*) FROM $T.documentos;"
docker compose -f docker-compose.yml -f docker-compose.prod.yml start backend celery_worker
```

Después: la colección `galo_docs` de Qdrant queda con vectores de documentos
que quizá ya no existen (o faltan los restaurados) → reingestar ese tenant.

### 8.3 Validación post-restore

```bash
curl -s https://app.intellix.com.ar/health/ready
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

- **OpenAI down / sin saldo:** el bot deja de responder. Ver `docs/OPERACION_OPENAI_KEYS_Y_SALDO.md` (recargar saldo / rotar key en `/opt/mutualyf/.env` + restart backend)
- **Let's Encrypt down:** los certs duran 90 días, no es urgente
- **Dattaweb (VPS provider):** soporte a través de panel web — incidentes de red/host
- **DNS:** registrar dónde está delegado intellix.com.ar (registrador)

---

## 13. Crash-loop tras deploy (cadena de migraciones rota)

El backend corre `alembic upgrade` **en el arranque**: una revisión cuyo
`down_revision` no existe en esa rama = el contenedor no levanta = ambiente
caído. El 2026-08-23 tumbó prod ~6 minutos.

### Diagnóstico

```bash
docker logs --tail 50 ia_backend | grep -iE "KeyError|alembic|revision"
# Un KeyError con un hash de revisión = cadena rota.

# Revisión aplicada en la base vs. archivos de la rama:
docker exec ia_postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc   "select version_num from alembic_version"'
ls backend/db/migrations/versions/ | tail -5
```

### Fix

1. **No reintentar el deploy**: vuelve a crashear igual.
2. Volver al commit anterior (`git reset --hard <sha previo>`) y reiniciar. El
   ambiente vuelve en el tiempo de un restart.
3. Recién después, arreglar el `down_revision` de la migración nueva para que
   encadene desde la última revisión **que existe en la rama destino**.

### Por qué pasa

Las cadenas divergen: las migraciones 052-054 (conectores) viven SOLO en
`dev-local`. En `main`/`dev` la cadena va …→051→055. Una migración nueva debe
encadenar desde el último común, y al pasarla de rama hay que verificar que su
`down_revision` exista allá.

---

## 14. El sitio se cayó tras un `docker compose up` (segundo nginx)

Prod se levanta con **cuatro** archivos de compose. Con menos, Docker levanta
un **segundo nginx** que pelea por los puertos 80/443 con el que está sirviendo
el sitio, arranca jaeger/pgadmin/portainer y el init que descarga ~2,5 GB de
modelos ya eliminados, y pierde los techos de memoria.

### Diagnóstico

```bash
docker ps -a | grep -iE "nginx|jaeger|pgadmin|portainer|tei"
# Dos contenedores de nginx, o jaeger/pgadmin/portainer corriendo = es esto.
```

### Fix

```bash
cd /opt/mutualyf
docker rm -f <el nginx nuevo> ia_jaeger ia_pgadmin ia_portainer ia_tei_model_init
docker start ia_nginx     # si el original quedó detenido por el conflicto
curl -s -o /dev/null -w '%{http_code}
' https://app.intellix.com.ar/login
```

### Prevención (ya aplicada, 2026-09-18)

El `.env` de prod define `COMPOSE_FILE` con los cuatro archivos: cualquier
`docker compose` en ese directorio toma la configuración correcta. `deploy.sh`
también los pasa. **No quitar esa línea del `.env`.**

---

## 15. El widget de un cliente devuelve 401

Síntoma: el widget carga y muestra el branding, pero al abrir la conversación
el backend responde 401 con `{"detail":"Widget token revocado o inválido"}`.
El afiliado ve un widget que no arranca. Caso real: `galo` estuvo ~5 semanas
así sin que nadie se enterara (2026-08-10 → 2026-09-17).

### Diagnóstico

```bash
# 1. Hash que espera la base
docker exec ia_postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc   "select left(widget_token_hash,16), widget_enabled from tenants where id='TENANT'"'

# 2. Token que tiene puesto el sitio del cliente: buscar el JWT en el HTML o
#    en el bundle JS, decodificar su payload (tenant_id, exp) y comparar su
#    sha256 con el hash de arriba.
```

Dos causas posibles:
- **Hashes distintos** → alguien regeneró el token en el panel y el sitio quedó
  con el viejo. Al regenerar, el anterior deja de valer **al instante**.
- **`exp` vencido** → el token dura `JWT_WIDGET_EXPIRE_DAYS` (hoy **90 días**),
  a pesar de que el código lo llama "no expirante". Vencimientos vigentes:
  mutualyf 2026-11-02, galo 2026-11-08, intellix 2026-11-30.

### Fix

Copiar el token vigente desde el panel (ficha del tenant → widget) y
actualizarlo en el sitio del cliente. **No regenerarlo**: eso invalida el que
esté funcionando en cualquier otro lado.

### Prevención

Avisar al cliente ~2 semanas antes del vencimiento, o subir
`JWT_WIDGET_EXPIRE_DAYS` (la revocación sigue funcionando por hash, que es lo
que realmente protege).

---

## 16. OpenAI rechaza (429 / sin cuota)

El bot responde *"Lo siento, el servicio de IA no está disponible en este
momento..."*. Es una degradación elegante: el usuario no ve un error crudo,
pero no obtiene respuesta. Precedente real: 2026-07-10, una auditoría
concurrente agotó la cuota y prod quedó degradado hasta recargar crédito.

### Diagnóstico

```bash
docker logs --since 30m ia_backend | grep -iE "rate_limit|insufficient_quota|RateLimitError"

# Límites y saldo restante de la cuenta (lee las cabeceras, no gasta casi nada):
docker exec ia_backend python -c "
import httpx; from core.config import settings as s
r = httpx.post('https://api.openai.com/v1/chat/completions',
    headers={'Authorization': 'Bearer ' + s.openai_api_key},
    json={'model': s.openai_model, 'messages': [{'role':'user','content':'ok'}], 'max_tokens': 1}, timeout=30)
print(r.status_code, {k: v for k, v in r.headers.items() if 'ratelimit' in k.lower()})"
```

Techo medido de la cuenta (2026-09-18): **10.000 pedidos/min y 200.000
tokens/min**. Cada consulta usa entre 3.000 y 6.000 tokens → el límite real
está cerca de **30-60 consultas por minuto**.

### Fix

1. Recargar crédito / subir el tier en la cuenta de OpenAI.
2. Mientras tanto, no correr evaluaciones internas (`run_quality_suite.py`,
   `run_regresion_corpus.py`, `rag_eval.py`): compiten por la misma cuota.


---

**Cuando termines un incidente:**
1. Anotá en un log qué pasó, cómo lo solucionaste y cuánto tardó.
2. Si la causa raíz es sistémica, abrí un task para el fix permanente.
3. Si es algo que va a volver a pasar, agregalo a este runbook.
