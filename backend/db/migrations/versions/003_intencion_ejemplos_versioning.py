"""Add version_id and question_text to intencion_ejemplos in all tenant schemas.

Revision ID: 003
Revises: 002
Create Date: 2026-05-04

version_id links each example to the training run that introduced it.
question_text allows retraining without joining consultas_log (avoids orphan examples after cleanup).
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    result = conn.execute(sa.text("SELECT id FROM tenants"))
    tenant_ids = [row[0] for row in result]

    for tenant_id in tenant_ids:
        schema = f"tenant_{tenant_id}"
        conn.execute(sa.text(f"""
            ALTER TABLE {schema}.intencion_ejemplos
            ADD COLUMN IF NOT EXISTS version_id    VARCHAR(50),
            ADD COLUMN IF NOT EXISTS question_text VARCHAR(500)
        """))
        # Track accuracy history per intention
        conn.execute(sa.text(f"""
            ALTER TABLE {schema}.intenciones
            ADD COLUMN IF NOT EXISTS last_accuracy     FLOAT,
            ADD COLUMN IF NOT EXISTS prev_model_version VARCHAR(50)
        """))


def downgrade() -> None:
    conn = op.get_bind()
    result = conn.execute(sa.text("SELECT id FROM tenants"))
    tenant_ids = [row[0] for row in result]
    for tenant_id in tenant_ids:
        schema = f"tenant_{tenant_id}"
        conn.execute(sa.text(f"""
            ALTER TABLE {schema}.intencion_ejemplos
            DROP COLUMN IF EXISTS version_id,
            DROP COLUMN IF EXISTS question_text
        """))
        conn.execute(sa.text(f"""
            ALTER TABLE {schema}.intenciones
            DROP COLUMN IF EXISTS last_accuracy,
            DROP COLUMN IF EXISTS prev_model_version
        """))
