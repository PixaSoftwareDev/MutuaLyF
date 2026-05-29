"""Drop columnas legacy de conversaciones.

`insufficient_count` y `human_request_count` quedaron como zombies cuando la
maquinaria de handoff se movió a Redis (ver services/handoff.py: _incr_insufficient
con INCR atómico). Nadie las lee ni las escribe desde Día 1 del refactor,
ocupan espacio y aparecen como ruido en queries de schema.

Revision ID: 014
Revises: 013
"""

from alembic import op
from sqlalchemy import text

revision = "014"
down_revision = "013"
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
            f'ALTER TABLE "{schema}".conversaciones '
            f"DROP COLUMN IF EXISTS insufficient_count, "
            f"DROP COLUMN IF EXISTS human_request_count"
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".conversaciones '
            f"ADD COLUMN IF NOT EXISTS insufficient_count  INTEGER NOT NULL DEFAULT 0, "
            f"ADD COLUMN IF NOT EXISTS human_request_count INTEGER NOT NULL DEFAULT 0"
        ))
