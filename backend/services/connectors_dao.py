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
    auth_config: dict = field(default_factory=dict)
    auth_secret_enc: str | None = None
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
                   c.auth_type, c.auth_secret_ref, c.timeout_ms,
                   c.auth_config, c.auth_secret_enc
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
        auth_config=_as_dict(row["auth_config"]),
        auth_secret_enc=row["auth_secret_enc"],
        roles={r[0] for r in roles},
    )


# ═══════════════════════════════════════════════════════════════════════════════
# CRUD para la pantalla de conectores (Fase 1). Todo tenant-scoped vía search_path.
# El secreto NUNCA se lee acá en claro: auth_secret_enc se devuelve como bool
# "has_secret" hacia la UI (write-only). Ver docs/PANTALLA_CONECTORES_PLAN.md.
# ═══════════════════════════════════════════════════════════════════════════════

_CONNECTOR_COLS = ("slug", "display_name", "base_url", "egress_allow",
                   "auth_type", "auth_config", "auth_validate_path", "timeout_ms")
_TOOL_COLS = ("slug", "display_name", "http_method", "path_template",
              "params_schema", "response_map", "identity_kind", "is_read_only")
_JSONB_COLS = {"auth_config", "params_schema", "response_map"}


def _bind_value(col: str, value):
    """Prepara un valor para bind param: JSONB → json.dumps + cast; el resto directo."""
    if col in _JSONB_COLS:
        return json.dumps(value if value is not None else {})
    return value


def _placeholder(col: str) -> str:
    return f"CAST(:{col} AS jsonb)" if col in _JSONB_COLS else f":{col}"


# ── Conectores ─────────────────────────────────────────────────────────────────
async def list_connectors(tenant_id: str) -> list[dict]:
    async with get_pg_session(tenant_id) as session:
        rows = (await session.execute(text("""
            SELECT c.id::text, c.slug, c.display_name, c.base_url, c.egress_allow,
                   c.auth_type, c.auth_validate_path, c.is_active, c.timeout_ms,
                   (c.auth_secret_enc IS NOT NULL) AS has_secret,
                   (SELECT COUNT(*) FROM connector_tools t WHERE t.connector_id = c.id) AS tool_count
            FROM tenant_connectors c ORDER BY c.display_name
        """))).mappings().all()
    return [dict(r) for r in rows]


async def get_connector(tenant_id: str, connector_id: str) -> dict | None:
    async with get_pg_session(tenant_id) as session:
        row = (await session.execute(text("""
            SELECT c.id::text, c.slug, c.display_name, c.base_url, c.egress_allow,
                   c.auth_type, c.auth_config, c.auth_validate_path, c.is_active, c.timeout_ms,
                   (c.auth_secret_enc IS NOT NULL) AS has_secret
            FROM tenant_connectors c WHERE c.id = CAST(:id AS uuid)
        """), {"id": connector_id})).mappings().first()
    if row is None:
        return None
    out = dict(row)
    out["auth_config"] = _as_dict(out.get("auth_config"))
    out["egress_allow"] = list(out.get("egress_allow") or [])
    return out


async def create_connector(tenant_id: str, data: dict) -> str:
    cols = [c for c in _CONNECTOR_COLS if c in data]
    params = {c: _bind_value(c, data[c]) for c in cols}
    col_sql = ", ".join(cols)
    val_sql = ", ".join(_placeholder(c) for c in cols)
    async with get_pg_session(tenant_id) as session:
        cid = (await session.execute(text(
            f"INSERT INTO tenant_connectors ({col_sql}) VALUES ({val_sql}) RETURNING id::text"
        ), params)).scalar()
        await session.commit()
    return cid


async def update_connector(tenant_id: str, connector_id: str, data: dict) -> bool:
    cols = [c for c in _CONNECTOR_COLS if c in data]
    if not cols:
        return False
    params = {c: _bind_value(c, data[c]) for c in cols}
    params["id"] = connector_id
    set_sql = ", ".join(f"{c} = {_placeholder(c)}" for c in cols)
    async with get_pg_session(tenant_id) as session:
        res = await session.execute(text(
            f"UPDATE tenant_connectors SET {set_sql}, updated_at = NOW() WHERE id = CAST(:id AS uuid)"
        ), params)
        await session.commit()
    return res.rowcount > 0


