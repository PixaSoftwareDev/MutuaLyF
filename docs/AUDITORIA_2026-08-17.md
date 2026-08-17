# Auditoría de estabilidad — 17/08/2026 (feriado)

> Objetivo pedido por Alejo: no crecer en features — validar que TODO lo que
> existe funcione (visual, clicks, comportamiento), el bot calibrado, y nada
> roto. Método: evidencia, no intuición. Clicks destructivos SOLO en staging
> con un tenant descartable; prod solo lectura + los deploys aprobados.

## Veredicto general

La plataforma está sana. Se encontraron 3 cosas rotas — las 3 se arreglaron y
validaron el mismo día (2 eran fixes de agosto atrapados en dev-local que nunca
se pasaron; ver "Lección" al final).

## 🟢 Validado con evidencia

| Qué | Cómo se validó |
|---|---|
| **Backup restaurable** | Restore real del diario 17/08 en base copia: 6 conteos idénticos a la base viva (18 docs, 658 chunks, 1.061 conv, 6.328 msgs, 22 usuarios, 4 schemas). Copia borrada al terminar. |
| **Ciclo de vida completo de un cliente** | En staging, por UI: alta de organización → onboarding 4 pasos (incl. generación IA de la descripción) → subir doc → procesado (4 fragmentos) → **el bot respondió el dato exacto del doc, voseando, y la repregunta "¿y los sábados?" también** (condensación E2E) → suspensión → eliminación con limpieza total verificada (PG + Qdrant). |
| **Panel completo sin errores** | Superadmin (inicio/orgs/monitoreo/errores/backups/métricas) + admin (conversaciones/derivación/canales/equipo/métricas/duplicados): cero errores de consola inesperados en todo el recorrido. |
| **Operaciones** | SSL 2-3 meses y auto-renovando · disco 22% · RAM 23GB libres · restart policies OK · alertas → alemaros20@gmail.com vía Resend · crons de beat puntuales · worker 0 errores/24h. |
| **Superficies públicas** | widget.js 200 (prod+staging) · /query sin auth → 401 · webhook WhatsApp sin token Meta → 403 · aislamiento cross-tenant cubierto por suite (353/354; el rojo es de entorno local, preexistente y verificado ajeno). |

## 🔴 Roto → arreglado y deployado HOY (staging + prod)

1. **Alta de organizaciones rota** (`AmbiguousParameterError` al asignar la
   personalidad): 500 al superadmin + tenant fantasma activo a medias. El fix
   (`fix(tenants): la auto-asignación…`, CAST en AUTO_ASSIGN_SQL + test que
   hace PREPARE real) existía desde el 06/08 SOLO en dev-local. Validado E2E
   en staging por esta auditoría; en prod desde hoy.
2. **Tenant nuevo nacía sin 2 columnas** de la migración 029
   (`external_message_id`/`delivery_status`) → el detalle de conversaciones
   daría 500. Fix (`fix(provision): tenant_schema.sql al día…`) también
   estaba atrapado en dev-local. En staging + prod desde hoy.
3. **Warmup roto al arrancar** (importaba el reranker eliminado en julio):
   4 warnings por arranque y primera consulta fría. Fix `chore(arranque)`
   deployado; verificado: 0 warnings en el arranque nuevo de prod.

## 🟠 Roto en staging (workaround puesto, fix permanente pendiente)

**Staging no procesa documentos**: su broker Celery es Redis DB 3 y no existe
ningún worker que consuma de ahí (el de prod escucha DB 0). Había **9 tareas
colgadas** de intentos de semanas. Workaround del 17/08: worker temporal dentro
de `ia_backend_staging` (`docker exec -d -w /app -e PYTHONPATH=/app
ia_backend_staging celery -A workers.celery_app worker -Q ingest,default
--concurrency=1`) — **muere con el próximo restart del contenedor**. Fix
permanente: agregar servicio celery a `docker-compose.staging.yml`.

## 🟡 A mejorar (por prioridad)

1. **Backups off-site**: los dumps diarios/semanales viven en el MISMO disco
   del VPS. Si muere el servidor entero, mueren los backups. Fix barato:
   copia diaria a un bucket externo. LA recomendación #1 de la auditoría.
2. **Qdrant y MinIO sin respaldo** (solo PG se respalda). Mitigante: el texto
   vigente está en PG → reconstruible, pero con horas + costo de re-embedding.
   Baja de urgencia con el punto 1 resuelto.
3. **Corpus del tenant demo `intellix` pobre**: "¿qué planes tienen?" → "no
   encontré" (honesto: el corpus casi no habla de planes). Es la primera
   pregunta de cualquier prospecto en una demo — cargarle contenido real.
4. **Métricas del superadmin**: los contadores "acumulado desde el inicio" se
   resetean con cada restart del backend (etiqueta engañosa) y el p95 con
   muestra chica da valores absurdos (28,5s sobre 28 requests).
5. Los frentes del motor ya anotados: multi-hop (s_10/s_12), tabla numérica
   (f_19, la fila pierde el encabezado al chunkear), juez que responda lo
   parcial, persistir la señal del trust gate (~50/500 consultas, en logs que
   rotan).

## Pendientes de terceros

- **Josué**: circuito real del grupo familiar en la App (2 respuestas
  contradictorias en el corpus) + resubir docs con mojibake corregido +
  plan de difusión del canal (uso real en caída: lun 35 → jue/vie/dom 0).

## Lección incorporada

Dos de los tres rotos eran **fixes ya escritos que nunca salieron de
dev-local** (06/08 y 02/08). `git cherry -v main dev-local` es el comando que
los delata. Al cerrar cualquier sesión de fixes: decidir explícitamente qué
va a dev/main y qué queda, y anotarlo — un fix sin deployar es un bug vigente.
