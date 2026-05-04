"""Add question_text to consultas_log in all existing tenant schemas.

Revision ID: 002
Revises: 001
Create Date: 2026-05-04

question_text is truncated to 500 chars at write time.
Required by HDBSCAN clustering which needs the actual query text to compute embeddings.
Nullable so existing rows are unaffected.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()

    # Get all tenant schemas from the global tenants table
    result = conn.execute(sa.text("SELECT id FROM tenants"))
    tenant_ids = [row[0] for row in result]

    for tenant_id in tenant_ids:
        schema = f"tenant_{tenant_id}"
        # Add question_text column if it doesn't already exist
        conn.execute(sa.text(f"""
            ALTER TABLE {schema}.consultas_log
            ADD COLUMN IF NOT EXISTS question_text VARCHAR(500)
        """))

    # Index for clustering runs — filter on cluster_status + has text
    for tenant_id in tenant_ids:
        schema = f"tenant_{tenant_id}"
        conn.execute(sa.text(f"""
            CREATE INDEX IF NOT EXISTS ix_consultas_log_clustering
            ON {schema}.consultas_log (cluster_status, created_at)
            WHERE question_text IS NOT NULL
        """))


def downgrade() -> None:
    conn = op.get_bind()
    result = conn.execute(sa.text("SELECT id FROM tenants"))
    tenant_ids = [row[0] for row in result]
    for tenant_id in tenant_ids:
        schema = f"tenant_{tenant_id}"
        conn.execute(sa.text(f"ALTER TABLE {schema}.consultas_log DROP COLUMN IF EXISTS question_text"))
