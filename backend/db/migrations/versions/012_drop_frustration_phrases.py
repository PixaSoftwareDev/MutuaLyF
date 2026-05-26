"""Borrar columna frustration_phrases de handoff_config.

La regla de derivacion por palabras de frustracion fue eliminada del codigo:
ahora la unica forma de derivar es que el bot responda 'no encontre la info'
N veces seguidas (N configurable). El admin ya no edita listas de palabras.

Revision ID: 012
Revises: 011
"""

from alembic import op
from sqlalchemy import text

revision = "012"
down_revision = "011"
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
            f"DROP COLUMN IF EXISTS frustration_phrases"
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".handoff_config '
            f"ADD COLUMN IF NOT EXISTS frustration_phrases JSONB NOT NULL DEFAULT '[]'"
        ))
