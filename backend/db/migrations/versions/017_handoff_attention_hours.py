"""Agregar columna attention_hours a handoff_config en cada schema tenant.

Horario de atención (texto libre, configurable por tenant desde el panel admin).
Se muestra al afiliado cuando NO hay operadores conectados, en vez de ofrecer
derivación a una cola vacía. La señal real de "se puede derivar" sigue siendo la
presencia de operadores online; el horario es solo informativo.

Revision ID: 017
Revises: 016
"""

from alembic import op
from sqlalchemy import text

revision = "017"
down_revision = "016"
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
        conn.execute(text(
            f'ALTER TABLE "{schema}".handoff_config '
            f"ADD COLUMN IF NOT EXISTS attention_hours TEXT"
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".handoff_config '
            f"DROP COLUMN IF EXISTS attention_hours"
        ))
