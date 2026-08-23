"""Persistir la señal del trust gate en consultas_log (por tenant).

Hasta ahora el veredicto del gate (respondió/rechazó, cobertura léxica,
scores, si actuó el juez y su motivo) vivía SOLO en los logs del contenedor,
que rotan: medir "% de consultas rechazadas esta semana" o listar los huecos
de conocimiento requería arqueología de logs (F2a del plan de calidad lo
pedía desde julio; el 2026-08-18 hubo que buscar los "no encontré" a mano).

Columnas nuevas en consultas_log de CADA schema de tenant:
  trust_action    'answer' | 'refuse' | NULL (gate apagado/cacheada/small talk)
  trust_lex       cobertura léxica 0-1
  trust_best_cos  mejor score coseno del retrieval
  trust_best_rrf  mejor score RRF
  trust_judge     si actuó el juez LLM
  trust_reason    motivo (lexical_pass / judge_keep=N: ... / judge_refuse: ...)

Idempotente (ADD COLUMN IF NOT EXISTS) y por tenant: los schemas nuevos ya
nacen con las columnas vía el template de provisión cuando corresponda.

Revision ID: 055
Revises: 051 (lo común a main/dev/dev-local — las 052-054 son de conectores y viven solo en dev-local)
"""

from alembic import op
from sqlalchemy import text

revision = "055"
down_revision = "051"
branch_labels = None
depends_on = None

_COLUMNS = [
    ("trust_action", "TEXT"),
    ("trust_lex", "REAL"),
    ("trust_best_cos", "REAL"),
    ("trust_best_rrf", "REAL"),
    ("trust_judge", "BOOLEAN"),
    ("trust_reason", "TEXT"),
]


def upgrade() -> None:
    conn = op.get_bind()
    schemas = [r[0] for r in conn.execute(text(
        "SELECT schema_name FROM information_schema.schemata "
        "WHERE schema_name LIKE 'tenant_%'"
    ))]
    for schema in schemas:
        exists = conn.execute(text(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = :s AND table_name = 'consultas_log'"
        ), {"s": schema}).scalar()
        if not exists:
            continue
        for col, tipo in _COLUMNS:
            conn.execute(text(
                f'ALTER TABLE "{schema}".consultas_log '
                f"ADD COLUMN IF NOT EXISTS {col} {tipo}"
            ))


def downgrade() -> None:
    conn = op.get_bind()
    schemas = [r[0] for r in conn.execute(text(
        "SELECT schema_name FROM information_schema.schemata "
        "WHERE schema_name LIKE 'tenant_%'"
    ))]
    for schema in schemas:
        for col, _ in _COLUMNS:
            conn.execute(text(
                f'ALTER TABLE "{schema}".consultas_log DROP COLUMN IF EXISTS {col}'
            ))
