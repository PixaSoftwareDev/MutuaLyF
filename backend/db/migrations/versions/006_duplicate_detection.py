"""Add chunk_duplicate_pairs table and unique hash indexes on documentos.

Revision ID: 006
Revises: 005
Create Date: 2026-05-07
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "006"
down_revision: Union[str, None] = "005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _get_tenant_schemas(conn) -> list[str]:
    rows = conn.execute(sa.text(
        "SELECT schema_name FROM information_schema.schemata "
        "WHERE schema_name LIKE 'tenant_%'"
    ))
    return [r[0] for r in rows]


def upgrade() -> None:
    conn = op.get_bind()
    schemas = _get_tenant_schemas(conn)

    for schema in schemas:
        # Add hash columns if missing (idempotent)
        conn.execute(sa.text(f"""
            ALTER TABLE {schema}.documentos
            ADD COLUMN IF NOT EXISTS content_hash_bytes VARCHAR(64),
            ADD COLUMN IF NOT EXISTS content_hash_text  VARCHAR(64)
        """))

        # Unique indexes for deduplication and race-condition safety
        conn.execute(sa.text(f"""
            CREATE UNIQUE INDEX IF NOT EXISTS ix_documentos_hash_bytes
            ON {schema}.documentos (content_hash_bytes)
            WHERE content_hash_bytes IS NOT NULL
        """))
        conn.execute(sa.text(f"""
            CREATE UNIQUE INDEX IF NOT EXISTS ix_documentos_hash_text
            ON {schema}.documentos (content_hash_text)
            WHERE content_hash_text IS NOT NULL
        """))

        # Chunk duplicate pairs table
        conn.execute(sa.text(f"""
            CREATE TABLE IF NOT EXISTS {schema}.chunk_duplicate_pairs (
                id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                chunk_id_a   VARCHAR(100) NOT NULL,
                chunk_id_b   VARCHAR(100) NOT NULL,
                doc_id_a     UUID NOT NULL,
                doc_id_b     UUID NOT NULL,
                text_a       TEXT NOT NULL,
                text_b       TEXT NOT NULL,
                jaccard_score FLOAT,
                cosine_score  FLOAT,
                status       VARCHAR(20) NOT NULL DEFAULT 'pending',
                resolved_by  UUID,
                resolved_at  TIMESTAMPTZ,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """))
        conn.execute(sa.text(f"""
            CREATE UNIQUE INDEX IF NOT EXISTS ix_chunk_dup_pair
            ON {schema}.chunk_duplicate_pairs (
                LEAST(chunk_id_a, chunk_id_b),
                GREATEST(chunk_id_a, chunk_id_b)
            )
        """))
        conn.execute(sa.text(f"""
            CREATE INDEX IF NOT EXISTS ix_chunk_dup_status
            ON {schema}.chunk_duplicate_pairs (status, created_at)
        """))


def downgrade() -> None:
    conn = op.get_bind()
    schemas = _get_tenant_schemas(conn)
    for schema in schemas:
        conn.execute(sa.text(f"DROP TABLE IF EXISTS {schema}.chunk_duplicate_pairs"))
        conn.execute(sa.text(f"DROP INDEX IF EXISTS {schema}.ix_documentos_hash_bytes"))
        conn.execute(sa.text(f"DROP INDEX IF EXISTS {schema}.ix_documentos_hash_text"))
