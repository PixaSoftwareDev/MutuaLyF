"""Audit log helpers. Fire-and-forget — never blocks the request."""

import asyncio
import json
import logging
from typing import Any, Awaitable

from fastapi import Request
from sqlalchemy import text

from core.database import get_pg_session

logger = logging.getLogger(__name__)


def fire_and_log(coro: Awaitable[Any], context: str = "") -> asyncio.Task:
    """Lanza una corutina fire-and-forget pero logueando cualquier excepcion.

    Reemplazo defensivo de `asyncio.ensure_future(...)` directo. Sin esto,
    si la corutina falla (Redis caido, PG caido, error en el handler), la
    excepcion se pierde silenciosamente y en produccion no hay traza.

    Uso:
        fire_and_log(audit(...), "auth.login")
        fire_and_log(publish(tenant, "evt", {...}), "publish:handoff_accept")

    Devuelve el Task por si el caller quiere encadenar algo (raro).
    """
    task = asyncio.ensure_future(coro)

    def _done(t: asyncio.Task) -> None:
        if t.cancelled():
            return
        exc = t.exception()
        if exc is not None:
            logger.warning(
                "fire_and_log_failed context=%s error=%s: %s",
                context or "<unspecified>",
                type(exc).__name__,
                exc,
            )

    task.add_done_callback(_done)
    return task


async def record(
    *,
    tenant_id: str,
    actor_id: str,
    actor_email: str | None,
    actor_role: str,
    action: str,
    resource: str | None = None,
    detail: dict[str, Any] | None = None,
    request: Request | None = None,
) -> None:
    """Insert an audit event into the tenant's audit_log table.

    Failures are logged but never re-raised so they can't impact the caller.
    """
    ip = None
    if request is not None:
        forwarded = request.headers.get("X-Forwarded-For")
        ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else None)

    detail_json = json.dumps(detail) if detail else None

    # Super-admin audit goes to a lightweight log entry — no tenant schema
    if tenant_id == "__platform__":
        logger.info("platform_audit action=%s actor=%s ip=%s", action, actor_id, ip)
        return

    try:
        async with get_pg_session(tenant_id) as session:
            await session.execute(
                text(
                    "INSERT INTO audit_log (actor_id, actor_email, actor_role, action, resource, detail, ip_address) "
                    "VALUES (:actor_id, :actor_email, :actor_role, :action, :resource, CAST(:detail AS jsonb), :ip)"
                ),
                {
                    "actor_id": actor_id,
                    "actor_email": actor_email,
                    "actor_role": actor_role,
                    "action": action,
                    "resource": resource,
                    "detail": detail_json,
                    "ip": ip,
                },
            )
    except Exception as exc:
        logger.warning("audit_record_failed action=%s tenant=%s error=%s", action, tenant_id, exc)
