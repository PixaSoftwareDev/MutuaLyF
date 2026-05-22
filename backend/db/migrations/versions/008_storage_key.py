"""Agregar columna storage_key a documentos en cada schema tenant.

Revision ID: 008
Revises: 007
"""

from alembic import op
from sqlalchemy import text

revision = "008"
down_revision = "007"
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
            f'ALTER TABLE "{schema}".documentos '
            f"ADD COLUMN IF NOT EXISTS storage_key VARCHAR(1000)"
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".documentos '
            f"DROP COLUMN IF EXISTS storage_key"
        ))
