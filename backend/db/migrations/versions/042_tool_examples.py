"""Consultas de ejemplo por operación de conector (capability profile).

El router LLM elige la tool leyendo su descripción. Con solo la descripción
abstracta, los sinónimos y lo coloquial fallan ("laburo" vs "proyecto",
"contacto de la clínica" ruteado a docs). Estos ejemplos —frases reales que
disparan la operación, incluyendo las que marcan la FRONTERA con otras fuentes—
se inyectan en lo que ve el LLM y suben la precisión del ruteo sin cambiar el
mecanismo. Se pueden curar a mano o acumular del uso real (data flywheel).

TEXT[] por operación. Idempotente, todos los schemas tenant_*.

Revision ID: 042
Revises: 041
"""

from alembic import op
from sqlalchemy import text

revision = "042"
down_revision = "041"
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
            f"ADD COLUMN IF NOT EXISTS examples TEXT[] NOT NULL DEFAULT '{{}}'"
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".connector_tools DROP COLUMN IF EXISTS examples'
        ))