async def set_connector_secret(tenant_id: str, connector_id: str, secret_enc: str | None) -> None:
    async with get_pg_session(tenant_id) as session:
        await session.execute(text(
            "UPDATE tenant_connectors SET auth_secret_enc = :enc, updated_at = NOW() "
            "WHERE id = CAST(:id AS uuid)"
        ), {"enc": secret_enc, "id": connector_id})
        await session.commit()


async def get_connector_secret_enc(tenant_id: str, connector_id: str) -> str | None:
    """Devuelve el ciphertext (para el executor / test). No exponer por la API."""
    async with get_pg_session(tenant_id) as session:
        return (await session.execute(text(
            "SELECT auth_secret_enc FROM tenant_connectors WHERE id = CAST(:id AS uuid)"
        ), {"id": connector_id})).scalar()


async def set_connector_active(tenant_id: str, connector_id: str, active: bool) -> bool:
    async with get_pg_session(tenant_id) as session:
        res = await session.execute(text(
            "UPDATE tenant_connectors SET is_active = :a, updated_at = NOW() WHERE id = CAST(:id AS uuid)"
        ), {"a": active, "id": connector_id})
        await session.commit()
    return res.rowcount > 0


async def delete_connector(tenant_id: str, connector_id: str) -> bool:
    async with get_pg_session(tenant_id) as session:
        res = await session.execute(text(
            "DELETE FROM tenant_connectors WHERE id = CAST(:id AS uuid)"
        ), {"id": connector_id})
        await session.commit()
    return res.rowcount > 0


# ── Tools ──────────────────────────────────────────────────────────────────────
async def list_tools(tenant_id: str, connector_id: str) -> list[dict]:
    async with get_pg_session(tenant_id) as session:
        rows = (await session.execute(text("""
            SELECT t.id::text, t.slug, t.display_name, t.http_method, t.path_template,
                   t.params_schema, t.response_map, t.identity_kind, t.is_read_only, t.is_active,
                   ARRAY(SELECT role FROM connector_roles r WHERE r.tool_id = t.id) AS roles
            FROM connector_tools t WHERE t.connector_id = CAST(:cid AS uuid)
            ORDER BY t.display_name
        """), {"cid": connector_id})).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        d["params_schema"] = _as_dict(d.get("params_schema"))
        d["response_map"] = _as_dict(d.get("response_map"))
        d["roles"] = list(d.get("roles") or [])
        out.append(d)
    return out


async def create_tool(tenant_id: str, connector_id: str, data: dict) -> str:
    cols = [c for c in _TOOL_COLS if c in data]
    params = {c: _bind_value(c, data[c]) for c in cols}
    params["cid"] = connector_id
    col_sql = ", ".join(["connector_id", *cols])
    val_sql = ", ".join(["CAST(:cid AS uuid)", *[_placeholder(c) for c in cols]])
    async with get_pg_session(tenant_id) as session:
        tid = (await session.execute(text(
            f"INSERT INTO connector_tools ({col_sql}) VALUES ({val_sql}) RETURNING id::text"
        ), params)).scalar()
        await session.commit()
    return tid


async def update_tool(tenant_id: str, tool_id: str, data: dict) -> bool:
    cols = [c for c in (*_TOOL_COLS, "is_active") if c in data]
    if not cols:
        return False
    params = {c: _bind_value(c, data[c]) for c in cols}
    params["id"] = tool_id
    set_sql = ", ".join(f"{c} = {_placeholder(c)}" for c in cols)
    async with get_pg_session(tenant_id) as session:
        res = await session.execute(text(
            f"UPDATE connector_tools SET {set_sql} WHERE id = CAST(:id AS uuid)"
        ), params)
        await session.commit()
    return res.rowcount > 0


