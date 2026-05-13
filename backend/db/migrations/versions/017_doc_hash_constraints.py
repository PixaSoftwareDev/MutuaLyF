"""Add missing unique constraints on documentos.content_hash_* for legacy tenants.

Revision ID: 017
Revises: 016
Create Date: 2026-05-13

The schema in tenant_schema.sql declares uq_doc_hash_bytes but tenants provisioned
before that line was added are missing the constraint, which makes the
ON CONFLICT ON CONSTRAINT uq_doc_hash_bytes clause in ingest.py fail with 500.
"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "017"
down_revision: Union[str, None] = "016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    schemas = conn.execute(text(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'"
    )).fetchall()

    for (schema,) in schemas:
        # Constraint on content_hash_bytes — required for ON CONFLICT in ingest.py
        exists = conn.execute(text(f"""
            SELECT 1 FROM pg_constraint
            WHERE conname = 'uq_doc_hash_bytes'
              AND conrelid = '{schema}.documentos'::regclass
        """)).scalar()
        if not exists:
            conn.execute(text(
                f"ALTER TABLE {schema}.documentos "
                f"ADD CONSTRAINT uq_doc_hash_bytes UNIQUE (content_hash_bytes)"
            ))

        # Partial unique index on content_hash_text (WHERE NOT NULL) for soft-dedup
        conn.execute(text(
            f"CREATE UNIQUE INDEX IF NOT EXISTS ix_documentos_hash_text "
            f"ON {schema}.documentos (content_hash_text) WHERE content_hash_text IS NOT NULL"
        ))


def downgrade() -> None:
    conn = op.get_bind()
    schemas = conn.execute(text(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'"
    )).fetchall()

    for (schema,) in schemas:
        conn.execute(text(f"ALTER TABLE {schema}.documentos DROP CONSTRAINT IF EXISTS uq_doc_hash_bytes"))
        conn.execute(text(f"DROP INDEX IF EXISTS {schema}.ix_documentos_hash_text"))
