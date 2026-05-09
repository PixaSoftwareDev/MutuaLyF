"""Add configurable prompt fields to tenants table.

Revision ID: 010
Revises: 009
Create Date: 2026-05-09
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "010"
down_revision: Union[str, None] = "009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("tenants", sa.Column(
        "prompt_query", sa.Text(), nullable=True,
        comment="System prompt principal del asistente. NULL = usa el default del sistema.",
    ))
    op.add_column("tenants", sa.Column(
        "prompt_quality_gate", sa.Text(), nullable=True,
        comment="Prompt para validar coherencia de chunks en ingesta. NULL = usa el default.",
    ))
    op.add_column("tenants", sa.Column(
        "prompt_cluster_label", sa.Text(), nullable=True,
        comment="Prompt para nombrar clusters de intenciones. NULL = usa el default.",
    ))


def downgrade() -> None:
    op.drop_column("tenants", "prompt_cluster_label")
    op.drop_column("tenants", "prompt_quality_gate")
    op.drop_column("tenants", "prompt_query")
