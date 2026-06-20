"""Drop columnas WhatsApp abandonadas de public.tenants (impl vieja, mig 023).

La config real de WhatsApp vive en public.whatsapp_accounts (mig 025). Las columnas
whatsapp_phone_number_id / whatsapp_access_token de public.tenants quedaron muertas
tras migrar a whatsapp_accounts; ningún código de la app las usa (solo aparecían en
la mig 023). El único tenant con datos ahí (intellix) ya tiene su cuenta en
whatsapp_accounts → el dato es redundante.

Idempotente (IF EXISTS) — prod y staging comparten base + alembic_version global.

Revision ID: 027
Revises: 026
"""

from alembic import op
from sqlalchemy import text

revision = "027"
down_revision = "026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(text("DROP INDEX IF EXISTS public.ix_tenants_whatsapp_phone_number_id"))
    conn.execute(text("ALTER TABLE public.tenants DROP COLUMN IF EXISTS whatsapp_phone_number_id"))
    conn.execute(text("ALTER TABLE public.tenants DROP COLUMN IF EXISTS whatsapp_access_token"))


def downgrade() -> None:
    # Recrea la estructura (no los datos; eran redundantes con whatsapp_accounts).
    conn = op.get_bind()
    conn.execute(text(
        "ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id VARCHAR(64)"
    ))
    conn.execute(text(
        "ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS whatsapp_access_token TEXT"
    ))
    conn.execute(text(
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_tenants_whatsapp_phone_number_id "
        "ON public.tenants (whatsapp_phone_number_id) WHERE whatsapp_phone_number_id IS NOT NULL"
    ))
