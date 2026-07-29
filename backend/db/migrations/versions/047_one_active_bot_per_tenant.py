"""Un solo bot activo por tenant (fix de personalidades duplicadas).

La creación de tenant activaba la personalidad elegida en el wizard SIN
desactivar "Asistente estándar" que auto_assign_system_templates acababa de
activar → tenants nuevos quedaban con DOS asignaciones activas y el orquestador
elegía una al azar (LIMIT 1 sin ORDER BY).

Reparación: para cada tenant con más de una asignación activa se conserva la
más reciente (la elegida en el wizard — se insertó después de la estándar) y se
desactiva el resto. Después, índice único parcial para que el motor no permita
volver a este estado.

Revision ID: 047
Revises: 046
"""

from alembic import op
from sqlalchemy import text

revision = "047"
down_revision = "046"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(text("""
        UPDATE public.tenant_prompt_assignments a
        SET is_active = FALSE
        WHERE a.is_active = TRUE
          AND a.id <> (
              SELECT b.id FROM public.tenant_prompt_assignments b
              WHERE b.tenant_id = a.tenant_id AND b.is_active = TRUE
              ORDER BY b.assigned_at DESC, b.id DESC
              LIMIT 1
          )
    """))
    conn.execute(text("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_tpa_one_active_per_tenant
        ON public.tenant_prompt_assignments (tenant_id) WHERE is_active
    """))


def downgrade() -> None:
    # Las desactivaciones de datos no se revierten (no hay forma de saber
    # cuáles estaban duplicadas); solo se quita el índice.
    conn = op.get_bind()
    conn.execute(text("DROP INDEX IF EXISTS public.uq_tpa_one_active_per_tenant"))
