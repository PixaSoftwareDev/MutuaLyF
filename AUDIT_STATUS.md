# Auditoría pre-producción — estado y backlog de trabajo

> Documento de trabajo. Cada ítem pendiente está clasificado por riesgo para decidir
> con criterio. Regla de oro: **el bot funciona bien — todo cambio mejora o no se hace.**

## Leyenda de riesgo
- 🟢 **Mejora segura** — fix inocuo, no toca el flujo del bot ni nada intencional.
- 🟡 **Requiere entender** — verificar si lo actual es intencional antes de tocar, o tocar tiene riesgo técnico (nginx/Redis/base compartida). NO cambiar solo.
- 🛑 **Dejar** — intencional / decisión de producto / fail-open documentado.
- 🔵 **Deuda técnica** — código muerto / perf / tests. Mejora real pero no urgente; bajo riesgo.

---

## ✅ Hecho

| Tanda | Qué | Commit |
|---|---|---|
| 1 | `contact_info` faltante en `tenant_schema.sql` (rompía tenant nuevo) | `2452a6d` |
| 2.1–2.3 | Hardening widget: `is_test`/scope, `/public/chat-token` widget_enabled, `sector_id` validado | `4a8129c` |
| 2.4–2.5 | `/query/widget` con cuota + rate-limit por IP (toggles respetados) | `1f79c80` |
| 3.1/3.2/3.4 | No exponer detalle de excepción ni `match_via` al cliente | `46eb750` |
| Backlog #2 | `backend/.dockerignore` creado (no hornear secrets/.git/caches) | _pendiente commit_ |
| Backlog #3 | Grafana fail-fast `${GRAFANA_PASSWORD:?}` (sin fallback `admin/admin`) | _pendiente commit_ |

**Congelado a propósito:** 2.6 nginx `rate=100000r/m` → no tocar hasta después de las pruebas de concurrencia (es cambiar un número el día del go-live).

---

## ⏳ Pendiente

### Tanda 3 — Fugas de info / PII (EN CURSO)
| # | Archivo | Error | Riesgo | Acción |
|---|---|---|---|---|
| 3.1 | `duplicates.py:269` | Detalle de excepción Qdrant al admin | 🟢 | Mensaje genérico + log conserva detalle |
| 3.2 | `export.py:302` | `str(exc)` en JSON de export | 🟢 | Mensaje genérico + log |
| 3.4 | `auth.py:56` | `match_via` serializado en `/lookup-tenant` (anónimo); el front no lo usa | 🟢 | `Field(exclude=True)` |
| 3.3 | `channels.py:273` | Error de Meta ecoado al admin | 🛑 | **Dejar** — es útil al admin para diagnosticar WhatsApp |
| 3.5 | `widget_conversation.py:586` | `operators-online` devuelve nombres | 🛑 | **Dejar** — el widget los muestra ("te atiende Juan"): feature, no fuga |
| 3.6 | `superadmin/audit:266` | IP de afiliados visible al super-admin | 🛑 | **Dejar** — auditoría de seguridad, intencional |

### Tanda 4 — 500 evitables / defensa auth
| # | Archivo | Error | Riesgo | Acción |
|---|---|---|---|---|
| 4.1 | `security.py:156` | `Role(role_str)` → 500 si rol legacy | 🟢 | Patrón defensivo (ya existe en auth.py) → OPERATOR |
| 4.2 | `auth.py:405,416` | `uuid.UUID(sub)` → 500 si sub malformado | 🟢 | try/except → 401 |
| 4.3 | `security.py:111` | `decode_token` no exige `exp` | 🟢 | `options={"require":["exp"]}` |
| 4.4 | `database.py:153` | `_validate_tenant_id` acepta `'public'` | 🟢 | Blocklist de schemas reservados |
| 4.5 | `security.py:162-223` | `_assert_tenant_active` fail-open ante PG caído | 🛑 | **Dejar** — trade-off documentado; a lo sumo métrica/alerta |

