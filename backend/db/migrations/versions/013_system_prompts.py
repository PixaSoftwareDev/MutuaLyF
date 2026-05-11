"""System prompt templates + tenant assignments.

Revision ID: 013
Revises: 012
Create Date: 2026-05-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "013"
down_revision: Union[str, None] = "012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

PLAN_MAX: dict[str, int] = {
    "starter": 1,
    "professional": 5,
    "enterprise": 999,
}


def upgrade() -> None:
    op.create_table(
        "system_prompt_templates",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("nombre", sa.String(100), nullable=False),
        sa.Column("descripcion", sa.Text, nullable=True),
        sa.Column("contenido", sa.Text, nullable=False),
        sa.Column("categoria", sa.String(50), nullable=False, server_default="general"),
        sa.Column("plan_minimo", sa.String(20), nullable=False, server_default="starter"),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default="true"),
        sa.Column("created_by", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("NOW()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("NOW()")),
        sa.PrimaryKeyConstraint("id"),
        schema="public",
    )
    op.create_index("ix_spt_categoria", "system_prompt_templates", ["categoria"], schema="public")
    op.create_index("ix_spt_active", "system_prompt_templates", ["is_active"], schema="public")

    op.create_table(
        "tenant_prompt_assignments",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.String(50), nullable=False),
        sa.Column("template_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("NOW()")),
        sa.Column("assigned_by", sa.Text, nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id", "template_id", name="uq_tenant_template"),
        sa.ForeignKeyConstraint(["tenant_id"], ["public.tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["template_id"], ["public.system_prompt_templates.id"],
                                ondelete="CASCADE"),
        schema="public",
    )
    op.create_index("ix_tpa_tenant", "tenant_prompt_assignments", ["tenant_id"], schema="public")
    op.create_index("ix_tpa_active", "tenant_prompt_assignments",
                    ["tenant_id", "is_active"], schema="public")

    # Add max_prompt_templates to tenants — super_admin can override per tenant
    op.add_column("tenants",
        sa.Column("max_prompt_templates", sa.Integer, nullable=False, server_default="1"),
        schema="public",
    )
    # Set correct defaults per existing plan
    conn = op.get_bind()
    for plan, max_val in PLAN_MAX.items():
        conn.execute(
            sa.text("UPDATE public.tenants SET max_prompt_templates = :m WHERE plan = :p"),
            {"m": max_val, "p": plan},
        )


def downgrade() -> None:
    op.drop_column("tenants", "max_prompt_templates", schema="public")
    op.drop_table("tenant_prompt_assignments", schema="public")
    op.drop_table("system_prompt_templates", schema="public")
