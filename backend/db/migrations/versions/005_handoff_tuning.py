"""Subir el umbral de handoff por insuficiencia de 2 a 3 y refinar el copy.

Razones:
- El detector previo se basaba en `not sources`, lo que marcaba como
  "insuficiente" follow-ups válidos resueltos por historial conversacional.
  El detector nuevo (handoff.py) mira la respuesta del LLM, por lo que el
  umbral 2 quedaba demasiado agresivo — pasamos a 3 turnos consecutivos.
- El copy "Parece que no pude responder tu consulta correctamente" se mostraba
  arriba de una respuesta correcta y resultaba contradictorio. Se reemplaza por
  un texto más suave que solo aparece ante dificultades acumuladas reales.

La migration:
1. Cambia el DEFAULT de la columna en cada schema `tenant_*`.
2. Actualiza filas que sigan con el valor anterior (2). Si el admin lo cambió
   manualmente (1 o 4+), respeta ese override.
3. Actualiza el copy `handoff_offer` solo si coincide con el texto antiguo.

Revision ID: 005
Revises: 004
"""

from alembic import op
from sqlalchemy import text


revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


OLD_OFFER = (
    "Parece que no pude responder tu consulta correctamente. "
    "¿Querés que te conecte con un operador?"
)
NEW_OFFER = (
    "Veo que tengo dificultades para resolver tu consulta. "
    "¿Querés que te conecte con un operador?"
)


def _tenant_schemas(conn) -> list[str]:
    result = conn.execute(text(
        "SELECT schema_name FROM information_schema.schemata "
        "WHERE schema_name LIKE :pat ESCAPE '\\'"
    ), {"pat": r"tenant\_%"})
    return [r[0] for r in result.fetchall()]


def upgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        # 1) Default de columna
        conn.execute(text(
            f'ALTER TABLE "{schema}".handoff_config '
            f"ALTER COLUMN consecutive_insufficient_count SET DEFAULT 3"
        ))
        # 2) Subir filas que sigan en el valor viejo
        conn.execute(text(
            f'UPDATE "{schema}".handoff_config '
            f"SET consecutive_insufficient_count = 3, updated_at = NOW() "
            f"WHERE consecutive_insufficient_count = 2"
        ))
        # 3) Refrescar el copy si nadie lo personalizó
        conn.execute(text(
            f'UPDATE "{schema}".handoff_config '
            f"SET transition_messages = jsonb_set("
            f"  transition_messages, '{{handoff_offer}}', to_jsonb(CAST(:new_offer AS text)), true"
            f"), updated_at = NOW() "
            f"WHERE transition_messages->>'handoff_offer' = :old_offer"
        ), {"new_offer": NEW_OFFER, "old_offer": OLD_OFFER})


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".handoff_config '
            f"ALTER COLUMN consecutive_insufficient_count SET DEFAULT 2"
        ))
        conn.execute(text(
            f'UPDATE "{schema}".handoff_config '
            f"SET consecutive_insufficient_count = 2, updated_at = NOW() "
            f"WHERE consecutive_insufficient_count = 3"
        ))
        conn.execute(text(
            f'UPDATE "{schema}".handoff_config '
            f"SET transition_messages = jsonb_set("
            f"  transition_messages, '{{handoff_offer}}', to_jsonb(CAST(:old_offer AS text)), true"
            f"), updated_at = NOW() "
            f"WHERE transition_messages->>'handoff_offer' = :new_offer"
        ), {"new_offer": NEW_OFFER, "old_offer": OLD_OFFER})
