"""Guardar el widget-token cifrado para poder copiarlo sin regenerar.

El widget-token es semi-público (va embebido en el HTML de la web del cliente).
Se guarda cifrado (core/crypto, Fernet) ADEMÁS del hash, para que el admin pueda
copiarlo desde el panel sin regenerar — regenerar invalidaría el token ya
instalado en las webs de los clientes.

Idempotente (IF NOT EXISTS) — base compartida prod<->staging.

Revision ID: 028
Revises: 027
"""

from alembic import op
from sqlalchemy import text

revision = "028"
down_revision = "027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.get_bind().execute(text(
        "ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS widget_token_enc TEXT"
    ))


def downgrade() -> None:
    op.get_bind().execute(text(
        "ALTER TABLE public.tenants DROP COLUMN IF EXISTS widget_token_enc"
    ))
