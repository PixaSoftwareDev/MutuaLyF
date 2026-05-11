"""Add is_system flag to prompt templates + update seed categories.

Revision ID: 015
Revises: 014
Create Date: 2026-05-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "015"
down_revision: Union[str, None] = "014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UPDATES = [
    ("Asistente estándar",         "asistente"),
    ("Validador de documentos",    "calidad"),
    ("Etiquetador de intenciones", "intenciones"),
]


def upgrade() -> None:
    op.add_column(
        "system_prompt_templates",
        sa.Column("is_system", sa.Boolean, nullable=False, server_default="false"),
        schema="public",
    )

    conn = op.get_bind()

    # Mark the 3 seeded defaults as system templates + fix categories
    for nombre, categoria in UPDATES:
        conn.execute(sa.text("""
            UPDATE public.system_prompt_templates
            SET is_system = TRUE, categoria = :cat, updated_at = NOW()
            WHERE nombre = :nombre AND created_by = 'system'
        """), {"nombre": nombre, "cat": categoria})


def downgrade() -> None:
    op.drop_column("system_prompt_templates", "is_system", schema="public")
