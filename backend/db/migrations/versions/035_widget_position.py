"""Posición del widget embebido: esquina derecha (default) o izquierda.

Revision ID: 035
Revises: 034
"""

from alembic import op

revision = "035"
down_revision = "034"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE public.tenants
        ADD COLUMN IF NOT EXISTS widget_position VARCHAR(6) NOT NULL DEFAULT 'right'
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE public.tenants DROP COLUMN IF EXISTS widget_position")
