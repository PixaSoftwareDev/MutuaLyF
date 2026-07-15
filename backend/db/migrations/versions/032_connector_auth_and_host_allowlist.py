"""Conectores Fase 1: columnas de auth real + allowlist global de hosts aprobados.

Materializa las decisiones del plan docs/PANTALLA_CONECTORES_PLAN.md:
- D1 (secretos Fernet en DB): columna auth_secret_enc en tenant_connectors.
- D2 (gobierno híbrido): tabla global approved_connector_hosts — activar un conector
  hacia un host nuevo exige que el host esté aprobado por super-admin.
- Auth configurable: auth_config (header name, token_url/scopes) y auth_validate_path
  (endpoint de validación de identidad, hoy hardcodeado como convención en el executor).

Por schema tenant_*: ADD COLUMN IF NOT EXISTS sobre tenant_connectors (idempotente).
Global: public.approved_connector_hosts.

Revision ID: 032
Revises: 031
"""

from alembic import op
from sqlalchemy import text

revision = "032"
down_revision = "031"
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

    # ── Global: allowlist de hosts aprobados (D2) ──────────────────────────────
    # Activar un conector hacia un host que no esté acá se rechaza. El alta la hace
    # super-admin; desnormalizamos host como PK (un host aprobado sirve a cualquier
    # tenant que lo quiera usar, pero el conector sigue aislado por schema).
    conn.execute(text(
        "CREATE TABLE IF NOT EXISTS public.approved_connector_hosts ("
        "  host        TEXT PRIMARY KEY,"
        "  approved_by TEXT,"
        "  note        TEXT,"
        "  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()"
        ")"
    ))

    # ── Por tenant: columnas de auth en tenant_connectors ──────────────────────
    for schema in _tenant_schemas(conn):
        conn.execute(text(
            f'ALTER TABLE "{schema}".tenant_connectors '
            f'ADD COLUMN IF NOT EXISTS auth_config JSONB NOT NULL DEFAULT \'{{}}\''
        ))
        conn.execute(text(
            f'ALTER TABLE "{schema}".tenant_connectors '
            f'ADD COLUMN IF NOT EXISTS auth_secret_enc TEXT'
        ))
        conn.execute(text(
            f'ALTER TABLE "{schema}".tenant_connectors '
            f'ADD COLUMN IF NOT EXISTS auth_validate_path TEXT'
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(text(f'ALTER TABLE "{schema}".tenant_connectors DROP COLUMN IF EXISTS auth_validate_path'))
        conn.execute(text(f'ALTER TABLE "{schema}".tenant_connectors DROP COLUMN IF EXISTS auth_secret_enc'))
        conn.execute(text(f'ALTER TABLE "{schema}".tenant_connectors DROP COLUMN IF EXISTS auth_config'))
    conn.execute(text("DROP TABLE IF EXISTS public.approved_connector_hosts"))
