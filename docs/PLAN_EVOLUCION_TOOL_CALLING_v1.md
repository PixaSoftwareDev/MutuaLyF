# Plan de Evolución — RAG + Tool Calling Multi-Rol

**Versión 1.0 — 2026-07-11 · Rama base: `dev-local` (= prod `f562124`)**
**Insumos:** `Arquitectura_Chatbot_Mutual_LyF_v3.docx` (pedido del cliente, jun-2026) · `Arquitectura_Conectores_Terceros_MultiTenant_v1.pdf` (nuestra contrapropuesta, jul-2026, decisiones D1-D6 cerradas) · Auditoría integral del sistema (jul-10: 4.400 consultas de prueba, 3 bugs eliminados, motor de intenciones activado en prod)

---

## 1. Resumen ejecutivo

La Mutual pide (doc v3) que el bot pase de RAG puro a **RAG + Tool Calling**: responder datos personales (órdenes, cuenta corriente, agenda) contra la API de NEXA, con autenticación por rol (afiliado DNI+TOTP, profesional CUIT+OTP) y RBAC de 3 niveles.

**Nuestra posición de ingeniería (ya decidida en julio, este plan la ejecuta):** implementar exactamente lo que pide el doc, pero como **framework genérico multi-tenant** donde NEXA es el conector #1 configurado por datos — no como integración 1:1 hardcodeada. Mismo resultado para la Mutual, cero deuda para la plataforma.

**Novedad clave desde la contrapropuesta:** el prerequisito crítico ("router de intención confiable") **ya existe en producción desde el 10/07**: 24 intenciones curadas, clasificación 0.63-0.96 medida sobre 1.166 consultas reales, umbral calibrado, retrain nocturno con gate. El plan de julio asumía que había que construirlo; hoy se consume.

---

## 2. Análisis del documento v3 — qué adoptamos, qué adaptamos

### 2.1 Lo que el doc pide y adoptamos tal cual

| Requisito del doc | Sección | Cómo lo cumplimos |
|---|---|---|
| Orquestador con reglas predecibles y auditables ("no es un agente autónomo") | §2.3 | Coincide 1:1 con nuestra decisión: routing por `classify_intent` band + bindings declarativos, NO function-calling autónomo del LLM |
| LLM nunca recibe credenciales/TOTP/OTP | §9 | FSM de auth corre ANTES del LLM; scrubber de PII marca datos de auth como no-persistibles |
| Datos personales fuera de logs e historial | §9 | Scrubber + `tool_call_audit` guarda metadatos (qué tool, cuándo, resultado), jamás payloads personales |
| JWT 15-30 min, re-auth al expirar | §9 | Session store en Redis cifrado (Fernet ya en `crypto.py`), TTL configurable por conector |
| OTP 6 dígitos, 5 min, un solo uso; throttle 5/15min | §9 | `rate_limit.py` (DB2) extendido con bucket por identificador |
| Ley 25.326 antes de Fase 2 | §9 | Checklist de cumplimiento en Fase 1 (datos mínimos, finalidad, no persistencia) |
| Basic Auth hacia NEXA con credenciales propias del chatbot | §6 | Credenciales cifradas en `tenant_connectors` (molde `whatsapp_accounts`) |

### 2.2 Lo que adaptamos (y por qué es mejor para la Mutual también)

| Doc v3 propone | Nuestra adaptación | Justificación |
|---|---|---|
| Integración específica NEXA | **Conector configurable** (D1/D3): NEXA = filas en `tenant_connectors`/`connector_tools` | El doc mismo admite escenarios A/B/C con endpoints cambiantes — con config declarativa, cada cambio de NEXA es un UPDATE, no un deploy |
| "El LLM invoca endpoints" (§2.2) | El **executor determinista** invoca; el LLM solo redacta la respuesta con el JSON ya validado | Alineado con §2.3 del propio doc; elimina el riesgo de que el LLM invente parámetros (BOLA por prompt injection) |
| Identificación por `{dni}`/`{cuit}` en el path (§6.3/6.4) | Placeholder **`{identity}` resuelto server-side desde el token de sesión** (D4), jamás del texto del usuario ni del LLM | Defensa BOLA/IDOR: un afiliado no puede pedir órdenes de otro DNI cambiando el número en el chat. **Exigirlo también del lado NEXA** (token.identity == recurso) — va en el contrato |
| JWT emitido por NEXA como sesión | **Doble token** (D4): nosotros emitimos sesión propia (Redis, cifrada, identity opaca); el JWT de NEXA vive cifrado dentro del blob | Si NEXA rota su esquema de tokens, el bot no cambia; auditoría unificada multi-conector |
| Fase 2 monolítica | Fases 0-4 incrementales con UNA tool end-to-end como MVP | Riesgo acotado; feedback de NEXA temprano |

