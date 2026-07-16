"""Registro de identidad por conector — usuarios autorizados de NUESTRO lado.

Para conectores cuyo sistema externo NO modela usuarios/afiliados (ej. un CRM que
solo tiene un token de servicio), la identidad de quién puede consultar la
validamos nosotros: una lista blanca por conector con documento + email + nombre.

Flujo (identity_validation='platform_registry', ver connector_router):
  persona tipea su documento → lo buscamos en connector_users (esta tabla) →
  enviamos OTP a SU email registrado → validado → sesión. El bot llama al tercero
  siempre con el token de servicio del conector, nunca con datos del usuario.
  La defensa BOLA/IDOR queda de nuestro lado: consultamos con la identidad que YA
  validamos, jamás con lo que tipea el usuario.

Tabla por schema tenant_*: connector_users. Idempotente (IF NOT EXISTS).
Nace is_active=TRUE por fila (un usuario cargado por el admin está habilitado);
el conector sigue naciendo inactivo desde la 031.

Revision ID: 033
Revises: 032
"""

from alembic import op
from sqlalchemy import text

revision = "033"
down_revision = "032"
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
            f'CREATE TABLE IF NOT EXISTS "{schema}".connector_users ('
            f'  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),'
            f'  connector_id  UUID NOT NULL REFERENCES "{schema}".tenant_connectors(id) ON DELETE CASCADE,'
            f'  documento     TEXT NOT NULL,'
            f'  email         TEXT NOT NULL,'
            f'  nombre        TEXT NOT NULL,'
            f'  is_active     BOOLEAN NOT NULL DEFAULT TRUE,'
            f'  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),'
            f'  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),'
            # documento es el identificador que la persona tipea en el chat → único
            # por conector para que la búsqueda sea inequívoca. email es el destino
            # del OTP → también único (dos personas no comparten casilla de 2º factor).
            f'  UNIQUE (connector_id, documento),'
            f'  UNIQUE (connector_id, email)'
            f')'
        ))
        # Búsqueda del run de login: por (connector_id, documento) filtrando activos.
        conn.execute(text(
            f'CREATE INDEX IF NOT EXISTS idx_connector_users_lookup '
            f'ON "{schema}".connector_users (connector_id, documento) WHERE is_active'
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(f'DROP TABLE IF EXISTS "{schema}".connector_users'))
