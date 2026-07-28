"""Derivación proactiva por palabras clave (Regla 5 del handoff).

Grupos de palabras/frases configurables por tenant que, al aparecer en un
mensaje del afiliado, disparan la oferta de derivación a operador SIN esperar
a que el bot falle (caso real: "turno/turnos/agenda/reserva" en una mutual —
sacar un turno es una gestión, no una consulta, y el bot no puede resolverla).

Estructura: [{"words": ["turno", "sacar turno"], "message": "¿Querés...?"}]
El message vacío usa el handoff_offer default del tenant.

Idempotente (ADD COLUMN IF NOT EXISTS), aplica a todos los schemas tenant_*.

Revision ID: 044
Revises: 043
"""

from alembic import op
from sqlalchemy import text

revision = "044"
down_revision = "043"
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
            f'ALTER TABLE "{schema}".handoff_config '
            f"ADD COLUMN IF NOT EXISTS keyword_triggers JSONB NOT NULL DEFAULT '[]'::jsonb"
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".handoff_config '
            f'DROP COLUMN IF EXISTS keyword_triggers'
        ))
