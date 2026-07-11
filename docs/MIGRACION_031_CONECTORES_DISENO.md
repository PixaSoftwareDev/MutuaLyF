# Migración 031 — Framework de Conectores (diseño)

> **Estado: DISEÑO. No aplicar todavía.** Estas tablas se materializan en la
> Fase 1 (MVP NEXA), no en Fase 0. Este documento congela el esquema para que la
> implementación de Fase 1 no improvise DDL y para poder revisar el modelo de
> datos antes de escribir código contra él.

## Contexto

Hoy el bot solo hace RAG sobre conocimiento estático. El framework de conectores
(ver `docs/PLAN_EVOLUCION_TOOL_CALLING_v1.md` y decisión de arquitectura de
conectores) agrega **Tool Calling**: el bot invoca APIs de terceros (NEXA como
conector #1) para responder con datos personales del afiliado/profesional en
tiempo real, sin exponer credenciales ni permitir que un usuario lea datos de
otro (defensa BOLA/IDOR).

Todo es **config-driven**: qué conectores existen, qué herramientas exponen, qué
rol puede invocarlas y qué intención las dispara se declaran en tablas, no en
código. El executor es un intérprete genérico de esa config.

## Principios que el esquema debe garantizar

1. **Aislamiento por tenant** — todas las tablas viven en el schema `tenant_{id}`,
   igual que el resto del modelo (schema-per-tenant, no columna `tenant_id`).
2. **`{identity}` server-side** — ningún parámetro de identidad viaja en el
   request del LLM. El executor lo resuelve desde el token de sesión. El esquema
   NO guarda identidad del usuario en la config de la tool.
3. **Fail-closed** — sin binding activo, sin rol permitido o sin auth resuelta,
   la tool no se invoca. Los defaults del esquema deniegan.
4. **Auditable** — toda invocación deja rastro inmutable (`tool_call_audit`),
   incluyendo denegaciones (para detectar sondeo BOLA).
5. **Credenciales fuera de la fila** — las tablas guardan *referencias* a secrets
   (nombre de la env var / clave en secrets manager), nunca el secreto en claro.

## Tablas (schema `tenant_{id}`)

### `tenant_connectors`
Un conector = un sistema externo (NEXA, un ERP, etc.).

```sql
CREATE TABLE "{schema}".tenant_connectors (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            TEXT NOT NULL,              -- 'nexa'
    display_name    TEXT NOT NULL,
    base_url        TEXT NOT NULL,              -- validado por egress_guard en runtime
    egress_allow    TEXT[] NOT NULL DEFAULT '{}', -- hosts permitidos (allowlist SSRF)
    auth_type       TEXT NOT NULL,              -- 'basic' | 'oauth2' | 'api_key'
    auth_secret_ref TEXT,                       -- nombre de env/secret, NUNCA el secreto
    is_active       BOOLEAN NOT NULL DEFAULT FALSE,  -- fail-closed: nace apagado
    timeout_ms      INTEGER NOT NULL DEFAULT 4000,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (slug)
);
```

### `connector_tools`
Una tool = una operación invocable del conector (p. ej. `ordenes_pendientes`).

```sql
CREATE TABLE "{schema}".connector_tools (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id    UUID NOT NULL REFERENCES "{schema}".tenant_connectors(id) ON DELETE CASCADE,
    slug            TEXT NOT NULL,              -- 'ordenes_pendientes'
    display_name    TEXT NOT NULL,
    http_method     TEXT NOT NULL DEFAULT 'GET',
    path_template   TEXT NOT NULL,              -- '/afiliados/{identity}/ordenes'
    -- params_schema: JSON Schema de los parámetros que SÍ decide el LLM.
    -- {identity} NUNCA está acá; lo inyecta el executor server-side.
    params_schema   JSONB NOT NULL DEFAULT '{}',
    identity_kind   TEXT NOT NULL,              -- 'afiliado' | 'profesional'
    is_read_only    BOOLEAN NOT NULL DEFAULT TRUE,  -- escritura difierida a Fase 4
    is_active       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (connector_id, slug)
);
```

### `connector_roles`
Qué rol RBAC puede invocar qué tool. Sin fila → denegado (fail-closed).

```sql
CREATE TABLE "{schema}".connector_roles (
    tool_id     UUID NOT NULL REFERENCES "{schema}".connector_tools(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,                  -- 'afiliado' | 'profesional' | 'operador' | 'admin'
    PRIMARY KEY (tool_id, role)
);
```

### `connector_intent_bindings`
Qué intención del clasificador dispara qué tool. Es el puente entre el pipeline
de intenciones existente y el executor.

```sql
CREATE TABLE "{schema}".connector_intent_bindings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intencion_id    UUID NOT NULL REFERENCES "{schema}".intenciones(id) ON DELETE CASCADE,
    tool_id         UUID NOT NULL REFERENCES "{schema}".connector_tools(id) ON DELETE CASCADE,
    min_confidence  REAL NOT NULL DEFAULT 0.70, -- banda del clasificador para disparar
    is_active       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (intencion_id, tool_id)
);
```

### `tool_call_audit`
Rastro inmutable de cada invocación, incluidas las denegadas. Base para detectar
sondeo BOLA/IDOR (muchos `forbidden`/`auth_required` de un mismo actor).

```sql
CREATE TABLE "{schema}".tool_call_audit (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID,                       -- sin FK: la conversación puede purgarse
    tool_id         UUID,                       -- sin FK dura: la tool puede borrarse y el audit persiste
    tool_slug       TEXT NOT NULL,              -- desnormalizado para sobrevivir borrados
    actor_ref       TEXT,                       -- id de sesión / identidad resuelta (hasheable)
    outcome         TEXT NOT NULL,              -- 'ok'|'empty'|'auth_required'|'forbidden'|'upstream_error'
    latency_ms      INTEGER,
    detail          JSONB,                      -- SIN PII sensible ni credenciales
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_tool_audit_actor  ON "{schema}".tool_call_audit (actor_ref, created_at DESC);
CREATE INDEX ix_tool_audit_outcome ON "{schema}".tool_call_audit (outcome, created_at DESC);
```

## Contrato canónico de resultado (recordatorio)

El executor normaliza toda respuesta upstream a uno de:
`ok` · `empty` · `auth_required` · `forbidden` · `upstream_error`.
El LLM redacta la respuesta al usuario a partir de ese `outcome`, nunca del
payload crudo de NEXA.

## Notas de implementación para Fase 1

- Recorrer schemas tenant con el helper `_tenant_schemas(conn)` (ver migración 030).
- Idempotente: `CREATE TABLE IF NOT EXISTS`, base compartida prod↔staging.
- `downgrade()` dropea las 5 tablas en orden inverso de dependencia
  (audit → bindings → roles → tools → connectors).
- `base_url`/`egress_allow` se validan en runtime con `core.egress_guard`
  (Fase 0, ya implementado) antes de cada request del executor.
- Todo nace con `is_active = FALSE`: activar un conector es una acción de admin
  explícita, no un efecto de la migración.
```
