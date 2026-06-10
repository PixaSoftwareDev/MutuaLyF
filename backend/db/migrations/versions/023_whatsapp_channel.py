"""Canal WhatsApp (Cloud API de Meta, directo).

Global (public):
  - whatsapp_accounts: credenciales por tenant, cifradas. phone_number_id es
    ÚNICO: es la clave de ruteo del webhook entrante (todos los tenants
    apuntan su app de Meta a la misma URL nuestra).
  - tenants.widget_enabled: activación del canal widget desde el panel.

Por tenant (todos los schemas tenant_%):
  - conversaciones.channel ('widget' | 'whatsapp') + external_id (wa_id del
    cliente) con índice para el lookup del entrante.

Idempotente (IF NOT EXISTS) — prod y staging comparten base.

Revision ID: 023
Revises: 022
"""

from alembic import op
from sqlalchemy import text

revision = "023"
down_revision = "022"
branch_labels = None
depends_on = None


def _tenant_schemas(conn) -> list[str]:
    result = conn.execute(text(
        "SELECT schema_name FROM information_schema.schemata "
        "WHERE schema_name LIKE :pat ESCAPE '\\'"
    ), {"pat": r"tenant\_%"})
    return [r[0] for r in result.fetchall()]


def upgrade() -> None:
    conn = op.get_bind()

    # Sin FK a tenants(id): el tipo de esa PK varió entre instalaciones y el
    # onboarding/rollback de tenants borra por código, no por cascada.
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS public.whatsapp_accounts (
            tenant_id         TEXT PRIMARY KEY,
            phone_number_id   VARCHAR(50) NOT NULL UNIQUE,
            waba_id           VARCHAR(50),
            display_phone     VARCHAR(30),
            access_token_enc  TEXT NOT NULL,
            app_secret_enc    TEXT,
            verify_token      VARCHAR(64) NOT NULL,
            enabled           BOOLEAN NOT NULL DEFAULT FALSE,
            status            VARCHAR(20) NOT NULL DEFAULT 'pending',
            last_verified_at  TIMESTAMPTZ,
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """))

    conn.execute(text(
        "ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS widget_enabled BOOLEAN NOT NULL DEFAULT TRUE"
    ))

    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".conversaciones '
            "ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'widget'"
        ))
        conn.execute(text(
            f'ALTER TABLE "{schema}".conversaciones '
            "ADD COLUMN IF NOT EXISTS external_id VARCHAR(64)"
        ))
        conn.execute(text(
            f'CREATE INDEX IF NOT EXISTS ix_conversaciones_channel_ext '
            f'ON "{schema}".conversaciones (channel, external_id) WHERE external_id IS NOT NULL'
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(f'DROP INDEX IF EXISTS "{schema}".ix_conversaciones_channel_ext'))
        conn.execute(text(f'ALTER TABLE "{schema}".conversaciones DROP COLUMN IF EXISTS external_id'))
        conn.execute(text(f'ALTER TABLE "{schema}".conversaciones DROP COLUMN IF EXISTS channel'))
    conn.execute(text("ALTER TABLE public.tenants DROP COLUMN IF EXISTS widget_enabled"))
    conn.execute(text("DROP TABLE IF EXISTS public.whatsapp_accounts"))
