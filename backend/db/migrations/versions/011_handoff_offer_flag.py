"""Agregar is_handoff_offer a mensajes en cada schema tenant.

Antes la 'tarjeta con botón' del handoff se reconocía en el frontend
comparando el texto del mensaje contra un state local — frágil: cualquier
re-render del polling perdía el flag y el botón desaparecía.

Ahora persistimos la flag en DB: el backend marca is_handoff_offer=true
cuando inserta el mensaje system de oferta, y el cliente lo lee directo
del payload de /poll. Inmune a sincronía de estado.

Revision ID: 011
Revises: 010
"""

from alembic import op
from sqlalchemy import text

revision = "011"
down_revision = "010"
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
            f'ALTER TABLE "{schema}".mensajes '
            f"ADD COLUMN IF NOT EXISTS is_handoff_offer BOOLEAN NOT NULL DEFAULT FALSE"
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".mensajes '
            f"DROP COLUMN IF EXISTS is_handoff_offer"
        ))
