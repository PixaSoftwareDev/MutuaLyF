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
import re
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
    identity_kind: str          # 'publico' = abierto · cualquier otro = requiere identidad
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
    auth_validate_path: str | None = None
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


# ── Tool calling: catálogo + resolución por slug (sin pasar por intenciones) ─────
async def list_tools_for_tool_calling(tenant_id: str) -> list[dict]:
    """Todas las tools ACTIVAS de conectores activos del tenant, para armar el
    catálogo de function-calling que se le ofrece al LLM. Sin JOIN a intenciones:
    en modo tool_calling la selección la hace el LLM, no el binding.

    Devuelve por tool: slug, display_name, params_schema, identity_kind, is_read_only.
    """
    async with get_pg_session(tenant_id) as session:
        rows = (await session.execute(text("""
            SELECT t.slug, t.display_name, t.description, t.examples, t.params_schema,
                   t.identity_kind, t.is_read_only
            FROM connector_tools t
            JOIN tenant_connectors c ON c.id = t.connector_id
            WHERE t.is_active AND c.is_active
            ORDER BY t.slug
        """))).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        d["params_schema"] = _as_dict(d.get("params_schema"))
        d["is_read_only"] = bool(d["is_read_only"])
        d["examples"] = list(d.get("examples") or [])
        out.append(d)
    return out


async def get_tool_by_slug(tenant_id: str, tool_slug: str) -> ToolBinding | None:
    """Resuelve una tool activa por su slug (para EJECUTAR lo que eligió el LLM).

    `intent_label` queda como el slug (solo para logging/auditoría) y
    `min_confidence` en 0.0 (en modo tool_calling el gate lo pone el LLM, no un
    umbral de coseno). Fail-closed: None si la tool/connector no están activos.
    """
    if not tool_slug:
        return None

    async with get_pg_session(tenant_id) as session:
        row = (await session.execute(text("""
            SELECT t.id::text          AS tool_id,
                   t.slug              AS tool_slug,
                   t.http_method, t.path_template,
                   t.params_schema, t.response_map,
                   t.identity_kind, t.is_read_only,
                   c.id::text          AS connector_id,
                   c.slug              AS connector_slug,
                   c.base_url, c.egress_allow,
                   c.auth_type, c.auth_secret_ref, c.timeout_ms,
                   c.auth_config, c.auth_secret_enc, c.auth_validate_path
            FROM connector_tools t
            JOIN tenant_connectors c ON c.id = t.connector_id
            WHERE t.slug = :slug AND t.is_active AND c.is_active
            LIMIT 1
        """), {"slug": tool_slug})).mappings().first()

        if row is None:
            return None

        roles = (await session.execute(text("""
            SELECT role FROM connector_roles WHERE tool_id = CAST(:tid AS uuid)
        """), {"tid": row["tool_id"]})).fetchall()

    return ToolBinding(
        tenant_id=tenant_id,
        intent_label=row["tool_slug"],
        min_confidence=0.0,
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
        auth_validate_path=row["auth_validate_path"],
        roles={r[0] for r in roles},
    )


# ═══════════════════════════════════════════════════════════════════════════════
# CRUD para la pantalla de conectores (Fase 1). Todo tenant-scoped vía search_path.
# El secreto NUNCA se lee acá en claro: auth_secret_enc se devuelve como bool
# "has_secret" hacia la UI (write-only). Ver docs/PANTALLA_CONECTORES_PLAN.md.
# ═══════════════════════════════════════════════════════════════════════════════

_CONNECTOR_COLS = ("slug", "display_name", "base_url", "egress_allow",
                   "auth_type", "auth_config", "auth_validate_path", "timeout_ms")
