"""Add per-tenant branding columns (display_name, logo_url, colors, favicon).

Revision ID: 003
Revises: 002
"""

from alembic import op
import sqlalchemy as sa

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # display_name: human-readable name shown in login/UI ("Mutualyf S.A.")
    op.add_column("tenants", sa.Column("display_name",    sa.String(200), nullable=True))
    op.add_column("tenants", sa.Column("logo_url",        sa.Text(),      nullable=True))
    op.add_column("tenants", sa.Column("primary_color",   sa.String(9),   nullable=True))  # #RRGGBB or #RRGGBBAA
    op.add_column("tenants", sa.Column("secondary_color", sa.String(9),   nullable=True))
    op.add_column("tenants", sa.Column("favicon_url",     sa.Text(),      nullable=True))

    # Seed sensible defaults for any existing tenant: display_name = id capitalized
    op.execute("""
        UPDATE tenants
        SET display_name  = COALESCE(display_name, INITCAP(name)),
            primary_color = COALESCE(primary_color, '#99323D')
        WHERE display_name IS NULL OR primary_color IS NULL
    """)


def downgrade() -> None:
    op.drop_column("tenants", "favicon_url")
    op.drop_column("tenants", "secondary_color")
    op.drop_column("tenants", "primary_color")
    op.drop_column("tenants", "logo_url")
    op.drop_column("tenants", "display_name")
