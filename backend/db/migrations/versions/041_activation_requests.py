"""Solicitudes de activación de conectores (schema public, global).

Cuando un admin de tenant intenta ACTIVAR un conector cuyos hosts todavía no
están aprobados, además del 403 queda registrada la solicitud: qué tenant, qué
conector y qué hosts pide. El panel super-admin las lista con las rutas del
conector a la vista, aprueba el host y la solicitud se limpia sola cuando el
conector logra activarse.

Una solicitud viva por (tenant, conector): reintentos actualizan la existente.

Revision ID: 041
Revises: 040
"""

from alembic import op
from sqlalchemy import text

revision = "041"
down_revision = "040"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.get_bind().execute(text(
        "CREATE TABLE IF NOT EXISTS public.connector_activation_requests ("
        "  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),"
        "  tenant_id    TEXT NOT NULL,"
        "  connector_id TEXT NOT NULL,"
        "  hosts        TEXT[] NOT NULL,"
        "  requested_by TEXT,"
        "  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
        "  UNIQUE (tenant_id, connector_id)"
        ")"
    ))


def downgrade() -> None:
    op.get_bind().execute(text("DROP TABLE IF EXISTS public.connector_activation_requests"))
