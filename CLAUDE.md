# CLAUDE.md — Plataforma de Conocimiento con IA

> Este archivo es la fuente de verdad del proyecto. Leelo completo antes de escribir cualquier línea de código.
> Antes de arrancar cada sesión: `cat progress.json`

---

## Qué es este sistema

Plataforma SaaS multitenancy que permite a organizaciones centralizar y consultar su conocimiento institucional mediante lenguaje natural. El sistema ingesta documentos, los procesa con IA, detecta duplicados, valida calidad y responde consultas en 2–4 segundos con >95% de precisión.

Cada empresa (tenant) que contrata el servicio ve únicamente sus propios documentos, usuarios e intenciones — completamente aislados de otros clientes.

---

## Stack tecnológico

### Backend
| Componente | Tecnología | Versión |
|---|---|---|
| API Framework | FastAPI | 0.111+ |
| Runtime | Python | 3.11+ |
| Task queue | Celery + Redis | 5.3+ |
| Reverse proxy | Nginx | 1.25+ |
| Contenedores | Docker Compose | v2+ |

### Frontend
| Componente | Tecnología | Versión |
|---|---|---|
| Framework | Next.js | 14+ |
| UI | React + TypeScript | 18+ / 5+ |
| Estilos | Tailwind CSS | 3.4+ |
| Componentes | ShadCN/ui | latest |
| State server | React Query | 5+ |
| State client | Zustand | 4+ |

### Bases de datos
| Componente | Tecnología | Versión | Rol |
|---|---|---|---|
| Base relacional | PostgreSQL | 16+ | Fuente de verdad, metadatos, usuarios |
| Extensión vectorial | pgvector | 0.7+ | Backup de Qdrant |
| Graph DB | Neo4j | 5.x | Relaciones Persona→Rol→Horario→Dominio |
| Vector search | Qdrant | 1.9+ | Embeddings RAG + intenciones |
| Cache + cola | Redis | 7.2+ | DB 0: Celery broker · DB 1: cache respuestas · DB 2: rate limiting |

### IA / ML
| Rol | Tecnología | Notas |
|---|---|---|
| LLM principal | Groq API | `llama-3.3-70b-versatile` (velocidad) + `meta-llama/llama-4-maverick-17b-128e-instruct` (razonamiento). Sin modelos locales. |
| NER / NLU | GLiNER large-v2.1 | Corre local en backend |
| Embeddings | multilingual-e5-large | 1024 dims. Multilingüe (soporta español y 100+ idiomas). Reutilizado por clasificador y RAG. Ver decisión en sección de arquitectura. |
| Reranker | bge-reranker-large | Corre local |
| Clustering | HDBSCAN | Clustering nocturno de intenciones |

---

## Arquitectura por capas

```
CLIENTE          →  Navegador Web | Widget Embebido
FRONTEND         →  Next.js 14 + React 18 + TypeScript
GATEWAY          →  Nginx (SSL, rate limiting por tenant)
TENANT RESOLVER  →  Middleware FastAPI: identifica tenant vía subdominio/JWT/header
BACKEND          →  FastAPI async + Celery workers
IA / ML          →  Groq API + modelos locales (GLiNER, bge-large, reranker, HDBSCAN)
DATOS            →  PostgreSQL | Neo4j | Qdrant | Redis
```

### Flujo de una consulta
1. Request llega a Nginx → rate limit por tenant → backend FastAPI
2. Middleware extrae tenant_id → configura schema PG + colección Qdrant + base Neo4j
3. Paralelo: clasificador intenciones (bge-large) + NLU GLiNER + check Redis cache
4. Cache hit → respuesta en ~50ms
5. Cache miss → Orquestador elige modelo Groq según complejidad: `llama-3.3-70b-versatile` (velocidad, consultas estándar) o `llama-4-maverick-17b-128e-instruct` (razonamiento, consultas complejas)
6. Consulta PG + Neo4j + Qdrant en paralelo via asyncio.gather()
7. Reranker ordena resultados → LLM genera respuesta
8. Celery persiste log en background (no bloquea respuesta)
9. Respuesta al usuario: ~1.2s (`llama-3.3-70b-versatile`) / ~3s (`llama-4-maverick`)

---

## Multitenancy

