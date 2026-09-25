"""Canal "Chat por link": interruptor propio en public.tenants.

La página /chat (ruta corta /chat/{tenant}) es un canal más, separado del widget
embebido: el cliente comparte el link por WhatsApp/mail/redes y abre el bot en
una ventana. Puede querer el link vivo y el globo apagado (o al revés), por eso
el flag es propio y no reusa widget_enabled.

Las conversaciones que entran por el link se guardan con channel='link' en
conversaciones.channel (VARCHAR sin CHECK, no hace falta migrar la columna).

Idempotente (ADD COLUMN IF NOT EXISTS). Default TRUE: el circuito público de
/chat?tenant= ya existía y seguía respondiendo — no se apaga nada al migrar.

Revision ID: 056
Revises: ⚠️ CADENA DIVERGENTE. En dev-local la cabeza es 054 (052-054 son de
conectores y viven solo ahí); en dev/main la cabeza es 055. Al cherry-pickear
a dev/main cambiar down_revision a "055" y verificar con `alembic heads` que
quede UNA sola cabeza — una cadena rota = crash-loop del backend al arrancar.
"""

from alembic import op
from sqlalchemy import text

revision = "056"
down_revision = "055"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(text(
        "ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS chat_link_enabled BOOLEAN NOT NULL DEFAULT TRUE"
    ))


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(text("ALTER TABLE public.tenants DROP COLUMN IF EXISTS chat_link_enabled"))