### Tanda 5 — Secrets / infra
| # | Archivo | Error | Riesgo | Acción |
|---|---|---|---|---|
| 5.1 | `backend/.dockerignore` (ausente) | `COPY . .` hornea `.env`/PII/`.git` en la imagen | 🟢 | Crear `.dockerignore` |
| 5.2 | `docker-compose.yml:440` | Grafana fallback `admin/admin` | 🟢 | Quitar fallback de password |
| 5.3 | `docker-compose.yml:503` | DSN de postgres-exporter con password en proceso | 🟡 | Refactor a vars separadas; red interna (bajo) |
| 5.4 | `nginx.prod.conf:73` | `ssl_ciphers` laxos | 🟡 | Tocar nginx exige **recrear container** (gotcha inode); cuidado |
| 5.5 | `nginx.prod.conf:33` | CSP `unsafe-eval` | 🟡 | Puede romper hidratación Next; **probar** antes |
| 5.6 | `config.py:16` | `groq_api_key` required aunque el provider real es OpenAI | 🟡 | Verificar provider real antes de tocar el boot |

### Tanda 6 — Integridad / resiliencia
| # | Archivo | Error | Riesgo | Acción |
|---|---|---|---|---|
| 6.1 | `database.py:118-124` | reset de `search_path` traga excepción con `pass` mudo | 🟢 | Loguear el fallo (no cambia comportamiento) |
| 6.2 | `provision_tenant.py:139` | marca `neo4j_db=True` aunque Community no creó la DB | 🟢 | No setear flag en rama Community |
| 6.3 | `ingest_tasks.py:346` | status agregado queda `pending` permanente | 🟡 | **Entender** la lógica de agregación antes de tocar (ingesta anda) |
| 6.4 | `whatsapp_inbound.py:71-91` | advisory lock se libera antes de crear conv (race) | 🟡 | Verificar; toca onboarding WhatsApp real |
| 6.5 | `intentions.py:254-317` | transacción no atómica → intención huérfana | 🟡 | Verificar flujo de creación de intención |

### Tanda 7 — Código muerto + ORM desincronizado
| # | Archivo | Error | Riesgo | Acción |
|---|---|---|---|---|
| 7.1 | `orchestrator.py`, `ingest_tasks.py`, `celery_app.py` | `ENTITIES_DISABLED` (Neo4j apagado) | 🟡 | **Entender** si Neo4j se reactiva antes de borrar |
| 7.2 | mig 023 | columnas WhatsApp muertas en `public.tenants` | 🔵 | Migración nueva — cuidado base compartida prod↔staging |
| 7.3 | `env.py:22` | autogenerate Alembic no importa modelos | 🟡 | Importar modelos mejora, pero autogenerate podría generar DROPs |
| 7.4 | `global_models.py` | ORM `Tenant` desincronizado (8 vs ~25 cols) | 🔵 | Inocuo hoy (todo SQL crudo); documentar o sincronizar |
| 7.5 | varios | `_MAGIC` dict, `HandoffTrigger.MANUAL`, `EmailDomainsSection` | 🔵 | Limpieza segura |

### Tanda 8 — Performance (no urgente)
| # | Archivo | Error | Riesgo |
|---|---|---|---|
| 8.1 | `tenants.py:1753` | N+1 secuencial en `get_platform_ops` | 🔵 |
| 8.2 | `operators/page.tsx:302` | N+1 operator-sectors en frontend | 🔵 |
| 8.3 | `whatsapp.py:153` | httpx client nuevo por request | 🔵 |
| 8.4 | `events.py:58` | `get_online_operators` usa `KEYS` (bloquea Redis) | 🔵 |
| 8.5 | `clustering.py:99` | doble loop O(2n) | 🔵 |

