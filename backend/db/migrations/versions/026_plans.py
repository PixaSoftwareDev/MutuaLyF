"""Planes configurables: tabla `public.plans`.

Mueve los planes de hardcodeados (PLAN_LIMITS en código) a una tabla editable
desde el super-admin. Se siembra con los MISMOS valores que el código tenía, así
el comportamiento no cambia para ningún tenant existente.

El enforcement (core/plan_limits.py) lee de esta tabla pero conserva el dict
hardcodeado como fallback: si la tabla falla o no tiene el plan, usa los valores
de siempre. Por eso esta migración es puramente aditiva y segura.

Idempotente (IF NOT EXISTS / ON CONFLICT DO NOTHING) — prod y staging comparten
base. Sobre una base que ya tenga la tabla es un no-op.

Revision ID: 026
Revises: 025
"""

from alembic import op
from sqlalchemy import text

revision = "026"
down_revision = "025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # -1 = ilimitado (mismo convenio que el dict PLAN_LIMITS del código).
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS public.plans (
            id             TEXT PRIMARY KEY,
            name           TEXT    NOT NULL,
            users          INTEGER NOT NULL DEFAULT -1,
            documents      INTEGER NOT NULL DEFAULT -1,
            queries_month  INTEGER NOT NULL DEFAULT -1,
            max_mb         INTEGER NOT NULL DEFAULT 200,
            price_usd      NUMERIC(10, 2),
            is_active      BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order     INTEGER NOT NULL DEFAULT 0,
            created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """))

    # Seed con los valores EXACTOS de PLAN_LIMITS — sin pisar si ya existen.
    conn.execute(text("""
        INSERT INTO public.plans (id, name, users, documents, queries_month, max_mb, sort_order) VALUES
            ('starter',      'Starter',      5,   500,    5000,    10,  0),
            ('professional', 'Professional', 50,  10000,  100000,  50,  1),
            ('enterprise',   'Enterprise',  -1,  -1,     -1,       200, 2)
        ON CONFLICT (id) DO NOTHING
    """))


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(text("DROP TABLE IF EXISTS public.plans"))
