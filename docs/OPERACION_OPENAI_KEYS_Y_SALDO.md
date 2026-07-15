# Operación — Keys de OpenAI y control de saldo

> Runbook operativo. Nace del incidente **2026-07-10**: una auditoría masiva
> concurrente consumió la cuota compartida de OpenAI (`insufficient_quota`) y el
> bot de producción quedó degradado para consultas nuevas hasta recargar crédito.
> El objetivo de este documento es que eso **no vuelva a pasar**.

## Las tres keys (separación de responsabilidades)

| Setting (`.env`) | Prefijo | Rol | Quién la usa |
|---|---|---|---|
| `OPENAI_API_KEY` | `sk-…` | **Inferencia de producción** — sirve el bot en vivo (LLM + embeddings si `embedding_provider=openai`) | Backend/workers en prod |
| `OPENAI_ADMIN_API_KEY` | `sk-admin-…` | **Solo lectura de billing** — `GET /v1/organization/costs` | `services/openai_billing.py`, panel de costos |
| `OPENAI_TEST_API_KEY` | `sk-…` | **Evaluaciones y tests** — rag_eval, auditorías masivas, load tests | Scripts de eval, corridas locales/CI |

**Regla de oro:** las evaluaciones y auditorías **nunca** deben usar
`OPENAI_API_KEY`. Usan `OPENAI_TEST_API_KEY`. Así, una corrida de pruebas que
consuma toda su cuota agota su propio presupuesto — no el que sirve al cliente.

## Hard budget cap (lo que previene el incidente)

En el dashboard de OpenAI (**Settings → Limits**), configurar por proyecto/key:

1. Crear un **proyecto separado** para la key de testing.
2. En ese proyecto, setear un **hard limit** (no solo "soft/alert"). Al alcanzarlo,
   OpenAI **rechaza** más requests de esa key — las pruebas fallan de forma
   contenida, la key de producción sigue intacta.
3. En el proyecto de producción, setear un **soft alert** (email) a ~70-80% del
   presupuesto mensual esperado, y un hard limit por encima como red de seguridad.

El hard cap en la key de testing es la barrera que faltaba el 2026-07-10.

## Monitoreo de gasto desde el sistema

La Costs API de OpenAI **no expone el saldo/crédito restante** (deprecado); solo
el **gasto incurrido**. Por eso la alerta es por **umbral de gasto**, no por saldo:

- `services/openai_billing.get_costs(days)` → gasto total del período.
- `services/openai_billing.check_spend_alert(threshold_usd, days)` → `{breached, pct}`.
  Loguea `openai_spend_alert` (nivel WARNING) al superar el umbral. Conectar a un
  beat de Celery + notificación (email/WhatsApp del operador) para aviso proactivo.

> Nota: `check_spend_alert` mide gasto de la **organización**, no por key. Para
> aislar el gasto de testing vs producción, separá por **proyecto** en OpenAI y
> consultá la Costs API con el `project_id` correspondiente cuando se necesite el
> desglose (mejora futura; hoy el total de org alcanza para la alerta de techo).

## Runbook: bot degradado por `insufficient_quota`

Síntomas: el bot responde "el servicio no está disponible" / "declino" a
consultas **nuevas** (las cacheadas siguen bien); logs con `insufficient_quota`
(HTTP 429 de tipo billing, **no** rate-limit temporal — no se auto-cura).

1. Confirmar tipo de 429: `insufficient_quota` = crédito agotado (billing);
   `rate_limit_exceeded` = temporal (esperar/backoff). Solo el primero requiere plata.
2. Recargar crédito en OpenAI (Billing → Add credit) **o** subir el hard limit del
   proyecto de producción.
3. Verificar recuperación: una consulta nueva vuelve a responder.
4. Si hubo indexaciones fallidas durante la degradación (ej. ejemplos de
   intenciones que no llegaron a Qdrant), el beat nocturno
   `nightly-data-consistency` (`data_consistency_all_tenants`, 4:00) reconcilia
   PG↔Qdrant automáticamente. Para reparar YA, correr manualmente
   `reconcile_intents_task(tenant_id)`.

## Checklist de prevención

- [ ] `OPENAI_TEST_API_KEY` seteada y apuntando a un proyecto con **hard cap**.
- [ ] Scripts de eval/auditoría usan la key de testing, nunca la de inferencia.
- [ ] Soft alert por email en el proyecto de producción (~70-80% del budget).
- [ ] `check_spend_alert` cableado a un aviso proactivo al operador.
- [ ] Las evaluaciones corren **secuenciales**, no concurrentes sobre la misma key
      (la concurrencia sobre una key compartida genera rechazos espurios además de
      drenar cuota — lección del 2026-07-10).
