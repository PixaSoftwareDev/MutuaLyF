"""Add audit_log table to every existing tenant schema.

Revision ID: 011
Revises: 010
"""

from alembic import op
import sqlalchemy as sa

revision = "011"
down_revision = "010"
branch_labels = None
depends_on = None

_STMTS = [
    """CREATE TABLE IF NOT EXISTS audit_log (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id    TEXT        NOT NULL,
        actor_email TEXT,
        actor_role  TEXT        NOT NULL,
        action      TEXT        NOT NULL,
        resource    TEXT,
        detail      JSONB,
        ip_address  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )""",
    "CREATE INDEX IF NOT EXISTS ix_audit_log_created ON audit_log (created_at DESC)",
    "CREATE INDEX IF NOT EXISTS ix_audit_log_action  ON audit_log (action)",
]


def _tenant_schemas(conn):
    rows = conn.execute(
        sa.text("SELECT id FROM tenants")
    ).fetchall()
    return [f"tenant_{r[0].replace('-', '_')}" for r in rows]


def upgrade():
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(sa.text(f"SET search_path TO {schema}"))
        for stmt in _STMTS:
            conn.execute(sa.text(stmt))
    conn.execute(sa.text("SET search_path TO public"))


def downgrade():
    conn = op.get_bind()
    for schema in _tenant_schemas(conn):
        conn.execute(sa.text(f"SET search_path TO {schema}"))
        conn.execute(sa.text("DROP TABLE IF EXISTS audit_log"))
    conn.execute(sa.text("SET search_path TO public"))