### Estrategia de aislamiento
- **PostgreSQL**: schema separado por tenant (`tenant_{id}.documentos`, `tenant_{id}.usuarios`, etc.)
- **Qdrant**: colección separada (`{tenant_id}_docs`, `{tenant_id}_intenciones`)
- **Neo4j**: base de datos separada por tenant
- **Redis**: prefijo de clave (`{tenant_id}:cache:{hash}`)
- **Modelos**: artefactos en `/models/{tenant_id}/`

### Tabla global `usage_events`
Existe en el schema global (no por tenant). Registra cada consulta, ingesta y token LLM consumido:

```sql
CREATE TABLE usage_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   TEXT NOT NULL,
    event_type  TEXT NOT NULL,  -- 'query' | 'ingest' | 'llm_tokens'
    value       INTEGER NOT NULL,
    metadata    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON usage_events (tenant_id, created_at);
```

Esta tabla es la base para facturación, detección de abuso y cuotas. Claude Code debe crearla en las migrations globales de la Etapa 1, no en Etapa 2.

### Decisión: `search_path` por conexión en el middleware
El middleware de FastAPI debe setear `SET search_path TO tenant_{id}` en cada conexión PG antes de ejecutar cualquier query. Implementar en `database.py` como event listener de SQLAlchemy. Sin esto, las queries van al schema `public` y el aislamiento falla silenciosamente.
1. Subdominio: `empresa.dominio.com`
2. JWT claim: `{ tenant_id: "empresa" }`
3. Header HTTP: `X-Tenant-ID: empresa`

### Onboarding de nuevo tenant (transaccional — rollback si falla)
1. Crear registro en tabla global `tenants`
2. `CREATE SCHEMA tenant_{id}` en PostgreSQL
3. Ejecutar migraciones en el nuevo schema
4. Crear colecciones en Qdrant: `{id}_docs`, `{id}_intenciones`
5. Crear base de datos en Neo4j: `{id}`
6. Crear directorio `/models/{id}/`
7. Crear usuario admin inicial
8. Enviar email de bienvenida

---

## Sistema de intenciones dinámico

Las intenciones **no se definen a mano** — emergen de las consultas reales de los usuarios.

### Flujo por nivel de confianza
| Confianza | Acción inmediata | Background | Admin |
|---|---|---|---|
| ≥ 95% | Clasifica y responde | Auto-aprendizaje (cap 30%) | No |
| 70–94% | Responde con LLM fallback | Encola para revisión | Sí — panel validación |
| < 70% | Responde con LLM fallback | Encola urgente + genera 10 ejemplos | Sí — prioritario |
| No reconocida | Responde con LLM | HDBSCAN agrupa nocturnamente | Sí — grupo nuevo |

### Salvaguardas
- Auto-aprendizaje cap 30%: nunca más del 30% de ejemplos auto-aprendidos por intención. Al superarlo, los nuevos ejemplos van al panel admin como "pendientes de revisión" — no se descartan silenciosamente. Ver política completa en sección "Decisiones de comportamiento del sistema".
- Coherencia de grupos: Groq valida antes de mostrar al admin. Grupos incoherentes se subdividen.
- Versioning + rollback: si precisión del modelo nuevo < anterior, revierte automáticamente
- Umbral dinámico: entre 30-100 ejemplos según dispersión de embeddings
- Clusters pequeños (<15 consultas): no se descartan. Se re-evalúan en cada run nocturno. Política completa en sección "Decisiones de comportamiento del sistema".

---

## Estructura de carpetas objetivo

