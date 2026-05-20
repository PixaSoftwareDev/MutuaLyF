"""Drop columna prompt_query — huérfana desde migration 001.

Encontrada durante auditoria de dead code 2026-05-20:
- Definida en `001_initial_schema.py:147` como `prompt_query TEXT NULL`
- Cero referencias en el codebase (`grep -r prompt_query backend/` solo match
  en la migration que la crea)
- Probablemente leftover de un diseño anterior reemplazado por
  `system_prompt_templates` + `tenant_prompt_assignments`

Revision ID: 007
Revises: 006
"""

from alembic import op

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("tenants", "prompt_query", schema="public")


def downgrade() -> None:
    import sqlalchemy as sa
    op.add_column(
        "tenants",
        sa.Column("prompt_query", sa.Text(), nullable=True),
        schema="public",
    )
