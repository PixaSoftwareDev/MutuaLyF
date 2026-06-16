"""Agrega columna channel a conversaciones para distinguir widget vs WhatsApp.

  channel: 'widget' (default) | 'whatsapp' | 'api'

Revision ID: 024
Revises: 023
"""

from alembic import op
from sqlalchemy import text

revision = "024"
down_revision = "023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Obtener todos los schemas tenant
    conn = op.get_bind()
    schemas = conn.execute(
        text("SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'")
    ).fetchall()

    for (schema,) in schemas:
        conn.execute(text(
            f'ALTER TABLE "{schema}".conversaciones '
            f"ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'widget'"
        ))


def downgrade() -> None:
    conn = op.get_bind()
    schemas = conn.execute(
        text("SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'")
    ).fetchall()

    for (schema,) in schemas:
        conn.execute(text(
            f'ALTER TABLE "{schema}".conversaciones DROP COLUMN IF EXISTS channel'
        ))