```
/
├── CLAUDE.md                    # Este archivo
├── progress.json                # Estado de avance del proyecto
├── docker-compose.yml           # Orquestación completa
├── .env.example                 # Variables de entorno documentadas
│
├── docs/                        # Documentación: PROMPT.md, OPERACIONES, RUNBOOK, guías, manual
│
├── backend/
│   ├── main.py                  # Entry point FastAPI
│   ├── core/
│   │   ├── config.py            # Settings via pydantic-settings
│   │   ├── database.py          # Conexiones PG, Neo4j, Qdrant, Redis
│   │   ├── tenant.py            # Middleware resolución de tenant
│   │   └── security.py          # JWT, RBAC
│   ├── api/
│   │   ├── v1/
│   │   │   ├── query.py         # Endpoint principal de consulta
│   │   │   ├── ingest.py        # Ingesta de documentos
│   │   │   ├── intentions.py    # Panel de intenciones
│   │   │   ├── tenants.py       # CRUD tenants + generación de widget_token (super-admin)
│   │   │   └── auth.py          # Login, refresh, logout
│   ├── services/
│   │   ├── orchestrator.py      # Decide modelo Groq según complejidad
│   │   ├── retrieval.py         # RAG: embed + qdrant + rerank
│   │   ├── classifier.py        # Clasificador de intenciones por embeddings
│   │   ├── doc_classifier.py    # Detecta tipo de doc: structured/mixed/freeform
│   │   ├── chunker.py           # Pipeline de chunking adaptativo + hierarchical
│   │   ├── nlu.py               # GLiNER wrapper
│   │   ├── quality_gate.py      # Validación factual de chunks (2 etapas)
│   │   └── groq_client.py       # Cliente Groq con routing de modelos
│   ├── workers/
│   │   ├── celery_app.py        # Config Celery
│   │   ├── ingest_tasks.py      # Pipeline de ingesta async
│   │   ├── clustering_tasks.py  # HDBSCAN nocturno
│   │   └── training_tasks.py    # Reentrenamiento con rollback
│   ├── models/
│   │   ├── tenant.py            # Schema Pydantic tenant
│   │   ├── query.py             # Schema request/response consulta
│   │   └── document.py          # Schema documento
│   ├── db/
│   │   ├── migrations/          # Alembic migrations
│   │   │   └── global/          # Tablas globales: tenants, usage_events
│   │   └── schemas/             # SQL schemas por tenant
│   └── tests/
│       ├── test_query.py
│       ├── test_ingest.py
│       ├── test_classifier.py
│       ├── test_tenant.py
│       └── test_cross_tenant.py  # Tests de contaminación: tenant A no ve datos de tenant B
│
├── frontend/
│   ├── app/                     # Next.js App Router
│   │   ├── (auth)/              # Login, registro
│   │   ├── (dashboard)/         # Interfaz principal de consulta
│   │   └── (admin)/             # Panel admin: documentos, intenciones, usuarios
│   ├── components/
│   │   ├── ui/                  # ShadCN components
│   │   ├── chat/                # Interfaz de consulta
│   │   ├── intentions/          # Panel validación de intenciones
│   │   └── documents/           # Gestión de documentos
│   ├── lib/
│   │   ├── api.ts               # Cliente API
│   │   └── store.ts             # Zustand stores
│   └── public/
│       └── widget/              # Widget embebible JS
│
├── nginx/
│   └── nginx.conf               # Config con tenant routing por subdominio
│
└── scripts/
    ├── provision_tenant.py      # Onboarding transaccional de nuevo tenant
    ├── seed_dev.py              # Datos de desarrollo
    └── rollback_tenant.py       # Rollback manual de tenant
```

---

## Variables de entorno requeridas

```bash
# Groq
GROQ_API_KEY=
GROQ_MODEL_FAST=llama-3.3-70b-versatile
GROQ_MODEL_REASONING=meta-llama/llama-4-maverick-17b-128e-instruct

# PostgreSQL
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DB=platform
POSTGRES_USER=
POSTGRES_PASSWORD=

# Neo4j
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=

# Qdrant
QDRANT_HOST=qdrant
QDRANT_PORT=6333

# Redis — tres bases separadas, no una sola
# DB 0: Celery broker (jobs). Si Redis se reinicia, los jobs de DB 0 se pierden → usar siempre DB 0 solo para broker
# DB 1: Cache de respuestas (TTL 1h, efímero, pérdida aceptable)
# DB 2: Rate limiting por tenant (efímero, pérdida aceptable)
REDIS_URL_BROKER=redis://redis:6379/0
REDIS_URL_CACHE=redis://redis:6379/1
REDIS_URL_RATELIMIT=redis://redis:6379/2

# JWT
JWT_SECRET_KEY=
JWT_ALGORITHM=HS256
JWT_EXPIRE_MINUTES=60

# App
ENVIRONMENT=development
LOG_LEVEL=INFO
ALLOWED_ORIGINS=http://localhost:3000
BASE_DOMAIN=localhost  # En producción: tudominio.com

# Email (onboarding)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
```

---

## Decisiones de arquitectura clave