### 2.3 Contradicción del doc a señalar al cliente

§6.3 define endpoints `GET .../afiliado/{dni}/...` con "JWT en header" — pero si el server no valida que el JWT corresponde a ESE dni, cualquier afiliado autenticado lee datos de otros (BOLA clásico). **Acción**: incluir en el contrato con NEXA la validación server-side obligatoria `token.sub == {dni}` y testearla en las pruebas de integración (§11.3). Nuestro `{identity}` server-side nos protege del lado propio; esto protege el lado de ellos.

---

## 3. Estado real del bot hoy (base de la evolución)

### 3.1 Fortalezas medidas (auditoría 10/07, n=1.166 consultas reales)

- Retrieval casi perfecto: **2 misses en 1.166** (0.17%) — cuando no responde es porque el doc no existe
- **0 alucinaciones** en 100 auditadas contra documentos completos; faithfulness 0.95; refusal accuracy 1.00
- Motor de intenciones VIVO: 24 intenciones curadas, 694 ejemplos, ciclo nocturno completo (clustering→sugerencias→retrain con gate 0.82→0.88)
- Hot path sano: BM25+RRF reparado, facts canónicos (Junín 2956/2961), 142 tests, tripwire anti-`::cast`

### 3.2 Debilidades conocidas a resolver EN este plan (no después)

| # | Debilidad | Evidencia | Eje |
|---|---|---|---|
| D-1 | **Una sola API key OpenAI para prod+testing** → el testing dejó al bot sin crédito (incidente 10/07) | insufficient_quota en prod | Seguridad operativa |
| D-2 | **Sin CI** — 142 tests corren solo a mano | Auditoría de tests 10/07 | Código limpio |
| D-3 | Prompts RAG gordos: 15 fuentes × chunk ≈ 8-10K tokens/consulta | 8.5M tokens en 1.790 consultas | Rendimiento/costo |
| D-4 | 27% respuestas "incompletas" — mezcla de docs faltantes + síntesis tímida con listas largas | Auditoría masiva | Calidad |
| D-5 | Intenciones solapadas (`ordenes_medicas`/`orden_medica_digital`/`consultas_autorizaciones_medicas`; `horarios_atencion_medicos` vs la grande) | Auditoría de ejemplos | Código limpio |
| D-6 | Cache exacto devuelve `intent_label` viejo (pre-bootstrap) | Detectado en A/B intellix | Calidad datos |
| D-7 | **SSRF gap**: red docker bridge plana, backend alcanza todo | Auditoría jul-08 (compose:602) | Seguridad — crítico al abrir egress a APIs de terceros |
| D-8 | Reconciliación PG↔Qdrant sin proceso automático (quedó a mitad por cuota) | 694 PG vs 285 Qdrant hoy | Resiliencia |
| D-9 | Sin gate de calidad en CI (rag_eval manual) | — | Código limpio |

---

## 4. Plan de trabajo completo

> Estimaciones en días-persona efectivos. Cada fase termina con criterio de aceptación verificable. Los ejes (R)endimiento, (E)scalabilidad, (C)ódigo limpio, (S)eguridad se marcan por tarea.

### FASE 0 — Fundaciones y prerequisitos (3-4 días) — SIN dependencia de NEXA

| Tarea | Detalle | Eje | Est. |
|---|---|---|---|
| 0.1 API keys separadas + presupuesto | Key de testing con budget propio; alerta de saldo (endpoint billing ya existe: `openai_billing.py`); doc de operación | S | 0.5d |
| 0.2 CI GitHub Actions | pytest (142) + tripwire en cada push a dev/main; job semanal de `rag_eval` con gate | C | 1d |
| 0.3 Fix SSRF de red | `internal: true` en la red de DBs + egress allowlist por dominio para el executor (tabla `connector_allowlist`) | S | 1d |
| 0.4 Reconciliador PG↔Qdrant como task Celery | El script de ayer, productizado: corre post-promoción y en beat diario; alerta si counts divergen | C/E | 0.5d |
| 0.5 Fix cache: refrescar `intent_label` en hits | Al servir cache exacto, re-adjuntar clasificación actual (barato: ya está calculada) | C | 0.5d |
| 0.6 Migración 031 diseñada (papel) | `tenant_connectors`, `connector_roles`, `connector_tools`, `connector_intent_bindings`, `tool_call_audit` — revisión de schema antes de codear | E/C | 0.5d |

