# CLAUDE.md — Intellix · Plataforma de Conocimiento con IA

> Fuente de verdad del proyecto, actualizada al **2026-07-27**. Si algo acá
> contradice al código, gana el código — y avisá para corregir este archivo.
> La visión original del proyecto (2026) quedó como documento histórico en
> `docs/PROMPT.md`; varias decisiones de ahí cambiaron en producción.

---

## Qué es este sistema

Plataforma SaaS **multitenant** que permite a organizaciones centralizar su
conocimiento institucional y consultarlo en lenguaje natural (RAG), con
derivación a operadores humanos. Cada tenant ve solo sus documentos, usuarios
y conversaciones.

**Cliente real en producción**: MutuaLyF (Mutual Provincial de Luz y Fuerza de
Santa Fe) — tenant `mutualyf`. El bot atiende afiliados por widget web y
WhatsApp. **Regla de diseño**: el producto es genérico multitenant — prompts y
código NUNCA se atan a un vertical (salud/mutual); lo específico del cliente
vive en configuración (`bot_description`, personalidades, palabras de
derivación, branding).

---

## Stack REAL (no el planificado)

| Rol | Tecnología | Notas |
|---|---|---|
| LLM | **OpenAI `gpt-4o-mini`** | Detrás de nombres históricos "groq" (`groq_client.py`, env `GROQ_*`) — es legacy de naming, NO es Groq. Nada de modelos LLM locales. |
| Embeddings | `multilingual-e5-large` (1024 dims) | Corre local (CPU). Compartido por RAG y clasificador. |
| Reranker | **NO HAY** | `bge-reranker-base` era ciego al español (probado A/B: 0.0 en TODO español) y se eliminó (2026-07-23). Su función la cumple el trust gate. NO reintroducir sin medición contra la suite. |
| Retrieval | Híbrido: Qdrant (vectores) + BM25 (`parent_chunks.ts_body` en PG) + RRF | Small-to-Big: hijos (~150 tokens) en Qdrant, padres (~700) en PG. |
| Anti-alucinación | **Trust gate** (`services/trust_gate.py`) | Cobertura léxica gratis (~75% de consultas) + juez LLM selectivo en zona gris. Fail-open. Validado 33/33 en corpus real. |
| NER / Entidades | GLiNER — **DESACTIVADO** (`ENTITIES_DISABLED`) | Código presente = trabajo futuro, NO borrar. |
| Neo4j | En el compose pero **sin uso activo** | Grafo de entidades = futuro. No borrar el código. |
| Backend | FastAPI + Celery + Redis (3 DBs: broker/cache/ratelimit) | |
| Frontend | Next.js 14 + React 18 + TS + Tailwind + ShadCN | React Query + Zustand. |
| Bases | PostgreSQL 16 (schema por tenant) + Qdrant (colección por tenant) | |
| Storage | MinIO (adjuntos, originales de documentos) | |
| Email | Resend (SMTP) — invitaciones, reset de contraseña, alertas | |

## Flujo de una consulta (real)

1. Widget/WhatsApp → FastAPI → middleware resuelve tenant (`search_path` PG).
2. Normalización + **query rewriter** (variantes) → retrieval híbrido
   multi-query con fusión RRF (`services/retrieval.py`).
3. Si `CONNECTORS_ENABLED` y el router de conectores matchea, el turno lo
   maneja el conector (FSM de identificación, tool calling) y NO se evalúa
   handoff.
4. **Trust gate**: ¿el contexto RESPONDE o solo se parece? Léxico → juez LLM
   selectivo → rechazo honesto/filtrado de chunks.
5. Generación con `gpt-4o-mini` (prompt anti-alucinación de 12 reglas, incluye
   URLs textuales — regla 12).
6. **Handoff** (`services/handoff.py`), 5 reglas: insuficiente xN, pedido de
   humano, frustración, inactividad del operador, y **Regla 5: palabras clave
   por tenant** (responder-y-ofrecer; configurable en el panel Derivación).
7. Cache Redis (exacto + semántico). Logs a `consultas_log` (async).

---

## Ambientes, ramas y deploy

| Ambiente | URL | Rama | Código backend | Frontend |
|---|---|---|---|---|
| **dev-local** | `localhost:3010` (front) / `:8010` (back) | `dev-local` | bind-mount, restart aplica | imagen o `next dev` |
| **Staging** | `dev.intellix.com.ar` | `dev` | `/opt/mutualyf-staging`, bind-mount | horneado (rebuild) |
| **Prod** | `intellix.com.ar` | `main` | `/opt/mutualyf`, bind-mount | horneado (rebuild) |

- SSH VPS: `ssh -i ~/.ssh/mutualyf_vps -p 2251 root@200.58.109.110`
- **Prod y staging comparten PostgreSQL/Qdrant/Redis** (tenants: `mutualyf`
  prod real, `nexo` pruebas de staging, `intellix` demo). Los contenedores son
  independientes.
- **Regla de trabajo (Alejo, 2026-07-27)**: el desarrollo va SIEMPRE en
  `dev-local`. Los pasajes a staging y prod se hacen **solo cuando Alejo lo
  pide** (prod además con OK explícito).
- **Regla de oro de migraciones**: la base comparte `alembic_version` global →
  ambas ramas deben tener el archivo de una revisión ANTES de avanzar la base.
  Cadena convergida e idéntica en `main` y `dev` desde la revisión 044
  (2026-07-26). Migraciones siempre idempotentes (`IF NOT EXISTS`).
