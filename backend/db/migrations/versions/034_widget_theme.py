"""Tema del widget embebido: claro u oscuro, elegido por el admin en Apariencia.

Revision ID: 034
Revises: 033
"""

from alembic import op

revision = "034"
down_revision = "033"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE public.tenants
        ADD COLUMN IF NOT EXISTS widget_theme VARCHAR(10) NOT NULL DEFAULT 'light'
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE public.tenants DROP COLUMN IF EXISTS widget_theme")