**Aceptación F0:** CI verde en push; consulta desde el backend a un dominio no-allowlisted falla; counts PG=Qdrant auto-verificados; key de prod intocable por tests.

#### Estado de implementación Fase 0 (2026-07-11)

| Tarea | Estado | Notas |
|---|---|---|
| 0.1 Keys + presupuesto | ✅ | `OPENAI_TEST_API_KEY` + `check_spend_alert` + `docs/OPERACION_OPENAI_KEYS_Y_SALDO.md` |
| 0.2 CI GitHub Actions | ✅ | `.github/workflows/ci.yml` (156 tests, torch CPU) |
| 0.3 SSRF | ✅ app / ⚠️ red prod | **Control SSRF real** = `core/egress_guard.py` (allowlist + anti-rebinding, 14 tests) — cumple el criterio de aceptación. **Segmentación de red** hecha y verificada en `docker-compose.local.yml` (red `data` `internal:true`; DBs sin egress, backend/worker en ambas). **Pendiente en compose base/prod**: requiere revisión por servicio (nginx edge; pgbackrest necesita egress a S3; celery_beat egress OpenAI; observability scraping) — no se aplicó a ciegas por riesgo de romper backups/scraping en el próximo deploy. |
| 0.4 Reconciliador Celery | ✅ | `services/intent_reconcile.py` + beat `nightly-data-consistency` 4:00 |
| 0.5 Label fresco en cache | ✅ | `_relog_semantic_hit` (re-clasifica hits semánticos en background) |
| 0.6 Migración 031 diseñada | ✅ | `docs/MIGRACION_031_CONECTORES_DISENO.md` |

**Follow-up 0.3 (compose prod):** replicar la red `data internal:true` a `docker-compose.yml` mapeando cada servicio: DBs solo en `data`; backend/celery_worker/celery_beat en `data`+edge; nginx en edge; **pgbackrest en `data`+edge** (sube backups a S3); observability según qué scrapea. Validar con `docker compose config` + smoke test de backup antes de mergear.

### FASE 1 — MVP Conector NEXA: UNA tool end-to-end (8-10 días)

| Tarea | Detalle | Eje | Est. |
|---|---|---|---|
| 1.1 Migración 031 + modelos | Tablas globales con columnas `*_enc` (molde `whatsapp_accounts`), UNIQUE(tenant_id, name) | E | 1d |
| 1.2 Executor HTTP | Plantilla de request por tool, timeouts, circuit breaker (patrón Neo4j existente), response_map JSONPath → contrato canónico `ok/empty/auth_required/forbidden/upstream_error` | E/R | 2d |
| 1.3 FSM de autenticación afiliado | Estados: `anon → pidiendo_dni → pidiendo_totp → autenticado`; validación formato DNI; llamada a `validarTotp` de NEXA; throttle 5/15min; mensajes de error conversacionales (§11.2 del doc) | S | 2d |
| 1.4 Session store | Redis DB nueva, blob Fernet {jwt_nexa, identity, rol, exp}; TTL 15-30 min configurable; re-auth transparente al expirar | S | 1d |
| 1.5 Router en orchestrator | Consumir `band` del clasificador (punto de inserción ya identificado, ~línea 175): intención con binding + band ≥ mid → camino tool; si `auth_required` → FSM. **Fail-closed** (D5) | R/C | 1d |
| 1.6 Tool #1: `ordenes_pendientes` | Binding intención `consultas_autorizaciones_medicas` (ya existe y clasifica) → GET ordenesPendientes con `{identity}`; respuesta natural desde JSON validado | — | 1d |
| 1.7 Seguridad transversal | Scrubber PII en logs/historial; `tool_call_audit`; test BOLA (usuario A pide con DNI de B → denegado); extender `test_cross_tenant.py` | S | 1.5d |
| 1.8 Intención `consulta_datos_personales` | Sembrar ejemplos ("¿tengo órdenes pendientes?", "¿cuánto debo?") — el panel de sugerencias ya los está juntando de tráfico real | — | 0.5d |

