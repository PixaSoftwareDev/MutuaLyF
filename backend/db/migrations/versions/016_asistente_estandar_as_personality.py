"""Move Asistente estándar from system component to personality bot.

Revision ID: 016
Revises: 015
Create Date: 2026-05-11
"""
from typing import Sequence, Union
import sqlalchemy as sa
from alembic import op

revision: str = "016"
down_revision: Union[str, None] = "015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    # Asistente estándar is a personality — admins can select it.
    # Validador and Etiquetador remain system-only infrastructure.
    conn.execute(sa.text("""
        UPDATE public.system_prompt_templates
        SET is_system = FALSE, updated_at = NOW()
        WHERE nombre = 'Asistente estándar' AND created_by = 'system'
    """))


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("""
        UPDATE public.system_prompt_templates
        SET is_system = TRUE, updated_at = NOW()
        WHERE nombre = 'Asistente estándar' AND created_by = 'system'
    """))