### Tanda 9 — Frontend pulido
| # | Archivo | Error | Riesgo | Acción |
|---|---|---|---|---|
| 9.1 | `conversations-panel.tsx:180` | `AudioContext` sin cerrar (leak) | 🟢 | `ctx.close()` |
| 9.2 | `widget.js` varios | `console.*` de debug sin flag | 🟢 | Quitar / gate por flag |
| 9.3 | `forgot-password`, `orgs` | validaciones de form faltantes (email/password) | 🟢 | Validar formato |
| 9.4 | `chat/page.tsx:115`, `orgs:152` | a11y: `img`/`span` con `onClick` sin role/teclado | 🟢 | role+tabIndex+key handler |
| 9.5 | `audit/page.tsx:134` | búsqueda solo en página actual | 🟡 | Verificar si confunde al admin |
| 9.6 | `auth-guard.tsx`, `api.ts` | no valida `exp`; token en localStorage | 🟡 | UX gating (backend valida); arquitectura, no trivial |

### Tanda 10 — Tests (red de regresión)
| Área sin cobertura | Riesgo |
|---|---|
| auth/RBAC, cross-tenant (IDOR email-domains), planes/cuotas, ingesta idempotencia, WhatsApp, handoff, migraciones | 🔵 Agregar tests — no toca prod, cierra el ciclo |

---

## Backlog pendiente — numerado por prioridad (vista única)

> Tocar: 🟢 seguro · 🟡 entender/cuidado · 🔵 deuda baja · 🛑 dejar (intencional)

### 🔴 ALTA
| # | Archivo | Problema | Tocar |
|---|---|---|---|
| 1 | `nginx.prod.conf:40-41` | `rate=100000r/m` temporal → abuso de costo LLM sin freno | 🟡 congelado hasta go-live |
| 2 | `backend/.dockerignore` (ausente) | `COPY . .` hornea `.env`/PII/`.git` en la imagen | ✅ HECHO (context real es `./backend`; impacto runtime nulo por bind-mount) |
| 3 | `docker-compose.yml:439-440` | Grafana `admin/admin` si falta `GRAFANA_PASSWORD` | ✅ HECHO (fail-fast `:?`; ⚠️ requiere `GRAFANA_PASSWORD` en `.env` del VPS al deployar) |
| 4 | `workers/ingest_tasks.py:346-372` | Status de doc queda `pending` permanente | 🟡 |
| 5 | `core/config.py:16` | `groq_api_key` required pese a provider OpenAI → riesgo boot | 🟡 |

### 🟡 MEDIA
| # | Archivo | Problema | Tocar |
|---|---|---|---|
| 6 | `core/security.py:156` | `Role(role_str)` → 500 | ✅ HECHO (try/except → OPERATOR; scope → WIDGET) |
| 7 | `api/v1/auth.py:405,416` | `uuid.UUID(sub)` → 500 | ✅ HECHO (try/except → 401) |
| 8 | `core/security.py:111` | `decode_token` no exige `exp` | ✅ HECHO (`options={"require":["exp"]}`; emisores verificados) |
| 9 | `core/database.py:153` | `_validate_tenant_id` acepta `'public'` | ✅ HECHO (blocklist schemas reservados + `pg_*`) |
| 10 | `whatsapp_inbound.py:71-91` | Advisory lock se libera antes de crear conv (race) | 🟡 |
| 11 | `api/v1/intentions.py:254-317` | Transacción no atómica → intención huérfana | 🟡 |
| 12 | `core/database.py:118-124` | Reset `search_path` traga excepción con `pass` mudo | ✅ HECHO (`logger.error` con exc_info) |
| 13 | `scripts/provision_tenant.py:139` | `neo4j_db=True` aunque Community no creó la DB | ✅ HECHO (flag solo en rama Enterprise) |
| 14 | `nginx.prod.conf:73` | `ssl_ciphers` laxos | 🟡 recrear nginx |
| 15 | `nginx.prod.conf:33` | CSP `unsafe-eval` | 🟡 puede romper Next |
| 16 | `docker-compose.yml:503` | postgres-exporter con password en el DSN | 🟡 |
| 17 | `db/migrations/env.py:22` | Autogenerate no importa modelos → riesgo DROPs | 🟡 |