**Aceptación F1 (demo al cliente):** en el widget, "¿tengo órdenes pendientes?" → FSM pide DNI+TOTP (test: 111111) → responde las órdenes reales del entorno test de NEXA (:4003) → segundo pedido en la misma sesión NO re-pide auth → expirada la sesión, re-pide. Test BOLA verde. Nada de esto tocó código específico-NEXA fuera de filas de config.

**Dependencias NEXA (pedir YA, son su ruta crítica — §11.1 del doc):** catálogo Swagger/OpenAPI; credenciales Basic Auth para el chatbot; entorno test :4003 con datos ficticios; confirmación de emails de profesionales (escenario C).

#### Estado de implementación Fase 1 (2026-07-11) — construida en local contra stub

Todo el flujo funciona end-to-end contra infra REAL local (Redis DB3 + PG audit + stub NEXA in-process), verificado con demo en vivo + 18 tests. Falta solo el "último paso": conectar clasificador real (embeddings) + NEXA real.

| Tarea | Estado | Entregable |
|---|---|---|
| 1.1 Migración 031 + modelos | ✅ | `031_connector_framework.py` (5 tablas/schema, aplicada local) + `connectors_dao.py` (ToolBinding) |
| 1.2 Executor HTTP + circuit breaker | ✅ | `connector_executor.py` (validación params sin deps, `{identity}` server-side, egress_guard, breaker patrón Neo4j, response_map→contrato canónico, transporte stub/httpx) |
| 1.3 FSM login afiliado + stub | ✅ | `connector_router.py` (FSM con mensajes exactos, throttle 5/15min, escapes) + `nexa_stub.py` (code=111111) |
| 1.4 Session store | ✅ | `session_store.py` (Fernet, Redis DB3, TTL sliding, doble token) |
| 1.5 Router (fail-closed) | ✅ | insertado en `widget_conversation.py` ANTES del RAG (evita cache compartido); NO en el orquestador stateless — corrección de diseño documentada |
| 1.6 Tool #1 ordenes_pendientes | ✅ | `seed_connectors_demo.py` + demo en vivo: login→órdenes→sesión reusada→logout |
| 1.7 Seguridad + BOLA | ✅ | `connector_audit.py` (PII scrubber, `tool_call_audit` actor hasheado) + test BOLA verde (pedir DNI ajeno devuelve datos propios) |
| 1.8 Intención datos personales | ⏳ parcial | intención `consulta_ordenes_pendientes` sembrada en PG; **ejemplos en Qdrant pendientes** (requiere embeddings = cuota OpenAI, bloqueada) |

**Correcciones de diseño respecto del plan original:**
- El router NO va en el orquestador (es stateless y su cache RAG es compartido por tenant → un dato personal cacheado se filtraría entre usuarios). Va en la capa `widget_conversation` (tiene `conversation_id` + estado, y no cachea).
- Sesión keyed por `conversation_id` (Fase 1). Fase 2 puede keyear por `widget_session_id` para persistir login entre conversaciones.

**ÚLTIMO PASO pendiente (lo que el usuario dejó para el final):**
1. Restaurar cuota OpenAI → sembrar ejemplos Qdrant de la intención → el clasificador en vivo enruta la pregunta a la tool en el widget.
2. Recibir de NEXA: Swagger + credenciales + entorno test :4003 → cambiar el conector para apuntar a NEXA real (base_url + auth_secret_ref) → el executor ya usa httpx + egress_guard. **Cero código nuevo**, solo filas de config.

#### Validación con servicio mock HTTP real (2026-07-11)

Antes de NEXA real, se validó el camino HTTP **real** (httpx + egress_guard + response_map + circuit breaker) contra un servicio propio `mock_nexa` (FastAPI + SQLite, contenedor en `:4003`, datos inventados). 4 rutas: 2 públicas (profesionales por especialidad + horarios, sin login, params extraídos del mensaje) y 2 personales (órdenes + cuenta, login DNI+código validado por HTTP real, `{identity}` de la sesión). Extensiones hechas:
- `egress_guard.trusted_internal_hosts` (excepción dev explícita para el host interno del mock; SSRF intacto en prod).
- Tools **públicas** (`identity_kind='publico'`): sin FSM, ejecución directa con extracción determinista de params (enum/pattern, sin LLM).
- Validación del 2º factor por HTTP real (`validate_second_factor`), no solo stub.

