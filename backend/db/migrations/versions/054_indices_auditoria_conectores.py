"""Índices que faltaban en tool_call_audit (auditoría previa a producción).

connectors_health() corre en CADA carga del panel de conectores y filtra
tool_call_audit por created_at, con JOIN por tool_id. Los índices existentes
son (actor_ref, created_at) y (outcome, created_at): ninguno arranca por las
columnas del filtro, así que la consulta hacía un scan completo de una tabla
que crece con cada llamada a un conector. Con volumen real (millones de filas
al año) el panel pasa a tardar segundos y compite por I/O con el chat.

Revision ID: 053
Revises: 052
"""

from alembic import op
from sqlalchemy import text

revision = "054"
down_revision = "053"
branch_labels = None
depends_on = None


def _tenant_schemas(conn):
    return [r[0] for r in conn.execute(text(
        "SELECT schema_name FROM information_schema.schemata "
        "WHERE schema_name LIKE 'tenant_%'"
    ))]


def upgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        existe = conn.execute(text(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = :s AND table_name = 'tool_call_audit'"
        ), {"s": schema}).scalar()
        if not existe:
            continue
        # (tool_id, created_at) sirve al JOIN + filtro de connectors_health;
        # (created_at) solo, a la purga por antigüedad y a los rangos de fecha.
        conn.execute(text(
            f'CREATE INDEX IF NOT EXISTS ix_tool_audit_tool_created '
            f'ON "{schema}".tool_call_audit (tool_id, created_at DESC)'
        ))
        conn.execute(text(
            f'CREATE INDEX IF NOT EXISTS ix_tool_audit_created '
            f'ON "{schema}".tool_call_audit (created_at DESC)'
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(f'DROP INDEX IF EXISTS "{schema}".ix_tool_audit_tool_created'))
        conn.execute(text(f'DROP INDEX IF EXISTS "{schema}".ix_tool_audit_created'))