### 🟢 BAJA
| # | Archivo | Problema | Tocar |
|---|---|---|---|
| 18 | `orchestrator/ingest/celery_app` | `ENTITIES_DISABLED` | 🛑 DEJAR — NO es código muerto: entidades/Neo4j es trabajo futuro (aclaración del dueño) |
| 19 | mig `023` | Columnas WhatsApp muertas | ⏳ PENDIENTE — requiere migración en **base compartida prod↔staging** (coordinar, no aplicar suelto) |
| 20 | `db/global_models.py` | ORM `Tenant` desincronizado | ✅ HECHO (documentado como intencional + warning anti-autogenerate, liga con #17) |
| 21 | varios | `_MAGIC`, `HandoffTrigger.MANUAL`, `EmailDomainsSection` | ✅/🛑 PARCIAL — `_MAGIC` borrado; los otros 2 NO son muertos (handoff manual = feature; EmailDomainsSection = flag-gated `SHOW_EMAIL_DOMAINS`) |
| 22 | `tenants.py:1753` | N+1 en `get_platform_ops` | ✅ HECHO (gather con semáforo 8, mismo SQL/lógica) |
| 23 | `operators/page.tsx:302` | N+1 operator-sectors frontend | ✅ HECHO (endpoint batch `/admin/operators/sectors-map` + 1 query en el padre, prop a cada card; `tsc` OK) |
| 24 | `whatsapp.py:153` | httpx client nuevo por request | ✅ HECHO (cliente compartido lazy + `aclose_client` en shutdown) |
| 25 | `services/events.py:58` | `get_online_operators` usa `KEYS` | ✅ HECHO (`scan_iter`, no bloquea Redis) |
| 26 | `clustering.py:99` | Doble loop O(2n) | ✅ HECHO (un solo loop; candidates desde counts) |
| 27 | `conversations-panel.tsx:180` | `AudioContext` sin cerrar (leak) | ✅ HECHO (`osc.onended → ctx.close()`) |
| 28 | `widget.js` | `console.*` de debug sin flag | ✅ HECHO (gate `data-debug`; token-error siempre visible) |
| 29 | `forgot-password`, `orgs` | Validaciones de form faltantes | ✅ HECHO (regex email + error inline en forgot-password) |
| 30 | `chat/page.tsx:115`, `orgs:152` | a11y: `img`/`span` `onClick` sin teclado | ✅ HECHO (`role`+`tabIndex`+`onKeyDown`) |
| 31 | `audit/page.tsx:134` | Búsqueda solo en la página actual | ✅ HECHO (param `search` server-side con ILIKE + debounce 300ms en el front; `tsc` OK) |
| 32 | `auth-guard.tsx`, `api.ts` | No valida `exp`; token en localStorage | ⏳ PENDIENTE — NO trivial: hay refresh tokens, validar `exp` del access y desloguear rompería el refresh. Es arquitectura |
| 33 | `backend/tests` | Cobertura faltante (auth/RBAC, cross-tenant, planes, ingesta, WhatsApp, handoff, migraciones) | ✅ PARCIAL — agregados tests de regresión de los fixes de seguridad (JWT exp/role/scope, schemas reservados). Cobertura amplia de integración (cross-tenant DB, WhatsApp, ingesta) queda como esfuerzo aparte |

### 🛑 DEJAR (intencional)
| # | Archivo | Por qué |
|---|---|---|
| 34 | `channels.py:273` | Error de Meta útil al admin |
| 35 | `widget_conversation.py:586` | `operators-online` nombres = feature del widget |
| 36 | `superadmin/audit:266` | IP de afiliados = auditoría de seguridad |
| 37 | `core/security.py:162-223` | `_assert_tenant_active` fail-open = trade-off documentado |

**Conteo:** 33 pendientes reales (5 alta · 12 media · 16 baja) + 4 a dejar. De los 33, ~13 son 🟢 seguros.
