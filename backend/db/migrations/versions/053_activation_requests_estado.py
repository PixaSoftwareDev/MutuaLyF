"""Solicitudes de activación con estado: pending | denied.

El super-admin ahora puede DENEGAR una solicitud (antes solo podía aprobarla o
dejarla juntando polvo). La denegación no borra la fila — la marca, para que
el panel del admin muestre "Solicitud denegada" con el motivo en vez de volver
a "Inactivo" en silencio (misma lección que el aviso de aprobación). La fila
muere cuando el admin la da por vista, re-pide activación (revive a pending) o
activa el conector.

Revision ID: 052
Revises: 051
"""

from alembic import op
from sqlalchemy import text

revision = "053"
down_revision = "052"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(text(
        "ALTER TABLE public.connector_activation_requests "
        "ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'"
    ))
    conn.execute(text(
        "ALTER TABLE public.connector_activation_requests "
        "ADD COLUMN IF NOT EXISTS denied_reason TEXT"
    ))
    conn.execute(text(
        "ALTER TABLE public.connector_activation_requests "
        "ADD COLUMN IF NOT EXISTS resolved_by TEXT"
    ))
    conn.execute(text(
        "ALTER TABLE public.connector_activation_requests "
        "ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ"
    ))


def downgrade() -> None:
    conn = op.get_bind()
    for col in ("status", "denied_reason", "resolved_by", "resolved_at"):
        conn.execute(text(
            f"ALTER TABLE public.connector_activation_requests DROP COLUMN IF EXISTS {col}"
        ))
