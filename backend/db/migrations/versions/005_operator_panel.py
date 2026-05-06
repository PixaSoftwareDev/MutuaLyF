"""Add operator panel tables: sectores, conversaciones, mensajes, handoff_config.

Revision ID: 005
Revises: 004
Create Date: 2026-05-06
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS {schema}.sectores (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre      VARCHAR(100) NOT NULL UNIQUE,
    descripcion TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO {schema}.sectores (nombre, descripcion)
VALUES ('Consultas Generales', 'Sector por defecto para consultas sin asignación específica')
ON CONFLICT (nombre) DO NOTHING;

CREATE TABLE IF NOT EXISTS {schema}.operador_sectores (
    operador_id UUID NOT NULL REFERENCES {schema}.usuarios(id) ON DELETE CASCADE,
    sector_id   UUID NOT NULL REFERENCES {schema}.sectores(id) ON DELETE CASCADE,
    PRIMARY KEY (operador_id, sector_id)
);

CREATE TABLE IF NOT EXISTS {schema}.conversaciones (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    widget_session_id       VARCHAR(100) NOT NULL,
    sector_id               UUID REFERENCES {schema}.sectores(id),
    status                  VARCHAR(30) NOT NULL DEFAULT 'bot_active',
    assigned_operator_id    UUID REFERENCES {schema}.usuarios(id),
    insufficient_count      INTEGER NOT NULL DEFAULT 0,
    human_request_count     INTEGER NOT NULL DEFAULT 0,
    afiliado_nombre         VARCHAR(200),
    afiliado_email          VARCHAR(320),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at               TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_conversaciones_session ON {schema}.conversaciones (widget_session_id);
CREATE INDEX IF NOT EXISTS ix_conversaciones_status  ON {schema}.conversaciones (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_conversaciones_sector  ON {schema}.conversaciones (sector_id, status);

CREATE TABLE IF NOT EXISTS {schema}.mensajes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES {schema}.conversaciones(id) ON DELETE CASCADE,
    sender_type     VARCHAR(20) NOT NULL,  -- user | bot | operator | system
    content         TEXT NOT NULL,
    read_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_mensajes_conversation ON {schema}.mensajes (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS {schema}.handoff_config (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inactivity_timeout_minutes      INTEGER NOT NULL DEFAULT 15,
    consecutive_insufficient_count  INTEGER NOT NULL DEFAULT 2,
    frustration_phrases             JSONB NOT NULL DEFAULT '["no me ayuda","no sirve","mal servicio","quiero quejarme","esto no funciona","necesito hablar con alguien"]',
    transition_messages             JSONB NOT NULL DEFAULT '{
        "handoff_offer": "Parece que no pude responder tu consulta correctamente. ¿Querés que te conecte con un operador?",
        "handoff_auto":  "Te estoy conectando con un operador. En breve alguien te atenderá.",
        "human_assigned": "Un operador se ha unido a la conversación.",
        "sector_transferred": "Tu consulta fue derivada al área correspondiente. Un operador te atenderá pronto.",
        "operator_inactive_alert": "Todavía estás en cola. Lamentamos la demora, un operador te atenderá a la brevedad.",
        "conversation_closed": "La conversación fue cerrada. Gracias por contactarnos."
    }',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO {schema}.handoff_config DEFAULT VALUES ON CONFLICT DO NOTHING;
"""


def upgrade() -> None:
    conn = op.get_bind()
    result = conn.execute(sa.text("SELECT id FROM tenants"))
    tenant_ids = [row[0] for row in result]

    for tenant_id in tenant_ids:
        schema = f"tenant_{tenant_id.replace('-', '_')}"
        for statement in _TABLES_SQL.replace("{schema}", schema).split(";"):
            stmt = statement.strip()
            if stmt:
                conn.execute(sa.text(stmt))


def downgrade() -> None:
    conn = op.get_bind()
    result = conn.execute(sa.text("SELECT id FROM tenants"))
    tenant_ids = [row[0] for row in result]
    for tenant_id in tenant_ids:
        schema = f"tenant_{tenant_id.replace('-', '_')}"
        for table in ["mensajes", "conversaciones", "operador_sectores", "sectores", "handoff_config"]:
            conn.execute(sa.text(f"DROP TABLE IF EXISTS {schema}.{table} CASCADE"))
