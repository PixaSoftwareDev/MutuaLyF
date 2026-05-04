"""Tenant management endpoints — super-admin panel.

All endpoints require role=super_admin except /widget-token (admin).
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import text

from core.config import settings
from core.database import get_pg_session
from core.security import CurrentUser, create_widget_token, require_super_admin, require_admin
from core.tenant import get_tenant_id
from models.tenant import TenantCreate, TenantResponse, TenantPlan, TenantStatus, WidgetTokenResponse

logger = logging.getLogger(__name__)
router = APIRouter()

PLAN_LIMITS = {
    "starter":      {"users": 5,   "documents": 500,   "queries_month": 5_000,   "max_mb": 10},
    "professional": {"users": 50,  "documents": 10_000, "queries_month": 100_000, "max_mb": 50},
    "enterprise":   {"users": -1,  "documents": -1,    "queries_month": -1,       "max_mb": 200},
}


class TenantUpdate(BaseModel):
    plan:   TenantPlan   | None = None
    status: TenantStatus | None = None
    name:   str | None = None


class TenantDetailResponse(BaseModel):
    id:          str
    name:        str
    plan:        str
    status:      str
    admin_email: str
    created_at:  str
    limits:      dict
    usage_30d:   dict


# ── List all tenants ──────────────────────────────────────────────────────────

@router.get("", response_model=list[dict])
async def list_tenants(
    current_user: CurrentUser = Depends(require_super_admin),
):
    """List all tenants with 30-day usage summary."""
    async with get_pg_session(None) as session:
        result = await session.execute(text("""
            SELECT
                t.id,
                t.name,
                t.plan,
                t.status,
                t.admin_email,
                t.created_at,
                COUNT(ue.id) FILTER (WHERE ue.event_type = 'query'
                    AND ue.created_at >= NOW() - INTERVAL '30 days') AS queries_30d,
                COUNT(ue.id) FILTER (WHERE ue.event_type = 'ingest'
                    AND ue.created_at >= NOW() - INTERVAL '30 days') AS ingests_30d,
                SUM(ue.value) FILTER (WHERE ue.event_type = 'query'
                    AND ue.created_at >= NOW() - INTERVAL '30 days') AS total_queries_30d
            FROM tenants t
            LEFT JOIN usage_events ue ON ue.tenant_id = t.id
            GROUP BY t.id
            ORDER BY t.created_at DESC
        """))
        rows = result.mappings().all()

    return [
        {
            "id":           r["id"],
            "name":         r["name"],
            "plan":         r["plan"],
            "status":       r["status"],
            "admin_email":  r["admin_email"],
            "created_at":   r["created_at"].isoformat() if r["created_at"] else None,
            "limits":       PLAN_LIMITS.get(r["plan"], {}),
            "usage_30d": {
                "queries":  int(r["queries_30d"] or 0),
                "ingests":  int(r["ingests_30d"] or 0),
            },
        }
        for r in rows
    ]


# ── Get single tenant ─────────────────────────────────────────────────────────

@router.get("/{tenant_id}", response_model=dict)
async def get_tenant(
    tenant_id: str,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Get full tenant details + usage breakdown."""
    async with get_pg_session(None) as session:
        result = await session.execute(
            text("SELECT id, name, plan, status, admin_email, created_at FROM tenants WHERE id = :id"),
            {"id": tenant_id},
        )
        row = result.mappings().fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Tenant not found")

    # Usage last 30 days — per event_type
    async with get_pg_session(None) as session:
        usage_result = await session.execute(text("""
            SELECT event_type, SUM(value) AS total
            FROM usage_events
            WHERE tenant_id = :id AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY event_type
        """), {"id": tenant_id})
        usage_rows = usage_result.mappings().all()

    usage = {r["event_type"]: int(r["total"] or 0) for r in usage_rows}

    # Document count from tenant schema
    doc_count = 0
    try:
        safe_id = tenant_id.replace("-", "_")
        async with get_pg_session(tenant_id) as session:
            res = await session.execute(text("SELECT COUNT(*) FROM documentos WHERE status = 'ready'"))
            doc_count = res.scalar() or 0
    except Exception:
        pass

    return {
        "id":          str(row["id"]),
        "name":        row["name"],
        "plan":        row["plan"],
        "status":      row["status"],
        "admin_email": row["admin_email"],
        "created_at":  row["created_at"].isoformat() if row["created_at"] else None,
        "limits":      PLAN_LIMITS.get(row["plan"], {}),
        "usage_30d":   usage,
        "doc_count":   doc_count,
    }


# ── Create tenant (transactional via provision_tenant) ────────────────────────

