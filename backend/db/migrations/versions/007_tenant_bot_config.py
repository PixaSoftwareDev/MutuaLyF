"""Add bot_description, bot_scope, min_retrieval_score to tenants table.

Revision ID: 007
Revises: 006
Create Date: 2026-05-07
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "007"
down_revision: Union[str, None] = "006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("tenants", sa.Column("bot_description", sa.Text(), nullable=True))
    op.add_column("tenants", sa.Column("bot_scope", sa.Text(), nullable=True))
    op.add_column("tenants", sa.Column(
        "min_retrieval_score",
        sa.Float(),
        nullable=False,
        server_default="0.45",
    ))


def downgrade() -> None:
    op.drop_column("tenants", "min_retrieval_score")
    op.drop_column("tenants", "bot_scope")
    op.drop_column("tenants", "bot_description")
