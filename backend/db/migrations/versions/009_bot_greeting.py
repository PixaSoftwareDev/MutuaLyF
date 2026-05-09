"""Add greeting_message to tenants table.

Revision ID: 009
Revises: 008
Create Date: 2026-05-09
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "009"
down_revision: Union[str, None] = "008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("tenants", sa.Column(
        "greeting_message",
        sa.Text(),
        nullable=True,
        comment="Mensaje de saludo que muestra el bot al iniciar el chat widget",
    ))


def downgrade() -> None:
    op.drop_column("tenants", "greeting_message")
