"""Agrega configuración de WhatsApp Cloud API a la tabla global tenants.

  whatsapp_phone_number_id — ID del número de teléfono en Meta (ej. "123456789")
  whatsapp_access_token    — Token de acceso permanente del sistema (cifrado en reposo)

Ambos son opcionales: NULL significa que el tenant no tiene canal WhatsApp activo.

Revision ID: 023
Revises: 022
"""

from alembic import op
import sqlalchemy as sa

revision = "023"
down_revision = "022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tenants",
        sa.Column("whatsapp_phone_number_id", sa.String(64), nullable=True),
        schema="public",
    )
    op.add_column(
        "tenants",
        sa.Column("whatsapp_access_token", sa.Text, nullable=True),
        schema="public",
    )
    op.create_index(
        "ix_tenants_whatsapp_phone_number_id",
        "tenants",
        ["whatsapp_phone_number_id"],
        unique=True,
        schema="public",
        postgresql_where=sa.text("whatsapp_phone_number_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_tenants_whatsapp_phone_number_id", table_name="tenants", schema="public")
    op.drop_column("tenants", "whatsapp_access_token", schema="public")
    op.drop_column("tenants", "whatsapp_phone_number_id", schema="public")
