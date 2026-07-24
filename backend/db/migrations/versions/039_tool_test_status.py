"""Estado persistente de la última prueba por operación de conector.

Antes el resultado de "Probar" vivía solo en el modal: al cerrarlo no quedaba
rastro de qué operaciones andan y cuáles no. Estas columnas guardan el último
dry-run (manual o masivo) para que la lista de operaciones muestre el estado
de un vistazo: verde (probada), rojo (falló, con el detalle), gris (sin probar).

Idempotente (ADD COLUMN IF NOT EXISTS), aplica a todos los schemas tenant_*.

Revision ID: 039
Revises: 038
"""

from alembic import op
from sqlalchemy import text

revision = "039"
down_revision = "038"
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
            f'ADD COLUMN IF NOT EXISTS last_test_ok BOOLEAN, '
            f'ADD COLUMN IF NOT EXISTS last_test_at TIMESTAMPTZ, '
            f'ADD COLUMN IF NOT EXISTS last_test_detail TEXT'
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".connector_tools '
            f'DROP COLUMN IF EXISTS last_test_ok, '
            f'DROP COLUMN IF EXISTS last_test_at, '
            f'DROP COLUMN IF EXISTS last_test_detail'
        ))
