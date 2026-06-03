"""Agregar columna handoff_requested_at a conversaciones en cada schema tenant.

Marca el momento EXACTO en que la conversación entró a la cola de operador
(status → handoff_requested). El "tiempo esperando" del panel de operador se
mide desde acá, no desde el último mensaje — así es preciso e inmune a que el
afiliado siga escribiendo mientras espera en la cola.

Revision ID: 016
Revises: 015
"""

from alembic import op
from sqlalchemy import text

revision = "016"
down_revision = "015"
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
            f"ADD COLUMN IF NOT EXISTS handoff_requested_at TIMESTAMPTZ"
        ))
        # Backfill defensivo: conversaciones que YA están en la cola al momento de
        # migrar no tienen el timestamp. Usamos updated_at como mejor aproximación
        # disponible (fue NOW() en la última transición). Las nuevas lo setean exacto.
        conn.execute(text(
            f'UPDATE "{schema}".conversaciones '
            f"SET handoff_requested_at = updated_at "
            f"WHERE status = 'handoff_requested' AND handoff_requested_at IS NULL"
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".conversaciones '
            f"DROP COLUMN IF EXISTS handoff_requested_at"
        ))
