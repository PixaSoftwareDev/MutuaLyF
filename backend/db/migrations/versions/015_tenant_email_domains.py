"""Tabla global tenant_email_domains — email-first login.

Mapea dominios de email a tenants para acelerar el lookup en login. Es solo
una pista de UX: la fuente de verdad sigue siendo `tenant_X.usuarios.email`.

Cuando un usuario tipea `pedro@nexoconsultora.com.ar`:
  1. Buscamos `nexoconsultora.com.ar` en esta tabla → si match, sabemos
     ir derecho al branding de Nexo.
  2. Si no hay match (dominios genéricos como gmail.com o no cargados aún),
     hacemos lookup cross-tenant por email exacto en `tenant_X.usuarios`.

Sin esta tabla, el lookup cross-tenant es la única opción — funciona pero
es ~100ms para 100 tenants. Con esta tabla, lookup directo en <1ms.

Revision ID: 015
Revises: 014
"""

import sqlalchemy as sa
from alembic import op

revision = "015"
down_revision = "014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tenant_email_domains",
        # Domain como PK: un dominio NO puede pertenecer a 2 tenants a la vez.
        # Si una empresa cambia de tenant, hay que migrar explicitamente.
        sa.Column("domain", sa.String(253), primary_key=True),
        sa.Column("tenant_id", sa.String(50), nullable=False),
        # is_primary: el dominio principal del tenant. Solo uno por tenant.
        # Sirve para "envía notificaciones al @principal del tenant" si en el
        # futuro armamos webhooks/emails generales.
        sa.Column("is_primary", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.ForeignKeyConstraint(["tenant_id"], ["public.tenants.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_tenant_email_domains_tenant", "tenant_email_domains", ["tenant_id"])
    # Indice unico parcial: solo puede haber UN is_primary=true por tenant.
    op.execute(
        "CREATE UNIQUE INDEX uq_tenant_email_domains_primary "
        "ON tenant_email_domains (tenant_id) WHERE is_primary = TRUE"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_tenant_email_domains_primary")
    op.drop_index("ix_tenant_email_domains_tenant", table_name="tenant_email_domains")
    op.drop_table("tenant_email_domains")
