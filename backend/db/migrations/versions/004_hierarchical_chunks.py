"""Add parent_chunks table to all tenant schemas for hierarchical chunking.

Revision ID: 004
Revises: 003
Create Date: 2026-05-04

parent_chunks stores the parent-level chunks in PostgreSQL.
Child chunks in Qdrant carry parent_id pointing to these rows.
This enables: retrieve child (precise match) → expand to parent (full context).
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    result = conn.execute(sa.text("SELECT id FROM tenants"))
    tenant_ids = [row[0] for row in result]

    for tenant_id in tenant_ids:
        schema = f"tenant_{tenant_id}"
        conn.execute(sa.text(f"""
            CREATE TABLE IF NOT EXISTS {schema}.parent_chunks (
                id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                document_id  UUID NOT NULL,
                text         TEXT NOT NULL,
                chunk_index  INTEGER NOT NULL,
                token_count  INTEGER NOT NULL DEFAULT 0,
                doc_type     VARCHAR(20),
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """))
        conn.execute(sa.text(f"""
            CREATE INDEX IF NOT EXISTS ix_parent_chunks_document
            ON {schema}.parent_chunks (document_id)
        """))


def downgrade() -> None:
    conn = op.get_bind()
    result = conn.execute(sa.text("SELECT id FROM tenants"))
    tenant_ids = [row[0] for row in result]
    for tenant_id in tenant_ids:
        schema = f"tenant_{tenant_id}"
        conn.execute(sa.text(f"DROP TABLE IF EXISTS {schema}.parent_chunks"))