_TOOL_COLS = ("slug", "display_name", "description", "examples", "http_method", "path_template",
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
async def connectors_health(tenant_id: str) -> dict[str, dict]:
    """Salud por conector, derivada de tool_call_audit (últimos 7 días).

    status:
      'ok'      → la última llamada NO fue upstream_error
      'failing' → la última llamada fue upstream_error; failing_since = inicio
                  de la racha actual de fallos (desde el último éxito)
    Conectores sin llamadas registradas no aparecen (el caller muestra "sin datos").
    Cubre el gap del incidente 2026-07-22: un upstream roto (SSL) solo era
    visible grepeando logs — ahora el panel lo muestra.
    """
    async with get_pg_session(tenant_id) as session:
        rows = (await session.execute(text("""
            WITH audit AS (
                SELECT t.connector_id, a.outcome, a.created_at
                FROM tool_call_audit a
                JOIN connector_tools t ON t.id = a.tool_id
                WHERE a.created_at > NOW() - INTERVAL '7 days'
            ),
            agg AS (
                SELECT connector_id,
                       MAX(created_at) FILTER (WHERE outcome <> 'upstream_error') AS last_ok_at
                FROM audit GROUP BY connector_id
            )
            SELECT a.connector_id::text                                          AS connector_id,
                   MAX(a.created_at)                                             AS last_call_at,
                   (ARRAY_AGG(a.outcome ORDER BY a.created_at DESC))[1]          AS last_outcome,
                   g.last_ok_at,
                   MIN(a.created_at) FILTER (
                       WHERE a.outcome = 'upstream_error'
                         AND (g.last_ok_at IS NULL OR a.created_at > g.last_ok_at)
                   )                                                             AS failing_since,
                   COUNT(*) FILTER (WHERE a.created_at > NOW() - INTERVAL '24 hours')::int AS calls_24h,
                   COUNT(*) FILTER (WHERE a.outcome = 'upstream_error'
                                      AND a.created_at > NOW() - INTERVAL '24 hours')::int AS errors_24h
            FROM audit a JOIN agg g USING (connector_id)
            GROUP BY a.connector_id, g.last_ok_at
        """))).mappings().all()

    out: dict[str, dict] = {}
    for r in rows:
        failing = r["last_outcome"] == "upstream_error"
        out[r["connector_id"]] = {
            "status": "failing" if failing else "ok",
            "last_call_at": r["last_call_at"].isoformat(),
            "last_ok_at": r["last_ok_at"].isoformat() if r["last_ok_at"] else None,
            "failing_since": r["failing_since"].isoformat() if failing and r["failing_since"] else None,
            "calls_24h": int(r["calls_24h"]),
            "errors_24h": int(r["errors_24h"]),
        }
    return out


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
            SELECT t.id::text, t.slug, t.display_name, t.description, t.examples,
                   t.http_method, t.path_template,
                   t.params_schema, t.response_map, t.identity_kind, t.is_read_only, t.is_active,
                   t.last_test_ok, to_char(t.last_test_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_test_at, t.last_test_detail,
                   ARRAY(SELECT role FROM connector_roles r WHERE r.tool_id = t.id) AS roles
            FROM connector_tools t WHERE t.connector_id = CAST(:cid AS uuid)
            ORDER BY t.display_name
        """), {"cid": connector_id})).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        d["params_schema"] = _as_dict(d.get("params_schema"))
        d["response_map"] = _as_dict(d.get("response_map"))
        d["examples"] = list(d.get("examples") or [])
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


# ── Data flywheel: candidatos a ejemplo por operación ───────────────────────────
def _norm_query(q: str) -> str:
    """Normaliza para dedup: minúsculas, espacios colapsados, sin signos al borde."""
    return re.sub(r"\s+", " ", (q or "").strip().lower()).strip(" ?!.¿¡")


async def record_example_candidate(tenant_id: str, tool_id: str, query: str) -> None:
    """Registra una consulta real que ruteó OK a esta tool como candidato a ejemplo.
    Upsert por (tool_id, query_norm): si ya existe, suma hit y refresca last_seen.
    Best-effort: el flywheel nunca rompe una consulta."""
    norm = _norm_query(query)
    if len(norm) < 8:
        return  # muy corta para ser un ejemplo útil
    try:
        async with get_pg_session(tenant_id) as session:
            await session.execute(text(
                "INSERT INTO tool_example_candidates (tool_id, query, query_norm) "
                "VALUES (CAST(:tid AS uuid), :q, :qn) "
                "ON CONFLICT (tool_id, query_norm) DO UPDATE SET "
                "hits = tool_example_candidates.hits + 1, last_seen_at = NOW()"
            ), {"tid": tool_id, "q": query.strip()[:200], "qn": norm})
            await session.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("example_candidate_failed tool=%s error=%s", tool_id, exc)


async def list_example_candidates(tenant_id: str, tool_id: str, limit: int = 15) -> list[dict]:
    """Candidatos PENDIENTES de una tool, más frecuentes primero."""
    async with get_pg_session(tenant_id) as session:
        rows = (await session.execute(text(
            "SELECT id::text, query, hits, "
            "to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS last_seen_at "
            "FROM tool_example_candidates "
            "WHERE tool_id = CAST(:tid AS uuid) AND status = 'pending' "
            "ORDER BY hits DESC, last_seen_at DESC LIMIT :lim"
        ), {"tid": tool_id, "lim": limit})).mappings().all()
    return [dict(r) for r in rows]


async def approve_example_candidate(tenant_id: str, candidate_id: str) -> str | None:
    """Mueve un candidato a connector_tools.examples y lo borra. Devuelve la query
    aprobada, o None si no existía / ya estaba en los ejemplos."""
    async with get_pg_session(tenant_id) as session:
        row = (await session.execute(text(
            "SELECT tool_id::text, query FROM tool_example_candidates WHERE id = CAST(:id AS uuid)"
        ), {"id": candidate_id})).mappings().first()
        if row is None:
            return None
        cur = (await session.execute(text(
            "SELECT examples FROM connector_tools WHERE id = CAST(:tid AS uuid)"
        ), {"tid": row["tool_id"]})).scalar()
        examples = list(cur or [])
        if row["query"] not in examples:
            examples = (examples + [row["query"]])[:20]
            await session.execute(text(
                "UPDATE connector_tools SET examples = :ex WHERE id = CAST(:tid AS uuid)"
            ), {"ex": examples, "tid": row["tool_id"]})
        await session.execute(text(
            "DELETE FROM tool_example_candidates WHERE id = CAST(:id AS uuid)"
        ), {"id": candidate_id})
        await session.commit()
    return row["query"]


async def dismiss_example_candidate(tenant_id: str, candidate_id: str) -> bool:
    """Descarta un candidato (status='dismissed'): no se vuelve a sugerir."""
    async with get_pg_session(tenant_id) as session:
        res = await session.execute(text(
            "UPDATE tool_example_candidates SET status = 'dismissed' WHERE id = CAST(:id AS uuid)"
        ), {"id": candidate_id})
        await session.commit()
    return res.rowcount > 0


async def record_tool_test(tenant_id: str, tool_id: str, ok: bool, detail: str | None) -> None:
    """Persiste el resultado del último dry-run de la operación (manual o masivo).
    Best-effort: la prueba ya corrió y su resultado se devuelve igual — acá solo
    se guarda el estado para que la lista lo muestre (verde/rojo/gris)."""
    async with get_pg_session(tenant_id) as session:
        await session.execute(text(
            "UPDATE connector_tools SET last_test_ok = :ok, last_test_at = NOW(), "
            "last_test_detail = :detail WHERE id = CAST(:id AS uuid)"
        ), {"ok": ok, "detail": (detail or "")[:300] or None, "id": tool_id})
        await session.commit()


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
async def list_connector_users(tenant_id: str, connector_id: str) -> list[dict]:
    async with get_pg_session(tenant_id) as session:
        rows = (await session.execute(text("""
            SELECT id::text, documento, email, nombre, is_active, created_at
            FROM connector_users WHERE connector_id = CAST(:cid AS uuid)
            ORDER BY nombre
        """), {"cid": connector_id})).mappings().all()
    return [dict(r) for r in rows]


async def create_connector_user(tenant_id: str, connector_id: str, data: dict) -> str:
    async with get_pg_session(tenant_id) as session:
        uid = (await session.execute(text("""
            INSERT INTO connector_users (connector_id, documento, email, nombre, is_active)
            VALUES (CAST(:cid AS uuid), :documento, :email, :nombre, :is_active)
            RETURNING id::text
        """), {"cid": connector_id, "documento": data["documento"], "email": data["email"],
               "nombre": data["nombre"], "is_active": data.get("is_active", True)})).scalar()
        await session.commit()
    return uid


async def update_connector_user(tenant_id: str, user_id: str, data: dict) -> bool:
    cols = [c for c in ("documento", "email", "nombre", "is_active") if c in data]
    if not cols:
        return False
    params = {c: data[c] for c in cols}
    params["id"] = user_id
    set_sql = ", ".join(f"{c} = :{c}" for c in cols)
    async with get_pg_session(tenant_id) as session:
        res = await session.execute(text(
            f"UPDATE connector_users SET {set_sql}, updated_at = NOW() WHERE id = CAST(:id AS uuid)"
        ), params)
        await session.commit()
    return res.rowcount > 0


async def delete_connector_user(tenant_id: str, user_id: str) -> bool:
    async with get_pg_session(tenant_id) as session:
        res = await session.execute(text(
            "DELETE FROM connector_users WHERE id = CAST(:id AS uuid)"
        ), {"id": user_id})
        await session.commit()
    return res.rowcount > 0


async def get_connector_user_by_documento(tenant_id: str, connector_id: str, documento: str) -> dict | None:
    """Resuelve el usuario ACTIVO por (connector_id, documento). None si no existe
    o está inactivo. Base del login platform_registry: de acá sale el email del OTP."""
    if not documento:
        return None
    async with get_pg_session(tenant_id) as session:
        row = (await session.execute(text("""
            SELECT id::text, documento, email, nombre
            FROM connector_users
            WHERE connector_id = CAST(:cid AS uuid) AND documento = :doc AND is_active
            LIMIT 1
        """), {"cid": connector_id, "doc": documento})).mappings().first()
    return dict(row) if row else None


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


# Acciones de auditoría que cambian QUÉ puede consultar un conector — son las
# que el super-admin quiere ver en el feed de cambios (película, no solo foto).
_CONNECTOR_CHANGE_ACTIONS = (
    "connector_created", "connector_updated", "connector_deleted",
    "connector_active_changed", "connector_proposal_applied",
    "connector_tool_created", "connector_tool_updated", "connector_tool_deleted",
)


async def recent_connector_changes(tenant_id: str, days: int = 30, limit: int = 30) -> list[dict]:
    """Cambios de configuración de conectores de UN tenant (para el feed global)."""
    async with get_pg_session(tenant_id) as session:
        rows = (await session.execute(text(
            "SELECT action, resource, actor_email, detail, created_at "
            "FROM audit_log WHERE action = ANY(:acts) "
            "AND created_at > NOW() - make_interval(days => :days) "
            "ORDER BY created_at DESC LIMIT :lim"
        ), {"acts": list(_CONNECTOR_CHANGE_ACTIONS), "days": days, "lim": limit})).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        d["detail"] = _as_dict(d.get("detail"))
        out.append(d)
    return out


async def list_tenant_ids() -> list[dict]:
    """Tenants activos de la plataforma (id + nombre) para vistas cross-tenant."""
    async with get_pg_session() as session:
        rows = (await session.execute(text(
            "SELECT id, name FROM public.tenants ORDER BY id"
        ))).mappings().all()
    return [dict(r) for r in rows]


async def upsert_activation_request(tenant_id: str, connector_id: str,
                                    hosts: list[str], requested_by: str | None) -> None:
    """Registra (o refresca) la solicitud de activación bloqueada por hosts sin
    aprobar. Una viva por (tenant, conector)."""
    async with get_pg_session() as session:
        await session.execute(text(
            "INSERT INTO public.connector_activation_requests "
            "(tenant_id, connector_id, hosts, requested_by) "
            "VALUES (:t, :c, :h, :by) "
            "ON CONFLICT (tenant_id, connector_id) DO UPDATE SET "
            "hosts = EXCLUDED.hosts, requested_by = EXCLUDED.requested_by, created_at = NOW()"
        ), {"t": tenant_id, "c": connector_id, "h": hosts, "by": requested_by})
        await session.commit()


async def list_activation_request_ids(tenant_id: str) -> set[str]:
    """Ids de conectores del tenant con solicitud de activación viva (para el
    flag pending_approval de los GET del panel del tenant)."""
    async with get_pg_session() as session:
        rows = (await session.execute(text(
            "SELECT connector_id FROM public.connector_activation_requests "
            "WHERE tenant_id = :t"
        ), {"t": tenant_id})).fetchall()
    return {r[0] for r in rows}


async def list_activation_requests() -> list[dict]:
    async with get_pg_session() as session:
        rows = (await session.execute(text(
            "SELECT r.tenant_id, r.connector_id, r.hosts, r.requested_by, r.created_at, "
            "       t.name AS tenant_name "
            "FROM public.connector_activation_requests r "
            "LEFT JOIN public.tenants t ON t.id = r.tenant_id "
            "ORDER BY r.created_at DESC"
        ))).mappings().all()
    return [dict(r) for r in rows]


async def delete_activation_request(tenant_id: str, connector_id: str) -> None:
    async with get_pg_session() as session:
        await session.execute(text(
            "DELETE FROM public.connector_activation_requests "
            "WHERE tenant_id = :t AND connector_id = :c"
        ), {"t": tenant_id, "c": connector_id})
        await session.commit()


async def remove_approved_host(host: str) -> bool:
    async with get_pg_session() as session:
        res = await session.execute(text(
            "DELETE FROM public.approved_connector_hosts WHERE host = :h"
        ), {"h": host})
        await session.commit()
    return res.rowcount > 0