### Modelos Groq en uso y criterio de selección
El orquestador usa dos modelos según complejidad de la consulta:
- **Velocidad**: `llama-3.3-70b-versatile` — consultas estándar, clasificación, respuestas directas (~1.2s, 630 t/s en Groq)
- **Razonamiento**: `meta-llama/llama-4-maverick-17b-128e-instruct` — consultas complejas, multi-step, síntesis de múltiples fuentes (~3s, 297 t/s). Arquitectura MoE 17B activos / 400B totales. Reemplaza a llama-3.1-405b que no está disponible en Groq.

Nota: `llama-3.1-405b` nunca estuvo en producción en Groq. Los IDs de `llama-3.1-70b-versatile` retornan error desde enero 2025 — usar siempre `llama-3.3-70b-versatile`.

### Latencia por etapa — targets para el orquestador

Claude Code debe respetar estos números al implementar timeouts en cada capa:

| Etapa | Objetivo | Máximo | Nota |
|---|---|---|---|
| Redis cache check | ~5ms | 20ms | Hit → respuesta total ~50ms |
| Clasificador intenciones | ~60ms | 80ms | Reutiliza embedding, no llama a bge-large de nuevo |
| NLU — GLiNER | 50–100ms | 200ms | Corre en paralelo con clasificador |
| Orquestador (decisión de modelo) | 10–30ms | 50ms | — |
| Query DB (PG + Neo4j + Qdrant) | 30–100ms | 500ms | asyncio.gather() — paralelo |
| Reranker | 50–150ms | 300ms | — |
| LLM llama-3.3-70b | 600–900ms | 1.5s | ~80% de consultas, cuello de botella |
| LLM llama-4-maverick | 2–4s | 7s | ~20% de consultas complejas |
| Log + ejemplos Celery | ~0ms | ~0ms | Background, no bloquea |
| **Total llama-3.3-70b** | **~1.2s** | **2.5s** | SLA cumplido |
| **Total llama-4-maverick** | **~3s** | **8s** | Máximo permitido |

### Por qué Groq y no OpenAI u otro proveedor
Groq ofrece la menor latencia de inferencia del mercado para los modelos llama. La latencia es el atributo de calidad más crítico de este sistema (objetivo 2-4s end-to-end). No se gestionan modelos locales para mantener la infraestructura simple.

### Por qué schema-per-tenant y no columna tenant_id
La columna compartida tiene riesgo de data leak si un query no incluye el filtro. Un schema separado hace que ese error sea imposible a nivel de motor de base de datos. El overhead es mínimo para el volumen esperado (< 500 tenants).

### Por qué Neo4j además de PostgreSQL
Las relaciones Persona→Rol→Horario→Dominio son queries de grafo que en SQL requieren múltiples JOINs costosos. Neo4j las resuelve en tiempo constante. PostgreSQL sigue siendo la fuente de verdad para todo lo demás.

### Decisiones de implementación del grafo Neo4j (críticas)

Tres reglas que deben respetarse en `nlu.py` y en cualquier código que escriba en Neo4j:

**1. MERGE, nunca CREATE para entidades.**
Usar `MERGE (p:Persona {nombre: $nombre, tenant_id: $tenant_id})` en lugar de `CREATE`. Sin esto, un documento que menciona "María García" en 15 chunks genera 15 nodos duplicados que fragmentan los traversals.

**2. Arista `MENCIONADA_EN` obligatoria en cada entidad.**
Cada nodo de entidad debe tener una arista hacia el `chunk_id` de Qdrant:
```cypher
MERGE (p:Persona {nombre: $nombre, tenant_id: $tenant_id})
MERGE (c:Chunk {id: $chunk_id, tenant_id: $tenant_id})
MERGE (p)-[:MENCIONADA_EN]->(c)
MERGE (c)-[:PERTENECE_A]->(doc:Documento {id: $doc_id})
```
Sin esta arista, Neo4j sabe que una entidad existe pero no puede recuperar el contexto documental para fundamentar la respuesta del LLM.

**3. El orquestador decide cuándo usar Neo4j.**
No ir a Neo4j en todas las consultas — solo cuando la query contiene entidades nombradas o relaciones explícitas. Preguntas abstractas ("¿cómo funciona el proceso de aprobación?") van solo a Qdrant. Preguntas con entidades ("¿quién atiende RRHH los miércoles?") van a Neo4j primero. Implementar en `orchestrator.py` como clasificador de intención de query antes del `asyncio.gather()`.

