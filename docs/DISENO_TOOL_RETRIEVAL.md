# Diseño — Tool Retrieval (pre-filtro top-K del catálogo)

> Estado: propuesta de diseño (2026-07-25). No implementado.
> Contexto: auditoría del tool calling — ver memoria `project-tool-calling-audit-2026-07-25`.
> Prerrequisito ya hecho: ruteo unificado único (se eliminó el modo `tool_calling`).

## 1. Problema

Hoy el catálogo COMPLETO de tools del tenant se inyecta en cada llamada RAG
(`_build_tool_schemas(list_tools_for_tool_calling(tenant))`).

- 19 tools ≈ **2.000 tokens** en cada turno. El plan Enterprise permite tools
  **ilimitadas**: 100 tools ≈ **10.000+ tokens** en *cada* llamada.
- El costo y la latencia crecen **lineal con el nº de tools**, aunque la consulta
  use una sola.
- Peor aún: la **precisión del ruteo cae** cuando el LLM ve decenas de opciones
  parecidas (más colisiones entre tools de nombres/descripciones similares).

Se eliminó el clasificador de intenciones por coseno (ruteaba mal, 1/11 en CRM),
pero eso dejó un hueco: **no hay pre-filtrado del catálogo**. Funciona con 19
tools; no escala a tenants con muchos conectores.

## 2. Solución

**Retrieval + decisión** (patrón estándar de agentes con muchas tools):

1. Un **retriever semántico** recupera las **top-K** tools más parecidas a la
   consulta (barato, sub-100ms, reusa la infra de embeddings del RAG).
2. El **LLM decide** entre esas K (no entre las N del tenant). El prompt queda de
   tamaño **constante** sin importar cuántas tools tenga el tenant.

Combina el recall de un retriever con la precisión de decisión del LLM. La señal
de retrieval más fuerte son los `examples` (frases de ejemplo) que ya se guardan
por tool — exactamente para lo que sirven.

```
consulta ──► embed ──► Qdrant {tenant}_tools ──► top-K tools ──┐
                                                                ├─► _build_tool_schemas(K) ─► LLM decide
   tools "fijadas" (sesión/login en curso) ─────────────────────┘
```

## 3. Componentes

### 3.1 Colección Qdrant por tenant: `{tenant_id}_tools`
Aislada por tenant, igual que `{tenant}_docs` y `{tenant}_intenciones`. Un punto
por tool activa. Payload: `{slug, identity_kind}`. Vector: embedding de
`description + " · " + " ".join(examples)` con `multilingual-e5-large` (1024 dims,
el mismo modelo del RAG — sin infra nueva).

### 3.2 Indexación (mantener el índice al día)
El embedding de una tool se re-genera y hace `upsert` cuando cambia su texto:
- al **detectar/aplicar** un conector (`connectors_dao` apply),
- al **editar** una tool (CRUD de la pantalla de conectores),
- al **desactivar** conector/tool → `delete` del punto (coherencia con el filtro
  `is_active` del catálogo).
Backfill inicial: script que recorre `connector_tools` activas y las embeddea
(one-off, como el bootstrap del RAG). Barato: decenas de tools por tenant.

### 3.3 Runtime — pre-filtro antes de armar el catálogo
Nuevo servicio `services/tool_retrieval.py`:

```python
async def select_catalog(tenant_id: str, query: str, *,
                         pinned_slugs: set[str] = frozenset(),
                         k: int = settings.tool_retrieval_top_k) -> list[dict]:
    """Devuelve el subconjunto de tools (dicts del catálogo) a ofrecer al LLM:
    top-K por similitud con la query + las 'pinned' (continuidad de sesión).
    Fail-open: ante cualquier fallo, devuelve el catálogo completo (como hoy)."""
```

Se llama en los dos puntos que hoy arman el catálogo completo:
- `api/v1/widget_conversation.send_message` (decisión inicial de tool).
- `services/orchestrator._try_tool_pick` (rama hard-fallback).

`_build_tool_schemas` no cambia: recibe la lista ya filtrada.

### 3.4 Tools "fijadas" (pinned) — no perder continuidad
Siempre incluir, además del top-K:
- La familia de la tool con **sesión/login activo** (para que un follow-up
  personal no quede fuera del catálogo por un embedding pobre).
- Umbral mínimo de similitud: si menos de K superan el umbral, se ofrecen solo
  las que pasan (no rellenar con ruido).

### 3.5 El loop agéntico
`_run_tool_and_format` arma su propio `loop_catalog` (ya filtra por
`identity_kind`/sesión). Ahí el contexto es la conversación (encadenado
lista→detalle), no la query inicial → **mantener el catálogo completo alcanzable
en el loop** (es post-decisión y de baja frecuencia). El pre-filtro aplica solo a
la DECISIÓN inicial, que es el turno caliente y el que domina el costo.

## 4. Config

```python
tool_retrieval_enabled: bool = True     # feature flag (fail-open al catálogo completo)
tool_retrieval_top_k: int = 8           # tools ofrecidas al LLM
tool_retrieval_min_score: float = 0.30  # umbral de similitud (coseno e5)
```

Con ≤ `top_k` tools activas, el pre-filtro es un no-op (se ofrecen todas) → cero
cambio de comportamiento para tenants chicos como intellix (19 tools, K=8 igual
conviene medir antes de bajar de todas a 8).

## 5. Métricas (guardia de calidad)
- `tool_catalog_size` (histograma): nº de tools ofrecidas por turno. Objetivo: ~K.
- **`tool_retrieval_hit`** (contador): ¿la tool que el LLM eligió estaba en el
  top-K? Es LA métrica de guardia — si baja de ~99%, K o el umbral están cortando
  la tool correcta. Se mide comparando el slug elegido contra el conjunto ofrecido.
- `tool_retrieval_latency_ms`: el embed + Qdrant search debe ser < 100ms.

## 6. Riesgos y mitigación
| Riesgo | Mitigación |
|---|---|
| La tool correcta no entra en top-K (miss de recall) | Umbral generoso + `examples` como señal fuerte + pinned de sesión + monitorear `tool_retrieval_hit` (alertar si < 99%) |
| Índice desactualizado (tool nueva sin embedding) | Upsert en el CRUD/apply; el catálogo SQL sigue siendo la fuente de verdad — una tool sin embedding se puede incluir siempre hasta que se indexe |
| Fallo del retriever en el hot path | Fail-open al catálogo completo (comportamiento actual) — nunca rompe el turno |
| Otra colección Qdrant por tenant | Mismo patrón ya existente (`_docs`, `_intenciones`); crear/borrar en onboarding/offboarding de conector |

## 7. Rollout
1. Colección + indexación + backfill (sin tocar runtime todavía).
2. `select_catalog` con flag **off** por default → medir `tool_retrieval_hit` en
   shadow (calcular el top-K y comparar contra la elección real, sin filtrar aún).
3. Con hit-rate ≥ 99% en shadow, activar el flag por tenant.
4. Ajustar `top_k`/`min_score` por telemetría.

## 8. Resultado esperado
- Prompt de tamaño **constante** (~K tools) sin importar cuántas tenga el tenant
  → costo de tokens y latencia dejan de crecer con el catálogo.
- Mejor precisión de ruteo en tenants grandes (menos opciones que confundan).
- Escala a Enterprise (tools ilimitadas) sin degradar.
