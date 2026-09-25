"""Orden estable de mensajes (seq) y aviso de sector en la cronología.

Auditoría del chat 2026-09-25 (docs/PLAN_CHAT_UX_CONSOLIDADO.md, bloques A y B):

- `mensajes.seq` BIGINT con secuencia por schema: `ORDER BY created_at` solo
  no desempata (id es uuid4; NOW() es el inicio de la transacción y dos
  requests concurrentes se intercalan). El poll ordena por (created_at, seq)
  y el cliente ancla por `last_seq`, monotónico, en vez de comparar el último
  id. Backfill en orden cronológico para las filas existentes.
- `mensajes.is_sector_note`: el aviso "Consulta dirigida al área X" pasa a ser
  un mensaje de sistema persistido (antes era solo de interfaz y "bajaba" con
  cada mensaje nuevo); los clientes lo dibujan como píldora en su lugar.

Idempotente y por schema de tenant. Los tenants nuevos ya nacen con esto vía
db/schemas/tenant_schema.sql.

Revision ID: 057
Revises: 056
"""

from alembic import op
from sqlalchemy import text

revision = "057"
down_revision = "056"
branch_labels = None
depends_on = None


def _schemas(conn):
    return [r[0] for r in conn.execute(text(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'"
    ))]


def _has_table(conn, schema, table):
    return conn.execute(text(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = :s AND table_name = :t"
    ), {"s": schema, "t": table}).scalar()


def _has_column(conn, schema, table, col):
    return conn.execute(text(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = :s AND table_name = :t AND column_name = :c"
    ), {"s": schema, "t": table, "c": col}).scalar()


def upgrade() -> None:
    conn = op.get_bind()
    for schema in _schemas(conn):
        if not _has_table(conn, schema, "mensajes"):
            continue
        q = f'"{schema}"'
        conn.execute(text(f"CREATE SEQUENCE IF NOT EXISTS {q}.mensajes_seq_seq"))
        if not _has_column(conn, schema, "mensajes", "seq"):
            conn.execute(text(f"ALTER TABLE {q}.mensajes ADD COLUMN seq BIGINT"))
            # Backfill cronológico (created_at, id) para que el orden histórico
            # quede fijo; después la secuencia sigue desde el máximo.
            conn.execute(text(f"""
                UPDATE {q}.mensajes m SET seq = sub.rn
                FROM (
                    SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
                    FROM {q}.mensajes
                ) sub
                WHERE m.id = sub.id AND m.seq IS NULL
            """))
            conn.execute(text(f"""
                SELECT setval('{schema}.mensajes_seq_seq',
                              COALESCE((SELECT MAX(seq) FROM {q}.mensajes), 0) + 1, false)
            """))
        conn.execute(text(
            f"ALTER TABLE {q}.mensajes ALTER COLUMN seq SET DEFAULT nextval('{schema}.mensajes_seq_seq')"
        ))
        conn.execute(text(f"ALTER TABLE {q}.mensajes ALTER COLUMN seq SET NOT NULL"))
        conn.execute(text(f"ALTER SEQUENCE {q}.mensajes_seq_seq OWNED BY {q}.mensajes.seq"))
        conn.execute(text(
            f"CREATE INDEX IF NOT EXISTS ix_mensajes_conversation_seq ON {q}.mensajes (conversation_id, seq)"
        ))
        conn.execute(text(
            f"ALTER TABLE {q}.mensajes ADD COLUMN IF NOT EXISTS is_sector_note BOOLEAN NOT NULL DEFAULT FALSE"
        ))


def downgrade() -> None:
    conn = op.get_bind()
    for schema in _schemas(conn):
        if not _has_table(conn, schema, "mensajes"):
            continue
        q = f'"{schema}"'
        conn.execute(text(f"DROP INDEX IF EXISTS {q}.ix_mensajes_conversation_seq"))
        conn.execute(text(f"ALTER TABLE {q}.mensajes DROP COLUMN IF EXISTS seq"))
        conn.execute(text(f"DROP SEQUENCE IF EXISTS {q}.mensajes_seq_seq"))
        conn.execute(text(f"ALTER TABLE {q}.mensajes DROP COLUMN IF EXISTS is_sector_note"))