@router.post("", status_code=status.HTTP_201_CREATED)
async def create_tenant(
    payload: TenantCreate,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Provision a new tenant. Transactional — rolls back all resources on failure."""
    logger.info("tenant_create_start id=%s by=%s", payload.id, current_user.user_id)
    try:
        # Import the battle-tested provisioning script
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path("/app")))
        from provision_tenant import provision_tenant

        await provision_tenant(
            tenant_id=payload.id,
            name=payload.name,
            plan=payload.plan.value,
            admin_email=payload.admin_email,
            admin_name=payload.admin_name,
            admin_password=payload.admin_password,
        )
        logger.info("tenant_create_complete id=%s", payload.id)
        return {
            "id":          payload.id,
            "name":        payload.name,
            "plan":        payload.plan.value,
            "status":      "active",
            "admin_email": payload.admin_email,
        }
    except Exception as exc:
        err = str(exc)
        if "already exists" in err.lower() or "duplicate" in err.lower():
            raise HTTPException(status_code=409, detail=f"Tenant '{payload.id}' already exists")
        logger.error("tenant_create_failed id=%s error=%s", payload.id, exc)
        raise HTTPException(status_code=500, detail=f"Provisioning failed: {err[:200]}")


# ── Update tenant plan / status ───────────────────────────────────────────────

@router.patch("/{tenant_id}")
async def update_tenant(
    tenant_id: str,
    body: TenantUpdate,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Update plan, status or name of a tenant."""
    updates = {k: v.value if hasattr(v, "value") else v
               for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    set_clause = ", ".join(f"{k} = :{k}" for k in updates)
    updates["tenant_id"] = tenant_id

    async with get_pg_session(None) as session:
        result = await session.execute(
            text(f"UPDATE tenants SET {set_clause}, updated_at = NOW() WHERE id = :tenant_id RETURNING id"),
            updates,
        )
        if not result.fetchone():
            raise HTTPException(status_code=404, detail="Tenant not found")

    logger.info("tenant_updated id=%s fields=%s by=%s", tenant_id, list(updates.keys()), current_user.user_id)
    return {"id": tenant_id, "status": "updated", "fields": list(updates.keys())}


# ── Suspend tenant ────────────────────────────────────────────────────────────

@router.post("/{tenant_id}/suspend")
async def suspend_tenant(
    tenant_id: str,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Suspend a tenant — users can no longer log in."""
    async with get_pg_session(None) as session:
        result = await session.execute(
            text("UPDATE tenants SET status = 'suspended', updated_at = NOW() WHERE id = :id RETURNING id"),
            {"id": tenant_id},
        )
        if not result.fetchone():
            raise HTTPException(status_code=404, detail="Tenant not found")
    logger.info("tenant_suspended id=%s by=%s", tenant_id, current_user.user_id)
    return {"id": tenant_id, "status": "suspended"}


@router.post("/{tenant_id}/activate")
async def activate_tenant(
    tenant_id: str,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Re-activate a suspended tenant."""
    async with get_pg_session(None) as session:
        result = await session.execute(
            text("UPDATE tenants SET status = 'active', updated_at = NOW() WHERE id = :id RETURNING id"),
            {"id": tenant_id},
        )
        if not result.fetchone():
            raise HTTPException(status_code=404, detail="Tenant not found")
    logger.info("tenant_activated id=%s by=%s", tenant_id, current_user.user_id)
    return {"id": tenant_id, "status": "active"}


# ── Usage history ─────────────────────────────────────────────────────────────

@router.get("/{tenant_id}/usage")
async def get_tenant_usage(
    tenant_id: str,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Return daily usage breakdown for the last 30 days."""
    async with get_pg_session(None) as session:
        result = await session.execute(text("""
            SELECT
                DATE(created_at) AS day,
                event_type,
                SUM(value) AS total
            FROM usage_events
            WHERE tenant_id = :id AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at), event_type
            ORDER BY day DESC
        """), {"id": tenant_id})
        rows = result.mappings().all()

    return {
        "tenant_id": tenant_id,
        "usage_by_day": [
            {
                "day":        r["day"].isoformat(),
                "event_type": r["event_type"],
                "total":      int(r["total"] or 0),
            }
            for r in rows
        ],
    }


# ── Widget token (admin endpoint — also used from settings page) ──────────────

@router.post("/{tenant_id}/widget-token", response_model=WidgetTokenResponse)
async def generate_widget_token(
    tenant_id: str,
    current_user: CurrentUser = Depends(require_admin),
):
    """Generate a long-lived widget token (90 days) scoped to this tenant."""
    if current_user.role.value != "super_admin" and current_user.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Cannot generate token for another tenant")

    token = create_widget_token(tenant_id)
    logger.info("widget_token_generated tenant_id=%s by=%s", tenant_id, current_user.user_id)
    return WidgetTokenResponse(
        widget_token=token,
        expires_in_days=settings.jwt_widget_expire_days,
        tenant_id=tenant_id,
    )
