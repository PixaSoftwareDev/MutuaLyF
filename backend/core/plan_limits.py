"""Plan limit enforcement — shared by ingest and query endpoints.

Limits defined here are the single source of truth. tenants.py PLAN_LIMITS is
for reporting only — this module is for enforcement.
"""
import logging
from fastapi import HTTPException, status
from sqlalchemy import text

logger = logging.getLogger(__name__)

PLAN_LIMITS: dict[str, dict] = {
    "starter":      {"documents": 500,    "queries_month": 5_000,   "max_mb": 10},
    "professional": {"documents": 10_000, "queries_month": 100_000, "max_mb": 50},
    "enterprise":   {"documents": -1,     "queries_month": -1,      "max_mb": 200},
}


async def _get_tenant_plan(tenant_id: str) -> str:
    from core.database import get_pg_session
    try:
        async with get_pg_session(None) as session:
            row = await session.execute(
                text("SELECT plan FROM tenants WHERE id = :id AND status = 'active'"),
                {"id": tenant_id},
            )
            result = row.scalar_one_or_none()
            return result or "starter"
    except Exception as exc:
        logger.warning("plan_limit_plan_lookup_failed tenant_id=%s error=%s — defaulting to starter", tenant_id, exc)
        return "starter"


async def enforce_document_limit(tenant_id: str, file_size_bytes: int) -> None:
    """Raise HTTP 402 if the tenant has reached their document or file size limit."""
    from core.database import get_pg_session

    from core.plans import get_plan_limits
    plan = await _get_tenant_plan(tenant_id)
    limits = await get_plan_limits(plan)

    # File size check
    max_bytes = limits["max_mb"] * 1024 * 1024
    if file_size_bytes > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"El archivo supera el límite del plan {plan} ({limits['max_mb']} MB). "
                   f"Tamaño recibido: {file_size_bytes / 1024 / 1024:.1f} MB.",
        )

    # Document count check (-1 = unlimited)
    doc_limit = limits["documents"]
    if doc_limit == -1:
        return

    try:
        async with get_pg_session(tenant_id) as session:
            row = await session.execute(
                text("SELECT COUNT(*) FROM documentos WHERE status != 'failed'")
            )
            doc_count = row.scalar_one() or 0
    except Exception as exc:
        logger.warning("plan_limit_doc_count_failed tenant_id=%s error=%s — skipping check", tenant_id, exc)
        return

    if doc_count >= doc_limit:
        logger.warning(
            "plan_limit_doc_reached tenant_id=%s plan=%s count=%d limit=%d",
            tenant_id, plan, doc_count, doc_limit,
        )
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=f"Límite de documentos del plan {plan} alcanzado ({doc_count}/{doc_limit}). "
                   "Actualizá tu plan para subir más documentos.",
        )

    # Warn at 90% so the admin has time to react
    if doc_count >= doc_limit * 0.9:
        logger.warning(
            "plan_limit_doc_near_quota tenant_id=%s plan=%s count=%d limit=%d pct=%.0f%%",
            tenant_id, plan, doc_count, doc_limit, doc_count / doc_limit * 100,
        )


async def enforce_query_limit(tenant_id: str) -> None:
    """Raise HTTP 429 if the tenant has exceeded their monthly query quota."""
    from core.database import get_pg_session

    from core.plans import get_plan_limits
    plan = await _get_tenant_plan(tenant_id)
    limits = await get_plan_limits(plan)

    query_limit = limits["queries_month"]
    if query_limit == -1:
        return

    try:
        async with get_pg_session(None) as session:
            row = await session.execute(
                text("""
                    SELECT COALESCE(SUM(value), 0)
                    FROM usage_events
                    WHERE tenant_id = :tid
                      AND event_type = 'query'
                      AND created_at >= date_trunc('month', NOW())
                """),
                {"tid": tenant_id},
            )
            queries_this_month = row.scalar_one() or 0
    except Exception as exc:
        logger.warning("plan_limit_query_count_failed tenant_id=%s error=%s — skipping check", tenant_id, exc)
        return

    if queries_this_month >= query_limit:
        logger.warning(
            "plan_limit_query_reached tenant_id=%s plan=%s used=%d limit=%d",
            tenant_id, plan, queries_this_month, query_limit,
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Límite mensual de consultas del plan {plan} alcanzado "
                   f"({queries_this_month:,}/{query_limit:,}). "
                   "Actualizá tu plan o esperá al próximo mes.",
        )
