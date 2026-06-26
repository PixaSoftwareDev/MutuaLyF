"""Registro histórico de participación operador↔conversación.

Crea `conversacion_operadores` (todos los schemas tenant): una fila por cada
operador que ATENDIÓ una conversación, inmutable, independiente del estado
actual de la conversación.

Por qué: el historial del operador se armaba leyendo `conversaciones.assigned_operator_id`,
que es el operador asignado AHORA (routing). Al volver al bot / soltar a la cola /
transferir de sector / dar de baja al operador, ese campo se limpia y la
conversación DESAPARECÍA del historial de quien la atendió. La participación es un
hecho del pasado y no debe borrarse por un cambio de estado futuro.

- first_assigned_at: cuándo la tomó por primera vez.
- last_released_at: cuándo la soltó (NULL = la sigue atendiendo). Sólo informativo
  (marcar el tramo / métricas); la fila persiste haya o no released.

Backfill (idempotente, ON CONFLICT DO NOTHING):
  1. Conversaciones aún asignadas (assigned_operator_id IS NOT NULL).
  2. Aceptaciones registradas en audit_log (action='handoff.accepted'): reconstruye
     a los operadores que ya soltaron la conversación. actor_id/resource son TEXT;
     se matchean por ::text contra usuarios/conversaciones para evitar casts inválidos
     y FK rotas (usuarios soft-deleteados siguen existiendo).

Idempotente (IF NOT EXISTS / ON CONFLICT) — base compartida prod<->staging.

Revision ID: 030
Revises: 029
"""

from alembic import op
from sqlalchemy import text

revision = "030"
down_revision = "029"
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
            f'CREATE TABLE IF NOT EXISTS "{schema}".conversacion_operadores ('
            f'  conversation_id   UUID NOT NULL REFERENCES "{schema}".conversaciones(id) ON DELETE CASCADE,'
            f'  operador_id       UUID NOT NULL REFERENCES "{schema}".usuarios(id),'
            f'  first_assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),'
            f'  last_released_at  TIMESTAMPTZ,'
            f'  PRIMARY KEY (conversation_id, operador_id)'
            f')'
        ))
        conn.execute(text(
            f'CREATE INDEX IF NOT EXISTS ix_conv_operadores_operador '
            f'ON "{schema}".conversacion_operadores (operador_id, first_assigned_at DESC)'
        ))

        # Backfill 1 — conversaciones todavía asignadas (siguen en atención humana).
        conn.execute(text(
            f'INSERT INTO "{schema}".conversacion_operadores '
            f'  (conversation_id, operador_id, first_assigned_at, last_released_at) '
            f'SELECT c.id, c.assigned_operator_id, c.updated_at, NULL '
            f'FROM "{schema}".conversaciones c '
            f'WHERE c.assigned_operator_id IS NOT NULL '
            f'ON CONFLICT (conversation_id, operador_id) DO NOTHING'
        ))

        # Backfill 2 — aceptaciones históricas desde audit_log. Match por ::text
        # evita castear actor_id/resource no-UUID y asegura FK válidas (usuario y
        # conversación existentes). MIN(created_at) ≈ primer assignment.
        conn.execute(text(
            f'INSERT INTO "{schema}".conversacion_operadores '
            f'  (conversation_id, operador_id, first_assigned_at, last_released_at) '
            f'SELECT c.id, u.id, MIN(a.created_at), NULL '
            f'FROM "{schema}".audit_log a '
            f'JOIN "{schema}".usuarios u       ON u.id::text = a.actor_id '
            f'JOIN "{schema}".conversaciones c ON c.id::text = a.resource '
            f"WHERE a.action = 'handoff.accepted' "
            f'GROUP BY c.id, u.id '
            f'ON CONFLICT (conversation_id, operador_id) DO NOTHING'
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(f'DROP TABLE IF EXISTS "{schema}".conversacion_operadores'))
