"""Agregar columna afiliado_ip a conversaciones en cada schema tenant.

Captura la IP del request HTTP al iniciar la conversación. Si el usuario
nunca da su nombre, queda identificado solo por IP. Si confirma handoff
y da su nombre, ambos quedan juntos en el mismo registro.

Revision ID: 013
Revises: 012
"""

from alembic import op
from sqlalchemy import text

revision = "013"
down_revision = "012"
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
            f"ADD COLUMN IF NOT EXISTS afiliado_ip VARCHAR(45)"
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".conversaciones '
            f"DROP COLUMN IF EXISTS afiliado_ip"
        ))