### Circuit breaker para Neo4j
Si Neo4j no responde en 500ms, el orquestador hace fallback a PostgreSQL para relaciones básicas. Implementar con `tenacity` o `circuitbreaker` en el cliente de Neo4j. No dejar que un fallo de Neo4j tire toda la consulta.

### Por qué HDBSCAN y no K-Means para clustering
K-Means requiere especificar el número de clusters (intenciones) de antemano. HDBSCAN los descubre automáticamente desde los datos. Esto es fundamental porque el sistema no tiene intenciones predefinidas.

---

## Decisiones de comportamiento del sistema

Esta sección define qué hace el sistema en casos de borde. Son decisiones de ingeniería tomadas, no pendientes. Claude Code debe implementarlas exactamente como están definidas acá.

### Modelo de embeddings — por qué multilingual-e5-large y no bge-large-en

`bge-large-en-v1.5` es English-only. Los tenants de esta plataforma operan en español. Usar un modelo de embeddings en inglés para corpus en español degrada directamente la calidad semántica del RAG y del clasificador de intenciones desde el primer documento.

**Decisión:** `multilingual-e5-large` (Microsoft). Misma dimensionalidad (1024 dims), compatible con el schema de Qdrant ya definido, soporta 100+ idiomas incluyendo español. Sin cambio en la interfaz de código — mismo `sentence-transformers` API.

**NUNCA usar `bge-large-en-v1.5` en este proyecto.** Si aparece en algún ejemplo de código o dependencia, reemplazarlo.

### Modelo Groq — ID prohibido

**NUNCA usar `llama-3.1-405b` como model ID.** No existe en la API de Groq y retorna error 404. Los únicos IDs válidos están en las variables de entorno `GROQ_MODEL_FAST` y `GROQ_MODEL_REASONING`. Si algún archivo de código, comentario o prompt lo menciona, es un bug que debe corregirse.

### Quality Gate — comportamiento ante fallo de Groq

Si la API de Groq falla durante la validación de un chunk en ingesta, el sistema **no bloquea el pipeline**. El comportamiento definido es:

1. Marcar el chunk con `quality_gate_status: 'pending'` en su metadata de Qdrant
2. Indexar el chunk igualmente — es mejor tener un chunk no validado que no tener el documento ingestado
3. Encolar una tarea Celery de re-validación con backoff exponencial (1m, 5m, 30m, 2h)
4. Si después de 3 reintentos sigue fallando, marcar como `quality_gate_status: 'skipped'` y loguear

Los chunks con `quality_gate_status: 'pending'` o `'skipped'` participan en las búsquedas pero el admin puede verlos diferenciados en el panel de documentos.

### Estrategia de chunking en MVP (Etapa 1)

El chunking semántico avanzado está en Etapa 3, pero la ingesta empieza en Etapa 1. El MVP usa **fixed-size con overlap** como baseline funcional:

- Tamaño: **512 tokens** por chunk
- Overlap: **64 tokens** entre chunks consecutivos
- Librería: `langchain_text_splitters.RecursiveCharacterTextSplitter` con `chunk_size=512, chunk_overlap=64`
- El campo `chunk_level` en Qdrant payload se setea como `'flat'` en MVP (sin jerarquía padre-hijo todavía)
- El campo `parent_id` se setea como `null` en MVP — Etapa 3 lo populará

Esta estrategia es explícita y no ambigua. No improvisar otro approach.

### Widget embebible — contrato de autenticación

El widget no puede usar cookies HttpOnly (cross-origin) ni exponer JWTs de usuario. El modelo de autenticación del widget es:

1. El admin del tenant genera un **widget_token** desde el panel admin (endpoint `/api/v1/tenants/widget-token`)
2. El `widget_token` es un JWT de larga duración (90 días) con scope limitado: solo lectura, solo queries, solo ese tenant
3. El tenant instala el widget con: `<script src="..." data-token="WIDGET_TOKEN"></script>`
4. El widget lo incluye como `Authorization: Bearer WIDGET_TOKEN` en cada request
5. El backend valida que el token tenga scope `widget` antes de procesar la consulta

El `widget_token` NO tiene acceso a ingesta, panel admin ni datos de usuario. Si se compromete, el admin puede revocarlo sin afectar al resto del tenant.

### Cap del 30% — comportamiento al superarlo

Cuando una intención alcanza el 30% de ejemplos auto-aprendidos, el sistema no descarta ni ignora los nuevos ejemplos. El comportamiento es:

