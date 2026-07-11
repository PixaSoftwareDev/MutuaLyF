"""Lectura de la config de conectores (tablas de la migración 031).

El executor y el router son genéricos: no saben de "NEXA". Toda la especificidad
—qué ruta, qué auth, qué rol, qué intención dispara— sale de estas tablas. Este
módulo resuelve, dada una intención clasificada, la tool a invocar con todo su
contexto.

Notas de asyncpg (landmines conocidos del proyecto):
- Los UUID vuelven como objetos UUID → str() en el borde.
- JSONB puede volver como str (asyncpg no auto-decodifica) → json.loads defensivo.
- TEXT[] vuelve como list de Python.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from sqlalchemy import text

from core.database import get_pg_session

logger = logging.getLogger(__name__)


@dataclass
class ToolBinding:
    """Todo lo necesario para invocar una tool disparada por una intención."""
    tenant_id: str
    intent_label: str
    min_confidence: float
    tool_id: str
    tool_slug: str
    http_method: str
    path_template: str
    params_schema: dict
    response_map: dict
    identity_kind: str          # 'afiliado' | 'profesional'
    is_read_only: bool
    connector_id: str
    connector_slug: str
    base_url: str
    egress_allow: list[str]
    auth_type: str
    auth_secret_ref: str | None
    timeout_ms: int
    roles: set[str] = field(default_factory=set)


def _as_dict(value) -> dict:
    """JSONB robusto: asyncpg puede devolver dict o str."""
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return {}


async def get_tool_for_intent(tenant_id: str, intent_label: str) -> ToolBinding | None:
    """Resuelve la tool activa disparada por `intent_label`, o None.

    Devuelve None si: no hay binding, o el binding/tool/connector están inactivos
    (fail-closed: nada se invoca sin config explícitamente activa).
    """
    if not intent_label:
        return None

    async with get_pg_session(tenant_id) as session:
        row = (await session.execute(text("""
            SELECT b.min_confidence,
                   t.id::text          AS tool_id,
                   t.slug              AS tool_slug,
                   t.http_method, t.path_template,
                   t.params_schema, t.response_map,
                   t.identity_kind, t.is_read_only,
                   c.id::text          AS connector_id,
                   c.slug              AS connector_slug,
                   c.base_url, c.egress_allow,
                   c.auth_type, c.auth_secret_ref, c.timeout_ms
            FROM connector_intent_bindings b
            JOIN intenciones i        ON i.id = b.intencion_id
            JOIN connector_tools t     ON t.id = b.tool_id
            JOIN tenant_connectors c   ON c.id = t.connector_id
            WHERE i.label = :label
              AND b.is_active AND t.is_active AND c.is_active
            ORDER BY b.min_confidence ASC
            LIMIT 1
        """), {"label": intent_label})).mappings().first()

        if row is None:
            return None

        roles = (await session.execute(text("""
            SELECT role FROM connector_roles WHERE tool_id = CAST(:tid AS uuid)
        """), {"tid": row["tool_id"]})).fetchall()

    return ToolBinding(
        tenant_id=tenant_id,
        intent_label=intent_label,
        min_confidence=float(row["min_confidence"]),
        tool_id=row["tool_id"],
        tool_slug=row["tool_slug"],
        http_method=row["http_method"],
        path_template=row["path_template"],
        params_schema=_as_dict(row["params_schema"]),
        response_map=_as_dict(row["response_map"]),
        identity_kind=row["identity_kind"],
        is_read_only=bool(row["is_read_only"]),
        connector_id=row["connector_id"],
        connector_slug=row["connector_slug"],
        base_url=row["base_url"],
        egress_allow=list(row["egress_allow"] or []),
        auth_type=row["auth_type"],
        auth_secret_ref=row["auth_secret_ref"],
        timeout_ms=int(row["timeout_ms"]),
        roles={r[0] for r in roles},
    )
