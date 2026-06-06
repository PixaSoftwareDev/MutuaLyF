# Runbook de producción — Plataforma Intellix

> Qué hacer cuando llega una alerta. Las alertas (email) referencian las secciones
> de este documento por número. Genérico a la plataforma — aplica a cualquier tenant.

## Accesos rápidos

Todos los paneles escuchan en loopback del VPS (no expuestos a internet). Abrir túnel SSH:

```bash
ssh -i ~/.ssh/mutualyf_vps -p 2251 -N \
  -L 3001:127.0.0.1:3001 \
  -L 9090:127.0.0.1:9090 \
  -L 9093:127.0.0.1:9093 \
  -L 16686:127.0.0.1:16686 \
  -L 3100:127.0.0.1:3100 \
  root@200.58.109.110
```

| Herramienta | URL (con túnel) | Para qué |
|---|---|---|
| Grafana | http://localhost:3001 | Dashboards: latencia, errores, Groq, recursos |
| Prometheus | http://localhost:9090 | Métricas crudas + estado de alertas (/alerts) |
| Alertmanager | http://localhost:9093 | Alertas activas + silenciarlas |
| Jaeger | http://localhost:16686 | Trazas: qué span hace lenta una consulta |
| Loki/Logs | http://localhost:3001 (Explore) | Logs centralizados |

SSH directo al VPS: `ssh -i ~/.ssh/mutualyf_vps -p 2251 root@200.58.109.110` → repo en `/opt/mutualyf`.

---

## Las 3 alertas que más importan

1. **Groq sin saldo / caído** → el bot deja de responder consultas. Sección Groq.
2. **5xx altos / plataforma caída** → algo se rompió. Secciones 1 y 4.
3. **Latencia p95 alta** → el bot anda lento. Sección 5.

---

## Groq — GroqDownOrNoCredit / GroqDegraded

**Síntoma:** el bot responde "tuve un problema" o no contesta consultas.
**Causa #1 en prod: la cuenta de Groq se quedó sin saldo** (devuelve 401/403 → status="error").

1. Verificar saldo y estado de la key en https://console.groq.com (Settings → Billing / API Keys).
2. Si está **sin saldo**: recargar. El bot se recupera solo en cuanto haya crédito (no hace falta reiniciar nada).
3. Si la key fue revocada/rota: generar una nueva, actualizar `GROQ_API_KEY` en `/opt/mutualyf/.env` y recrear el backend:
   ```bash
   cd /opt/mutualyf && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate backend
   ```
4. Mientras tanto el RAG sigue recuperando contexto; solo falla la generación final.
5. **GroqDegraded** (warning, >20% fallan) suele ser rate-limit del plan o saldo bajándose: es el aviso temprano antes del corte total. Revisar billing antes de que escale a crítico.

**Recaudo:** activar alerta de saldo bajo dentro de console.groq.com (billing alerts) como segunda red, además de esta.

---

## Sección 1 — PlatformDown (/health no responde desde afuera)

Cubre el caso "nginx caído aunque el backend esté vivo".
1. `curl -I https://intellix.com.ar/health` desde tu máquina.
2. En el VPS: `docker ps | grep -E 'nginx|backend'` — ¿están up?
3. Reiniciar el que esté caído: `docker compose ... up -d --force-recreate nginx` (o `backend`).
4. Si nginx no levanta: revisar `docker logs ia_nginx` (suele ser config o cert).

## Sección 2 — PostgresDown

Sin DB no funciona nada.
1. `docker logs ia_postgres --tail 50` — buscar OOM o corrupción.
2. `docker compose ... up -d postgres` y esperar healthcheck.
3. Verificar disco (sección 9): Postgres no arranca con disco lleno.
4. Si hay corrupción: restaurar del backup (pgBackRest, ver sección 11).

## Sección 3 — RedisDown

Sin Redis: sin cache (más lento), sin rate-limit, sin broker Celery (no ingesta).
1. `docker logs ia_redis --tail 30`.
2. `docker compose ... up -d redis`.
3. El bot sigue respondiendo consultas sin cache (más lento). La ingesta se frena hasta que vuelva.

## Sección 4 — HighErrorRate5xx (>1% de 5xx)

1. Grafana → panel "HTTP error rate 5xx" para ver desde cuándo.
2. Loki (Explore) → `{container="ia_backend"} |= "ERROR"` en la ventana del pico.
3. Causas típicas: Groq caído (ver Groq), una DB caída (secciones 2/3), o un deploy roto → `git log` y considerar rollback.

## Sección 5 — HighRagLatencyP95 (p95 > 8s)

1. Jaeger → buscar trazas lentas del endpoint /query → ver el span dominante.
2. Si domina Groq: ver GroqDegraded (rate-limit/saturación).
3. Si domina la DB: revisar carga (sección 9 CPU) o queries lentas.
4. Bajo mucha concurrencia: confirmar que el backend corre con 4 workers
   (`docker exec ia_backend ps aux | grep uvicorn`).

## Sección 9 — DiskAlmostFull / HighCpuLoad / LowMemory

**Disco >85%:**
```bash
docker system df            # qué ocupa
docker image prune -a -f    # imágenes viejas
docker logs ... # rotación de logs ya configurada en compose
du -sh /opt/mutualyf/* | sort -h
```
**CPU/RAM:** `docker stats --no-stream` → identificar el container. El backend con 4 workers
ronda ~2GB; si se dispara, suele ser un pico de concurrencia (transitorio) o un leak (reiniciar).

## Sección 10 — SslCertExpiringSoon (<14 días)

1. El renovador (certbot/acme) debería correr solo. Verificar que la tarea existe.
2. Forzar renovación si hace falta y recargar nginx.

## Sección 11 — Backups (recaudo, no alerta)

- PostgreSQL: pgBackRest + WAL → restore con PITR.
- Verificar periódicamente que el backup corre y que un restore de prueba funciona.
  Un backup que nunca se probó no es un backup.

---

## Cómo silenciar una alerta (mantenimiento planificado)

Alertmanager (http://localhost:9093) → "Silences" → New Silence → matchear por `alertname`
y poner duración. Evita el spam durante un deploy o mantenimiento conocido.

## Probar el canal de alertas

```bash
docker exec ia_alertmanager wget -qO- \
  --post-data='[{"labels":{"alertname":"Test","severity":"warning"},"annotations":{"summary":"prueba"}}]' \
  --header='Content-Type: application/json' http://localhost:9093/api/v2/alerts
```
A los ~30s (group_wait) debería llegar el email. Logs: `docker logs ia_alertmanager --since 60s`.