- Deploy prod: `git pull` + `restart backend celery_worker celery_beat` (código
  bind-monteado) + `build frontend && up -d frontend` si hubo cambios de front.
  Existe `scripts/deploy.sh` (selectivo, con pre-flight de drift).

## Feature flags por ambiente

| Flag | Dónde | Prod hoy | Efecto |
|---|---|---|---|
| `CONNECTORS_ENABLED` | `.env` backend | **false** | Apaga el router de conectores en conversaciones. |
| `NEXT_PUBLIC_CONNECTORS_UI` | build-arg frontend (`docker-compose.prod.yml`) | **false** | Oculta "Fuentes de datos" en el panel admin (`frontend/lib/features.ts`). |
| `NEXT_PUBLIC_ENABLE_DEV_LOGIN` | build-arg frontend | false (solo builds locales en true) | Panel de acceso rápido del login. Doble gate con hostname localhost. |
| `NEXT_PUBLIC_FEEDBACK_UI` | build-arg frontend (staging y prod en `false`) | **false** | Oculta las caritas al cierre del chat y la cola Feedback del admin hasta validar la feature. |

Conectores está **oculto en prod hasta validarlo** (decisión 2026-07-26).
NUNCA ocultar features comentando código — siempre flags, mismas ramas.

---

## Multitenancy (implementado)

- PG: schema `tenant_{id}` por tenant; middleware setea `search_path` por
  conexión. Tabla global `tenants` + `usage_events` en `public`.
- Qdrant: colecciones `{id}_docs`, `{id}_intenciones`, `{id}_query_cache`.
- `test_cross_tenant.py` en la suite — obligatorio que pase siempre.
- Roles: `super_admin` (plataforma, tabla `platform_users`), `admin`,
  `operator` (tabla `usuarios` por tenant). Login email-first: lookup de
  organización por email y luego password.

## Calidad del motor — cómo se trabaja

`docs/PLAN_CALIDAD_MOTOR.md` gobierna las mejoras del RAG. Regla: **sin mejora
medida no se avanza** — cada cambio corre la suite
(`scripts/run_quality_suite.py`, ~168 casos estratificados: single-turn,
multi-turno, typos, derivación, preguntas trampa) y lo que empeora se
revierte. Frentes abiertos: condensación de repreguntas (F2b — casos
`conv_02_t2/t3` en rojo), datos estructurados de profesionales/nómina,
calibración del umbral con datos reales (instrumentación ya loguea).

## Mapa del código (lo no obvio)

```
backend/
  services/orchestrator.py    # pipeline de consulta, cache, historial, no-info
  services/retrieval.py       # híbrido multi-query + RRF (sin reranker)
  services/trust_gate.py      # anti-alucinación en 2 etapas
  services/handoff.py         # 5 reglas de derivación + estado de conversación
  services/connector_*.py     # framework de conectores (router/executor/discovery/memory)
  services/whatsapp_inbound.py
  api/v1/operator_panel.py    # bandeja, historial (por PARTICIPACIÓN), sectores, alta operadores
  api/v1/system_prompts.py    # personalidades: catálogo superadmin + cupo por tenant
  api/v1/widget_conversation.py
  db/migrations/versions/     # cadena única 001..044 — idéntica en main y dev
frontend/
  lib/features.ts             # flags de build por ambiente
  components/auth/auth-shell.tsx        # shell compartido de pantallas auth
  components/conversations/             # panel operador/admin (SSE + sonidos)
  components/layout/operator-sidebar.tsx # incluye drawer mobile del operador
  public/widget/widget.js     # widget embebible vanilla
scripts/run_quality_suite.py  # LA suite — correr antes de tocar el motor
```

## Convenciones y acuerdos

- Idioma: todo en español (código de UI, commits, docs).
- Commits temáticos con scope: `feat(derivacion): ...` — mirar `git log`.
- Frontend: reusar patrones existentes (ListDetailShell, FormSheet, drawer del
  admin); nada de cajas anidadas; ayudas de formularios en foco, no
  permanentes; orden ESTABLE en listas seleccionables (no reordenar al elegir).
- Probar antes de commitear: `tsc --noEmit` + tests en el contenedor
  (`docker exec local_backend python -m pytest tests/ -q`) + OK visual.
- Secretos: jamás en código ni commits. `.env` por ambiente.

## Documentación (docs/)

| Doc | Qué es |
|---|---|
| `OPERACIONES.md` | Manual del operador del VPS: salud, deploy, monitoreo |
| `RUNBOOK.md` + `observability/RUNBOOK.md` | Incidentes paso a paso |
| `DEV_LOCAL.md` | Levantar el ambiente local aislado |
| `PLAN_CALIDAD_MOTOR.md` | Plan vivo de mejoras del RAG (F0–F4) |
| `KNOWLEDGE_BASE_GUIDE.md` | Formato de documentos para la base de conocimiento |
| `OPERACION_OPENAI_KEYS_Y_SALDO.md` | Gestión de API keys y saldo del LLM |
| `ESTRATEGIA_INTEGRACION.md`, `FSM_LOGIN_DISENO.md`, `MIGRACION_031_CONECTORES_DISENO.md`, `PANTALLA_CONECTORES_PLAN.md`, `PLAN_EVOLUCION_TOOL_CALLING_v1.md` | Diseño del framework de conectores (feature en validación) |
| `STATUS_PAGE.md` | Guía opcional de status page (UptimeRobot) |
| `PROMPT.md` | **Histórico** — visión original; no refleja el estado actual |
| `design/referencia-text-app.md` | Referencia visual del rediseño |

`progress.json` (raíz): estado de avance y decisiones — actualizarlo al cerrar
jornadas o tomar decisiones de diseño.
