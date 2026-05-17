"""Add bot_name and onboarding_completed to tenants.

Revision ID: 002
Revises: 001
"""

from alembic import op
import sqlalchemy as sa

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tenants", sa.Column("bot_name", sa.String(100), nullable=True))
    op.add_column("tenants", sa.Column("onboarding_completed", sa.Boolean(), nullable=False, server_default="false"))


def downgrade() -> None:
    op.drop_column("tenants", "bot_name")
    op.drop_column("tenants", "onboarding_completed")