async def delete_tool(tenant_id: str, tool_id: str) -> bool:
    async with get_pg_session(tenant_id) as session:
        res = await session.execute(text(
            "DELETE FROM connector_tools WHERE id = CAST(:id AS uuid)"
        ), {"id": tool_id})
        await session.commit()
    return res.rowcount > 0


async def set_tool_roles(tenant_id: str, tool_id: str, roles: list[str]) -> None:
    """Reemplaza el conjunto de roles de una tool (delete + insert)."""
    async with get_pg_session(tenant_id) as session:
        await session.execute(text(
            "DELETE FROM connector_roles WHERE tool_id = CAST(:tid AS uuid)"
        ), {"tid": tool_id})
        for role in {r for r in roles if r}:
            await session.execute(text(
                "INSERT INTO connector_roles (tool_id, role) VALUES (CAST(:tid AS uuid), :role) "
                "ON CONFLICT (tool_id, role) DO NOTHING"
            ), {"tid": tool_id, "role": role})
        await session.commit()


# ── Bindings intención → tool ────────────────────────────────────────────────────
async def list_bindings(tenant_id: str, tool_id: str) -> list[dict]:
    async with get_pg_session(tenant_id) as session:
        rows = (await session.execute(text("""
            SELECT b.id::text, b.intencion_id::text, i.label AS intent_label,
                   b.min_confidence, b.is_active
            FROM connector_intent_bindings b
            JOIN intenciones i ON i.id = b.intencion_id
            WHERE b.tool_id = CAST(:tid AS uuid) ORDER BY i.label
        """), {"tid": tool_id})).mappings().all()
    return [dict(r) for r in rows]


async def upsert_binding(tenant_id: str, tool_id: str, intencion_id: str,
                         min_confidence: float, is_active: bool) -> str:
    async with get_pg_session(tenant_id) as session:
        bid = (await session.execute(text("""
            INSERT INTO connector_intent_bindings (intencion_id, tool_id, min_confidence, is_active)
            VALUES (CAST(:iid AS uuid), CAST(:tid AS uuid), :conf, :active)
            ON CONFLICT (intencion_id, tool_id)
            DO UPDATE SET min_confidence = EXCLUDED.min_confidence, is_active = EXCLUDED.is_active
            RETURNING id::text
        """), {"iid": intencion_id, "tid": tool_id, "conf": min_confidence, "active": is_active})).scalar()
        await session.commit()
    return bid


async def delete_binding(tenant_id: str, binding_id: str) -> bool:
    async with get_pg_session(tenant_id) as session:
        res = await session.execute(text(
            "DELETE FROM connector_intent_bindings WHERE id = CAST(:id AS uuid)"
        ), {"id": binding_id})
        await session.commit()
    return res.rowcount > 0


# ── Allowlist global de hosts aprobados (decisión D2, schema public) ─────────────
async def is_host_approved(host: str) -> bool:
    async with get_pg_session() as session:
        return (await session.execute(text(
            "SELECT 1 FROM public.approved_connector_hosts WHERE host = :h"
        ), {"h": host})).scalar() is not None


async def list_approved_hosts() -> list[dict]:
    async with get_pg_session() as session:
        rows = (await session.execute(text(
            "SELECT host, approved_by, note, created_at FROM public.approved_connector_hosts ORDER BY host"
        ))).mappings().all()
    return [dict(r) for r in rows]


async def approve_host(host: str, approved_by: str | None, note: str | None = None) -> None:
    async with get_pg_session() as session:
        await session.execute(text(
            "INSERT INTO public.approved_connector_hosts (host, approved_by, note) "
            "VALUES (:h, :by, :note) ON CONFLICT (host) DO UPDATE SET approved_by = EXCLUDED.approved_by"
        ), {"h": host, "by": approved_by, "note": note})
        await session.commit()


async def remove_approved_host(host: str) -> bool:
    async with get_pg_session() as session:
        res = await session.execute(text(
            "DELETE FROM public.approved_connector_hosts WHERE host = :h"
        ), {"h": host})
        await session.commit()
    return res.rowcount > 0
