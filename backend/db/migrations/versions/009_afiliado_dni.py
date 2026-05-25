"""Agregar columna afiliado_dni a conversaciones en cada schema tenant.

Para capturar la identificación del afiliado en el handoff (Opción A —
just-in-time identification): el operador necesita ver el DNI del usuario
que pide humano sin que se le pida formulario al entrar al chat.

Revision ID: 009
Revises: 008
"""

from alembic import op
from sqlalchemy import text

revision = "009"
down_revision = "008"
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
            f"ADD COLUMN IF NOT EXISTS afiliado_dni VARCHAR(20)"
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".conversaciones '
            f"DROP COLUMN IF EXISTS afiliado_dni"
        ))
