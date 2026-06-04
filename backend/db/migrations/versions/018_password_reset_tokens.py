"""Tabla global password_reset_tokens — flujo de restablecer contraseña.

Token de un solo uso, guardado HASHEADO (sha256), con expiración. El flujo:
  1. /auth/forgot-password genera un token, guarda su hash + expiración y envía
     el link por email.
  2. /auth/reset-password valida el token (existe, no usado, no expirado),
     actualiza la contraseña del usuario en su tenant y marca el token usado.

Global (public) porque el reset-password solo recibe el token — no sabe el
tenant hasta resolverlo desde acá. user_id es el UUID en tenant_X.usuarios.

Revision ID: 018
Revises: 017
"""

import sqlalchemy as sa
from alembic import op

revision = "018"
down_revision = "017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "password_reset_tokens",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True),
                  primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),  # sha256 hex
        sa.Column("tenant_id", sa.String(50), nullable=False),
        sa.Column("user_id", sa.String(64), nullable=False),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
    )
    op.create_index("ix_password_reset_token_hash", "password_reset_tokens", ["token_hash"])
    op.create_index("ix_password_reset_expires", "password_reset_tokens", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_password_reset_expires", table_name="password_reset_tokens")
    op.drop_index("ix_password_reset_token_hash", table_name="password_reset_tokens")
    op.drop_table("password_reset_tokens")
