"""Feedback del afiliado al cierre de la conversación (caritas 1-3).

Una calificación por conversación, al cierre (cierre explícito o reapertura
del widget). El rating negativo/neutro entra a una cola de revisión del admin
con acciones de un click (falta contenido / info errónea / el bot entendió
mal / descartar). Diseño charlado con Alejo 2026-07-27: sin feedback por
respuesta (menos ruido visual), sin auto-aprendizaje — el lazo siempre pasa
por humanos.

  feedback_rating         1=😞 2=😐 3=😊
  feedback_reason         chip opcional: not_found | wrong_info | slow_service
  feedback_review_status  pending (rating 1-2) | resolved | dismissed | NULL (😊 o sin feedback)
  feedback_review_action  missing_content | wrong_content | bot_misunderstood | dismissed

Idempotente (ADD COLUMN IF NOT EXISTS), aplica a todos los schemas tenant_*.

Revision ID: 045
Revises: 044
"""

from alembic import op
from sqlalchemy import text

revision = "045"
down_revision = "044"
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
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".conversaciones '
            f"ADD COLUMN IF NOT EXISTS feedback_rating SMALLINT, "
            f"ADD COLUMN IF NOT EXISTS feedback_reason TEXT, "
            f"ADD COLUMN IF NOT EXISTS feedback_at TIMESTAMPTZ, "
            f"ADD COLUMN IF NOT EXISTS feedback_review_status TEXT, "
            f"ADD COLUMN IF NOT EXISTS feedback_review_action TEXT, "
            f"ADD COLUMN IF NOT EXISTS feedback_reviewed_by UUID, "
            f"ADD COLUMN IF NOT EXISTS feedback_reviewed_at TIMESTAMPTZ"
        ))
        # La cola del admin lista por estado + fecha; parcial para no indexar
        # el 99% de filas sin feedback pendiente.
        conn.execute(text(
            f'CREATE INDEX IF NOT EXISTS ix_conversaciones_feedback_pending '
            f'ON "{schema}".conversaciones (feedback_at DESC) '
            f"WHERE feedback_review_status = 'pending'"
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'DROP INDEX IF EXISTS "{schema}".ix_conversaciones_feedback_pending'
        ))
        conn.execute(text(
            f'ALTER TABLE "{schema}".conversaciones '
            f"DROP COLUMN IF EXISTS feedback_rating, "
            f"DROP COLUMN IF EXISTS feedback_reason, "
            f"DROP COLUMN IF EXISTS feedback_at, "
            f"DROP COLUMN IF EXISTS feedback_review_status, "
            f"DROP COLUMN IF EXISTS feedback_review_action, "
            f"DROP COLUMN IF EXISTS feedback_reviewed_by, "
            f"DROP COLUMN IF EXISTS feedback_reviewed_at"
        ))
