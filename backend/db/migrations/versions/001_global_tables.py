"""Create global tables: tenants, usage_events.

Revision ID: 001
Revises:
Create Date: 2026-04-30
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Tenants global registry
    op.create_table(
        "tenants",
        sa.Column("id", sa.String(50), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("plan", sa.String(20), nullable=False, server_default="starter"),
        sa.Column("status", sa.String(20), nullable=False, server_default="onboarding"),
        sa.Column("admin_email", sa.String(320), nullable=False),
        sa.Column("widget_token_hash", sa.String(256), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    # Usage events — basis for billing, abuse detection, quota enforcement
    op.create_table(
        "usage_events",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("tenant_id", sa.String(50), nullable=False),
        sa.Column("event_type", sa.String(20), nullable=False),
        sa.Column("value", sa.Integer, nullable=False),
        sa.Column("metadata", postgresql.JSONB, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_index("ix_usage_events_tenant_created", "usage_events", ["tenant_id", "created_at"])
    op.create_index("ix_usage_events_tenant_id", "usage_events", ["tenant_id"])


def downgrade() -> None:
    op.drop_index("ix_usage_events_tenant_created", "usage_events")
    op.drop_index("ix_usage_events_tenant_id", "usage_events")
    op.drop_table("usage_events")
    op.drop_table("tenants")
