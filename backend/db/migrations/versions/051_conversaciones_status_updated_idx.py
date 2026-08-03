"""Índice (status, updated_at) en conversaciones — cierre automático a escala.

La tarea close_stale_conversations filtra por `status = ... AND updated_at < ...`.
El índice existente es (status, created_at); con volumen, el filtro por updated_at
quedaba sin cubrir. Este índice mantiene la query de cierre rápida al crecer las
conversaciones. Idempotente (IF NOT EXISTS), aplica a todos los schemas tenant_*.

Revision ID: 051
Revises: 050
"""

from alembic import op
from sqlalchemy import text

revision = "051"
down_revision = "050"
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
            f'CREATE INDEX IF NOT EXISTS ix_conversaciones_status_updated '
            f'ON "{schema}".conversaciones (status, updated_at)'
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(f'DROP INDEX IF EXISTS "{schema}".ix_conversaciones_status_updated'))
