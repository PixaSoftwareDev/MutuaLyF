"""Columna is_test en conversaciones — cierra drift de schema.

El flag is_test ("Probar chat" del admin, excluido de métricas) se usaba en
widget_conversation.py, operator_panel.py y metrics.py pero nunca tuvo
migración ni entrada en tenant_schema.sql: en las bases existentes la columna
se agregó a mano. Todo tenant provisionado de cero nacía sin ella y el widget
devolvía 500 en /widget/conversation/start.

Idempotente (IF NOT EXISTS) — segura sobre bases que ya tienen la columna.

Revision ID: 037
Revises: 036
"""

from alembic import op
from sqlalchemy import text

revision = "037"
down_revision = "036"
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
            "ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE"
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".conversaciones DROP COLUMN IF EXISTS is_test'
        ))
