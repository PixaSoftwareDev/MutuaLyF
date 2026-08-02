"""Hosts aprobados: de allowlist global a aprobación POR TENANT.

Decisión 2026-08-02 (Alejo/Guille): la aprobación de un host habilita el
egreso solo para LA organización que lo pidió — nunca para todas juntas.
Independencia de datos entre tenants: lo que un tenant aprueba o revoca no
puede tocar a otro.

Cambio: public.approved_connector_hosts pasa de PK (host) a PK (tenant_id,
host). Backfill: cada host ya aprobado se replica a los tenants que tienen
algún conector que lo usa en egress_allow (los que nadie usa se descartan —
eran globales, ya no tienen dueño posible).

Revision ID: 051
Revises: 050
"""

from alembic import op
from sqlalchemy import text

revision = "051"
down_revision = "050"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # Idempotencia: si la columna ya existe, la migración ya corrió.
    already = conn.execute(text(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = 'approved_connector_hosts' "
        "AND column_name = 'tenant_id'"
    )).scalar()
    if already:
        return

    conn.execute(text(
        "ALTER TABLE public.approved_connector_hosts ADD COLUMN tenant_id TEXT"
    ))
    # La PK vieja (host sola) TIENE que caer antes del backfill: si sigue viva,
    # la fila global ya ocupa esa clave, el INSERT por tenant choca, el
    # ON CONFLICT DO NOTHING no inserta nada y el DELETE de abajo se lleva
    # puestas TODAS las aprobaciones. Verificado en simulación: 2 filas → 0.
    conn.execute(text(
        "ALTER TABLE public.approved_connector_hosts "
        "DROP CONSTRAINT IF EXISTS approved_connector_hosts_pkey"
    ))
    conn.execute(text(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_approved_hosts_tenant_host "
        "ON public.approved_connector_hosts (tenant_id, host)"
    ))

    # Backfill: replicar cada host global a los tenants cuyos conectores lo usan.
    tenants = [r[0] for r in conn.execute(text("SELECT id FROM public.tenants"))]
    hosts = [dict(r._mapping) for r in conn.execute(text(
        "SELECT host, approved_by, note, created_at "
        "FROM public.approved_connector_hosts WHERE tenant_id IS NULL"
    ))]
    for tenant_id in tenants:
        # Mismo saneo que core/database.py y provision_tenant.py: un tenant con
        # guión vive en tenant_mi_empresa, no en tenant_mi-empresa. Sin esto su
        # schema "no existe", se saltea y pierde sus hosts en silencio.
        schema = f"tenant_{tenant_id.replace('-', '_')}"
        exists = conn.execute(text(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = :s AND table_name = 'tenant_connectors'"
        ), {"s": schema}).scalar()
        if not exists:
            continue
        used: set[str] = set()
        for (egress,) in conn.execute(text(
            f'SELECT egress_allow FROM "{schema}".tenant_connectors'
        )):
            used.update(h.lower() for h in (egress or []))
        for h in hosts:
            if h["host"] in used:
                conn.execute(text(
                    "INSERT INTO public.approved_connector_hosts "
                    "(host, tenant_id, approved_by, note, created_at) "
                    "VALUES (:h, :t, :by, :note, :ts) "
                    "ON CONFLICT (tenant_id, host) DO NOTHING"
                ), {"h": h["host"], "t": tenant_id, "by": h["approved_by"],
                    "note": h["note"], "ts": h["created_at"]})

    # Las filas globales (tenant_id NULL) ya no tienen semántica válida.
    conn.execute(text(
        "DELETE FROM public.approved_connector_hosts WHERE tenant_id IS NULL"
    ))
    conn.execute(text(
        "ALTER TABLE public.approved_connector_hosts "
        "ADD PRIMARY KEY USING INDEX uq_approved_hosts_tenant_host"
    ))


def downgrade() -> None:
    conn = op.get_bind()
    # Volver a global: conservar una fila por host (la más vieja).
    conn.execute(text(
        "DELETE FROM public.approved_connector_hosts a "
        "USING public.approved_connector_hosts b "
        "WHERE a.host = b.host AND a.created_at > b.created_at"
    ))
    conn.execute(text(
        "ALTER TABLE public.approved_connector_hosts "
        "DROP CONSTRAINT IF EXISTS approved_connector_hosts_pkey"
    ))
    conn.execute(text(
        "ALTER TABLE public.approved_connector_hosts DROP COLUMN IF EXISTS tenant_id"
    ))
    conn.execute(text(
        "ALTER TABLE public.approved_connector_hosts ADD PRIMARY KEY (host)"
    ))