Verificado end-to-end (demo en vivo, HTTP real): las 4 rutas responden; login→órdenes→cuenta en la misma sesión; **BOLA defendido** (pedir la cuenta de otro DNI devuelve la propia). Suite: 180 verde. Seed: `scripts/seed_mock_nexa.py`. Servicio: `mock_nexa/`.

### FASE 2 — Cobertura completa afiliado + rol profesional (6-8 días, ritmo atado a NEXA)

| Tarea | Detalle | Est. |
|---|---|---|
| 2.1 Tools afiliado restantes | `cuentaCorriente`, `autorizaciones`, `datos` — solo config + bindings (validar escenarios A/B con NEXA) | 1d c/u de validación |
| 2.2 FSM profesional (CUIT + OTP email/SMS) | Reusa la máquina de estados; el envío de OTP es de NEXA (§8) | 2d |
| 2.3 Tools profesional | `agenda`, `turnos`, `ficha` | 1d |
| 2.4 Consolidación de intenciones solapadas (D-5) | Fusionar las 3 de órdenes en el panel; separar horarios/turnos si el fast-path lo pide | 0.5d |
| 2.5 Pruebas de integración end-to-end con NEXA | Coordinadas con la Mutual (§11.3); incluye validación BOLA del lado NEXA | 2d |

### FASE 3 — Rendimiento, costo y panel (5-6 días) — paralelo parcial con F2

| Tarea | Detalle | Eje | Est. |
|---|---|---|---|
| 3.1 Dieta de prompt (D-3) | 15→8 fuentes con corte por score + dedup por parent; medir con `rag_eval` que faithfulness no caiga (gate) | R | 1.5d |
| 3.2 Fast-path de respuestas frecuentes | Intención band=high + respuesta curada → sin LLM (saludos, horarios del centro): −50% de llamadas estimado | R | 1.5d |
| 3.3 Completitud de síntesis (D-4) | Prompt: listas completas cuando el usuario pide "todos"; probar contra los 317 casos "incompleta" archivados | Calidad | 1d |
| 3.4 Panel admin del conector | CRUD de tools/bindings + botón test (molde del panel de canales) | E | 2d |
| 3.5 Carga de KB faltante | Gestión con la Mutual: requisitos afiliación, coberturas, FAQ — LA mejora de calidad #1 medida (27% incompletas) | Calidad | externo |

### FASE 4 — Escritura transaccional (diferida, diseño listo)

Solicitar autorización, confirmar turno (§10 del doc): POST con confirmación explícita del usuario, idempotency keys, doble validación. **No arrancar hasta que F1-F3 tengan 30 días estables en prod.**

---

## 5. Riesgos y mitigaciones

| Riesgo | Prob. | Mitigación |
|---|---|---|
| NEXA demora endpoints B/C (su ruta crítica) | Alta | F0+F1.1-1.5 no dependen de NEXA; mock del contrato canónico para desarrollar; la Mutual ya contempla desarrollo interno alternativo (§11.3) |
| BOLA del lado NEXA (validación server-side ausente) | Media | Test explícito en integración; cláusula en contrato; nuestro `{identity}` limita el blast radius propio |
| Costo LLM crece con tools (más turnos por conversación) | Media | F3.1/3.2 compensan; presupuesto por key (F0.1); `usage_events` ya mide por tenant |
| Prompt injection intenta forzar tool con identidad ajena | Media | El LLM no elige parámetros: identity server-side, tools por binding+rol, fail-closed |
| Deriva de intenciones al agregar `consulta_datos_personales` | Baja | `rag_eval` semanal en CI (F0.2) + gate de retrain ya activo |

## 6. Secuencia recomendada (resumen)

```
Semana 1        Semana 2-3           Semana 4-5             Semana 6+
FASE 0 ────────► FASE 1 (MVP NEXA) ──► FASE 2 (tools+prof) ──► FASE 4 (diseño)
   └─ pedidos a NEXA ya enviados      └─ FASE 3 en paralelo
```

**Primer hito visible para el cliente: fin de Fase 1 — "¿tengo órdenes pendientes?" respondido con datos reales del entorno test de NEXA, con autenticación TOTP, en ~2-3 semanas** (condicionado a que NEXA entregue credenciales + test env en la semana 1).
