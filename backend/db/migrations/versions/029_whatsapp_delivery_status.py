"""Estados de entrega/lectura (ticks ✓✓) para mensajes salientes de WhatsApp.

Agrega a `mensajes` (todos los schemas tenant):
- external_message_id: el wamid que devuelve Meta al enviar. Permite matchear los
  webhooks de status (sent/delivered/read) con el mensaje correspondiente.
- delivery_status: estado de entrega del mensaje saliente (sent|delivered|read|failed).

Alcance actual: solo se popula para mensajes del operador (relay). El bot/sistema
no llevan tick. Columnas nullable → no afecta a otros canales ni mensajes viejos.

Idempotente (IF NOT EXISTS) — base compartida prod<->staging.

Revision ID: 029
Revises: 028
"""

from alembic import op
from sqlalchemy import text

revision = "029"
down_revision = "028"
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
            f'ALTER TABLE "{schema}".mensajes ADD COLUMN IF NOT EXISTS external_message_id VARCHAR(128)'
        ))
        conn.execute(text(
            f'ALTER TABLE "{schema}".mensajes ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(20)'
        ))
        conn.execute(text(
            f'CREATE INDEX IF NOT EXISTS ix_mensajes_external_msg '
            f'ON "{schema}".mensajes (external_message_id) WHERE external_message_id IS NOT NULL'
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(f'DROP INDEX IF EXISTS "{schema}".ix_mensajes_external_msg'))
        conn.execute(text(f'ALTER TABLE "{schema}".mensajes DROP COLUMN IF EXISTS delivery_status'))
        conn.execute(text(f'ALTER TABLE "{schema}".mensajes DROP COLUMN IF EXISTS external_message_id'))
