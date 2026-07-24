"""Candidatos a ejemplo por operación (data flywheel del ruteo).

Cuando el router elige una operación para una consulta y la llamada sale OK, esa
consulta real (con PII enmascarada) se registra como CANDIDATO a ejemplo de esa
operación, contando su frecuencia. El admin los revisa y aprueba desde la UI →
pasan a connector_tools.examples y mejoran el ruteo. Aprobación MANUAL a
propósito: sumar ejemplos a ciegas mete ruido y degrada la decisión del LLM.

Dedup por (tool_id, query_norm). Al aprobar se mueve a examples y se borra el
candidato; al descartar queda status='dismissed' (no se vuelve a sugerir).

Revision ID: 043
Revises: 042
"""

from alembic import op
from sqlalchemy import text

revision = "043"
down_revision = "042"
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
            f'CREATE TABLE IF NOT EXISTS "{schema}".tool_example_candidates ('
            f'  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),'
            f'  tool_id      UUID NOT NULL REFERENCES "{schema}".connector_tools(id) ON DELETE CASCADE,'
            f'  query        TEXT NOT NULL,'          # forma mostrada (PII enmascarada)
            f'  query_norm   TEXT NOT NULL,'          # forma normalizada para dedup
            f'  hits         INTEGER NOT NULL DEFAULT 1,'
            f"  status       TEXT NOT NULL DEFAULT 'pending',"  # pending | dismissed
            f'  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),'
            f'  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),'
            f'  UNIQUE (tool_id, query_norm)'
            f')'
        ))
        # Listado del panel: candidatos pendientes de una tool por frecuencia.
        conn.execute(text(
            f'CREATE INDEX IF NOT EXISTS idx_example_candidates_tool '
            f'ON "{schema}".tool_example_candidates (tool_id, status, hits DESC)'
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(f'DROP TABLE IF EXISTS "{schema}".tool_example_candidates'))
