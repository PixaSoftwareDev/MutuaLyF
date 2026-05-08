"""Add is_default column to sectores table.

Revision ID: 008
Revises: 007
Create Date: 2026-05-08
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text

revision: str = "008"
down_revision: Union[str, None] = "007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    # Discover all tenant schemas
    schemas = conn.execute(text(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'"
    )).fetchall()

    for (schema,) in schemas:
        conn.execute(text(
            f"ALTER TABLE {schema}.sectores ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE"
        ))
        # Set 'Consultas Generales' as default if it exists, else first active sector
        conn.execute(text(f"""
            UPDATE {schema}.sectores SET is_default = TRUE
            WHERE id = (
                SELECT id FROM {schema}.sectores
                WHERE is_active = TRUE
                ORDER BY (nombre = 'Consultas Generales') DESC, created_at ASC
                LIMIT 1
            )
        """))


def downgrade() -> None:
    conn = op.get_bind()
    schemas = conn.execute(text(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'"
    )).fetchall()
    for (schema,) in schemas:
        conn.execute(text(f"ALTER TABLE {schema}.sectores DROP COLUMN IF EXISTS is_default"))
