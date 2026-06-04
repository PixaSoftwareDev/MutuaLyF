"""Agregar columna contact_info a handoff_config en cada schema tenant.

Dato de contacto del tenant (teléfono / email / texto libre). Se reutiliza en DOS
mensajes para no duplicarlo:
  (1) cuando no hay operadores online (handoff fuera de horario), y
  (2) el fallback anti-alucinación del orquestador cuando no encuentra información.
Un solo lugar para "cómo contactarnos", configurable por el admin junto al horario.

Revision ID: 019
Revises: 018
"""

from alembic import op
from sqlalchemy import text

revision = "019"
down_revision = "018"
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
            f"ADD COLUMN IF NOT EXISTS contact_info TEXT"
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".handoff_config '
            f"DROP COLUMN IF EXISTS contact_info"
        ))
