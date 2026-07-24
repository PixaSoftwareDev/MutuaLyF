"""Descripción rica por operación de conector.

El catálogo de function-calling le presentaba al LLM solo el display_name
("Lista de tareas") — ruteo a ciegas. Esta columna guarda una descripción real
(qué devuelve, cuándo usarla, de dónde salen sus parámetros) que el discovery
genera desde la documentación y el admin puede editar. `_build_tool_schemas`
la usa como description del function schema.

Idempotente (ADD COLUMN IF NOT EXISTS), aplica a todos los schemas tenant_*.

Revision ID: 040
Revises: 039
"""

from alembic import op
from sqlalchemy import text

revision = "040"
down_revision = "039"
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
            f'ALTER TABLE "{schema}".connector_tools '
            f'ADD COLUMN IF NOT EXISTS description TEXT'
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".connector_tools DROP COLUMN IF EXISTS description'
        ))