1. El ejemplo nuevo se guarda en `consultas_log` con `auto_learning_blocked: true`
2. Se encola en el panel admin bajo "Ejemplos pendientes de revisión" de esa intención
3. El admin puede aprobar (convierte en ejemplo validado y descuenta del auto-learning count) o descartar
4. El sistema nunca elimina ejemplos silenciosamente — siempre van a algún estado visible

El cap del 30% aplica por intención, no globalmente. Una intención con 200 ejemplos donde 60 son auto-aprendidos está en el límite; otra intención con 10 ejemplos puede auto-aprender libremente.

### Clusters HDBSCAN pequeños — política de retención y descarte

Grupos con menos de 15 consultas no se presentan al admin pero no se descartan. El comportamiento:

1. Las consultas sin cluster asignado mantienen `cluster_candidate_id: null` en `consultas_log`
2. En cada run nocturno de HDBSCAN, se re-evalúan todas las consultas sin cluster (incluyendo las acumuladas de runs anteriores)
3. Si un grupo acumula 15+ consultas en cualquier run posterior, sube al panel admin normalmente
4. Si después de **60 días** un conjunto de consultas semánticamente similares no alcanzó 15, se marcan como `cluster_status: 'dismissed'` — se excluyen de futuros runs pero **no se eliminan** (sirven para auditoría y análisis manual)
5. La limpieza de 90 días aplica solo a consultas con `cluster_status: 'dismissed'` y `quality_gate_status: 'skipped'` — nunca a consultas activas o pendientes

Agregar índice en `consultas_log (cluster_status, created_at)` para que el run nocturno no haga full scan.

---

## SLAs y atributos de calidad

| Atributo | Objetivo | Máximo |
|---|---|---|
| Tiempo de respuesta (llama-3.3-70b-versatile) | ~1.2s | 2.5s |
| Tiempo de respuesta (llama-4-maverick) | ~3s | 8s |
| Cache hit response | ~50ms | 200ms |
| Precisión de respuestas | >95% | — |
| Disponibilidad | 99.5% | — |
| Usuarios concurrentes | 50 | 200 (escala vertical) |

---

## Planes de tenant

| Límite | Starter | Professional | Enterprise |
|---|---|---|---|
| Usuarios | 5 | 50 | Ilimitado |
| Documentos | 500 | 10.000 | Ilimitado |
| Consultas/mes | 5.000 | 100.000 | Ilimitado |
| Tamaño doc | 10 MB | 50 MB | 200 MB |
| Intenciones | 10 | 100 | Ilimitado |
| SLA | 99% | 99.5% | 99.9% |

---

### Seguridad

- **Autenticación**: JWT con refresh tokens en cookies HttpOnly
- **Autorización**: RBAC (admin / operador / usuario). Validado en cada endpoint.
- **SSO**: OAuth 2.0 / OpenID Connect (Google Workspace, Azure AD)
- **Cifrado en tránsito**: TLS 1.2/1.3 terminado en Nginx
- **Cifrado en reposo**: AES-256 a nivel de volumen para PG, Qdrant, Redis
- **Prompt injection**: input del usuario siempre en variable aislada dentro de template fijo, nunca concatenado al prompt crudo
- **Sanitización**: truncar y normalizar inputs antes de enviar al LLM, eliminar caracteres de control
- **Puertos públicos**: solo 80 y 443. PG, Neo4j, Qdrant, Redis solo accesibles dentro de la red Docker
- **API keys**: nunca en código — siempre en variables de entorno o secrets manager
- **Imágenes Docker**: versiones fijas en producción (no `latest`). Trivy escanea vulnerabilidades en CI
- **Dependencias**: `pip-audit` y `npm audit` mensual. Parches críticos en 48h

### Backup

- **PostgreSQL**: pgBackRest + WAL streaming → S3-compatible. Backup diario + PITR desde el MVP, no como afterthought
- **Neo4j**: dump diario → S3
- **Qdrant**: los embeddings se regeneran desde documentos originales — menor prioridad
- **Redis**: no requiere backup (cache efímera)

Configurar pgBackRest en docker-compose desde la Etapa 1. No es opcional.

---

### Riesgos críticos a tener en cuenta durante la implementación

