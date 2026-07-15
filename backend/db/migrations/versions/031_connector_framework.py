"""Framework de conectores (Tool Calling) — 5 tablas por schema tenant.

Materializa el diseño de docs/MIGRACION_031_CONECTORES_DISENO.md. El bot pasa
de solo-RAG a poder invocar APIs de terceros (NEXA como conector #1) para
responder con datos personales del afiliado/profesional, sin exponer credenciales
ni permitir que un usuario lea datos de otro (BOLA/IDOR).

Config-driven: qué conectores existen, qué tools exponen, qué rol las invoca y qué
intención las dispara viven en estas tablas, no en código. El executor es un
intérprete genérico de esta config.

Tablas (todas en cada schema tenant_*):
- tenant_connectors        : un sistema externo (base_url, auth, egress allowlist)
- connector_tools          : una operación invocable (path_template, params_schema)
- connector_roles          : qué rol RBAC puede invocar cada tool (fail-closed)
- connector_intent_bindings: qué intención dispara qué tool (puente con el clasificador)
- tool_call_audit          : rastro inmutable de cada invocación (incl. denegadas)

Idempotente (IF NOT EXISTS) — base compartida prod<->staging.
Todo nace is_active=FALSE: activar un conector es acción de admin, no efecto de la
migración.

Revision ID: 031
Revises: 030
"""

from alembic import op
from sqlalchemy import text

revision = "031"
down_revision = "030"
branch_labels = None
depends_on = None


def _tenant_schemas(conn) -> list[str]:
    result = conn.execute(text(
        "SELECT schema_name FROM information_schema.schemata "
        "WHERE schema_name LIKE :pat ESCAPE '\\'"
    ), {"pat": r"tenant\_%"})
    return [r[0] for r in result.fetchall()]


def upgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        # 1) tenant_connectors — un sistema externo.
        conn.execute(text(
            f'CREATE TABLE IF NOT EXISTS "{schema}".tenant_connectors ('
            f'  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),'
            f'  slug            TEXT NOT NULL,'
            f'  display_name    TEXT NOT NULL,'
            f'  base_url        TEXT NOT NULL,'
            f'  egress_allow    TEXT[] NOT NULL DEFAULT \'{{}}\','
            f'  auth_type       TEXT NOT NULL,'
            f'  auth_secret_ref TEXT,'
            f'  is_active       BOOLEAN NOT NULL DEFAULT FALSE,'
            f'  timeout_ms      INTEGER NOT NULL DEFAULT 4000,'
            f'  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),'
            f'  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),'
            f'  UNIQUE (slug)'
            f')'
        ))

        # 2) connector_tools — una operación invocable del conector.
        conn.execute(text(
            f'CREATE TABLE IF NOT EXISTS "{schema}".connector_tools ('
            f'  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),'
            f'  connector_id  UUID NOT NULL REFERENCES "{schema}".tenant_connectors(id) ON DELETE CASCADE,'
            f'  slug          TEXT NOT NULL,'
            f'  display_name  TEXT NOT NULL,'
            f'  http_method   TEXT NOT NULL DEFAULT \'GET\','
            f'  path_template TEXT NOT NULL,'
            f'  params_schema JSONB NOT NULL DEFAULT \'{{}}\','
            f'  response_map  JSONB NOT NULL DEFAULT \'{{}}\','
            f'  identity_kind TEXT NOT NULL,'
            f'  is_read_only  BOOLEAN NOT NULL DEFAULT TRUE,'
            f'  is_active     BOOLEAN NOT NULL DEFAULT FALSE,'
            f'  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),'
            f'  UNIQUE (connector_id, slug)'
            f')'
        ))

        # 3) connector_roles — RBAC por tool. Sin fila → denegado (fail-closed).
        conn.execute(text(
            f'CREATE TABLE IF NOT EXISTS "{schema}".connector_roles ('
            f'  tool_id UUID NOT NULL REFERENCES "{schema}".connector_tools(id) ON DELETE CASCADE,'
            f'  role    TEXT NOT NULL,'
            f'  PRIMARY KEY (tool_id, role)'
            f')'
        ))

        # 4) connector_intent_bindings — puente intención → tool.
        conn.execute(text(
            f'CREATE TABLE IF NOT EXISTS "{schema}".connector_intent_bindings ('
            f'  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),'
            f'  intencion_id   UUID NOT NULL REFERENCES "{schema}".intenciones(id) ON DELETE CASCADE,'
            f'  tool_id        UUID NOT NULL REFERENCES "{schema}".connector_tools(id) ON DELETE CASCADE,'
            f'  min_confidence REAL NOT NULL DEFAULT 0.70,'
            f'  is_active      BOOLEAN NOT NULL DEFAULT FALSE,'
            f'  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),'
            f'  UNIQUE (intencion_id, tool_id)'
            f')'
        ))

        # 5) tool_call_audit — rastro inmutable. Sin FK dura: sobrevive borrados
        # de tool/conversación (desnormalizamos tool_slug). Base para detectar
        # sondeo BOLA (muchos forbidden/auth_required del mismo actor).
        conn.execute(text(
            f'CREATE TABLE IF NOT EXISTS "{schema}".tool_call_audit ('
            f'  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),'
            f'  conversation_id UUID,'
            f'  tool_id         UUID,'
            f'  tool_slug       TEXT NOT NULL,'
            f'  actor_ref       TEXT,'
            f'  outcome         TEXT NOT NULL,'
            f'  latency_ms      INTEGER,'
            f'  detail          JSONB,'
            f'  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()'
            f')'
        ))
        conn.execute(text(
            f'CREATE INDEX IF NOT EXISTS ix_tool_audit_actor '
            f'ON "{schema}".tool_call_audit (actor_ref, created_at DESC)'
        ))
        conn.execute(text(
            f'CREATE INDEX IF NOT EXISTS ix_tool_audit_outcome '
            f'ON "{schema}".tool_call_audit (outcome, created_at DESC)'
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        # Orden inverso de dependencia.
        conn.execute(text(f'DROP TABLE IF EXISTS "{schema}".tool_call_audit'))
        conn.execute(text(f'DROP TABLE IF EXISTS "{schema}".connector_intent_bindings'))
        conn.execute(text(f'DROP TABLE IF EXISTS "{schema}".connector_roles'))
        conn.execute(text(f'DROP TABLE IF EXISTS "{schema}".connector_tools'))
        conn.execute(text(f'DROP TABLE IF EXISTS "{schema}".tenant_connectors'))
