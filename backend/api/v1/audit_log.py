"""Audit log endpoint — admin only."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text

from core.database import get_pg_session
from core.security import CurrentUser, require_admin
from core.tenant import get_tenant_id

router = APIRouter()


@router.get("/audit")
async def list_audit_events(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    action: str | None = None,
    tenant_id: str = Depends(get_tenant_id),
    _: CurrentUser = Depends(require_admin),
):
    """Return paginated audit log for the current tenant."""
    where = "WHERE 1=1"
    params: dict = {"limit": limit, "offset": offset}
    if action:
        where += " AND action = :action"
        params["action"] = action

    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text(
                f"SELECT id, actor_id, actor_email, actor_role, action, resource, detail, ip_address, created_at "
                f"FROM audit_log {where} ORDER BY created_at DESC LIMIT :limit OFFSET :offset"
            ),
            params,
        )
        rows = result.mappings().all()

        count_result = await session.execute(
            text(f"SELECT COUNT(*) FROM audit_log {where}"),
            {k: v for k, v in params.items() if k not in ("limit", "offset")},
        )
        total = count_result.scalar() or 0

    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "events": [
            {
                "id": str(r["id"]),
                "actor_id": r["actor_id"],
                "actor_email": r["actor_email"],
                "actor_role": r["actor_role"],
                "action": r["action"],
                "resource": r["resource"],
                "detail": r["detail"],
                "ip_address": r["ip_address"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in rows
        ],
    }