| Riesgo | Mitigación concreta |
|---|---|
| Cross-tenant data leak | Middleware valida tenant en cada request. `test_cross_tenant.py` en CI obligatorio |
| Fallo de Neo4j | Circuit breaker con fallback a PG. Nunca dejar que un timeout de Neo4j tire toda la consulta |
| Prompt injection | Template fijo + input del usuario en variable aislada. Nunca `f"...{user_input}..."` en prompts |
| Duplicados en grafo | `MERGE` siempre, nunca `CREATE` en Neo4j. Clave de unicidad: `(nombre_normalizado, tenant_id)` |
| Regresión en modelo de intenciones | Versioning + rollback automático si precisión nueva < anterior |
| Tenant ruidoso | Rate limiting por tenant en Nginx + caps de CPU/RAM por contenedor en Docker Compose |

---

## Plan de implementación

### Etapa 1 — MVP (arrancar aquí)
- [ ] docker-compose.yml con todos los servicios (incluye pgBackRest desde el día 1)
- [ ] FastAPI base con middleware de tenant + `search_path` por conexión
- [ ] Autenticación JWT + RBAC básico + scope `widget` para widget_token
- [ ] Conexiones a PG, Neo4j, Qdrant, Redis (3 DBs separadas: broker/cache/ratelimit) con circuit breaker en Neo4j
- [ ] Migrations Alembic: schema global (`tenants`, `usage_events`) + schema por tenant (incluye índices en `consultas_log`)
- [ ] Script de onboarding transaccional de tenant con rollback completo
- [ ] Pipeline de ingesta con chunking fixed-size (512 tokens, 64 overlap) + quality gate con fallback ante fallo de Groq
- [ ] Endpoint de consulta: embed → qdrant → rerank → groq → respuesta
- [ ] Clasificador de intenciones básico por similitud (usando `multilingual-e5-large`)
- [ ] Tabla `consultas_log` con guardado async (campos: `cluster_status`, `auto_learning_blocked`, `quality_gate_status`)
- [ ] Tabla `usage_events` global para facturación y cuotas
- [ ] Neo4j: MERGE de entidades con arista `MENCIONADA_EN → chunk_id`
- [ ] Endpoint `POST /api/v1/tenants/{id}/widget-token` para generación de widget_token
- [ ] Widget embebible básico (JS vanilla) con autenticación por `widget_token`
- [ ] Tests unitarios de servicios core + `test_cross_tenant.py`

### Etapa 2 — Consolidación
- [ ] Prometheus + Grafana + Loki + Promtail
- [ ] Panel de validación de intenciones (frontend)
- [ ] HDBSCAN clustering nocturno (Celery beat)
- [ ] Reentrenamiento automático con versioning y rollback
- [ ] Frontend Next.js completo (dashboard + admin)
- [ ] SSO OAuth 2.0
- [ ] Panel super-admin: gestión de tenants y planes

### Etapa 3 — Optimización
- [ ] OpenTelemetry + Jaeger tracing
- [ ] `doc_classifier.py` + `chunker.py`: pipeline adaptativo completo (ver sección "Pipeline de ingesta y chunking")
- [ ] Hierarchical chunking: campo `parent_id` en Qdrant payload, padres en PostgreSQL
- [ ] Quality gate etapa 2: validación de autonomía semántica por chunk
- [ ] Semantic chunking para docs free-form con bge-large (umbral coseno configurable vía env)
- [ ] LLM-guided chunking solo si semantic chunking resulta insuficiente en producción
- [ ] Query federation optimizada (PG + Neo4j + Qdrant con timeouts independientes)
- [ ] Cache Redis avanzado con embeddings precalculados
- [ ] Evaluación de infraestructura propia de modelos

---

## Instrucciones para Claude Code

1. **Empezá siempre con** `cat progress.json` para saber dónde estamos
2. **Trabajá en orden** según el plan de Etapa 1 — no saltees pasos
3. **Después de cada paso completado**, actualizá `progress.json`
4. **Si un paso falla**, documentá el error en `progress.json` bajo `blockers` y continuá con el siguiente si es posible
5. **Creá tests** junto con cada módulo, no al final
6. **Usá `tree backend/`** después de crear archivos para verificar la estructura
7. **Nunca hardcodeés** secrets, URLs de bases de datos ni configuración — siempre `.env`
8. **Si necesitás tomar una decisión de diseño** no cubierta en este archivo, documentala en `progress.json` bajo `decisions` antes de implementarla
