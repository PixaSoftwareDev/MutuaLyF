"""Audit log endpoints — tenant admin + super_admin global view."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text

from core.database import get_pg_session
from core.security import CurrentUser, require_admin, require_super_admin
from core.tenant import get_tenant_id

router = APIRouter()


@router.get("/audit")
async def list_audit_events(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    action: str | None = None,
    date_from: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    date_to: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    tenant_id: str = Depends(get_tenant_id),
    _: CurrentUser = Depends(require_admin),
):
    """Return paginated audit log for the current tenant."""
    where = "WHERE 1=1"
    params: dict = {"limit": limit, "offset": offset}
    if action:
        where += " AND action = :action"
        params["action"] = action
    if date_from:
        where += " AND created_at >= CAST(:date_from AS date)"
        params["date_from"] = date_from
    if date_to:
        # < dia siguiente: incluye el dia "hasta" completo (created_at es timestamptz)
        where += " AND created_at < CAST(:date_to AS date) + INTERVAL '1 day'"
        params["date_to"] = date_to

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


@router.get("/superadmin/audit")
async def global_audit_log(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    action: str | None = None,
    tenant_filter: str | None = None,
    date_from: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    date_to: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    _: CurrentUser = Depends(require_super_admin),
):
    """Global audit log across all tenants — super_admin only."""
    async with get_pg_session(None) as session:
        tenants_result = await session.execute(
            text("SELECT id FROM tenants WHERE status != 'suspended' ORDER BY id")
        )
        tenant_ids = [r[0] for r in tenants_result.fetchall()]

    if tenant_filter:
        tenant_ids = [t for t in tenant_ids if t == tenant_filter]

    all_events: list[dict] = []
    for tid in tenant_ids:
        try:
            where = "WHERE 1=1"
            params: dict = {}
            if action:
                where += " AND action = :action"
                params["action"] = action
            if date_from:
                where += " AND created_at >= CAST(:date_from AS date)"
                params["date_from"] = date_from
            if date_to:
                where += " AND created_at < CAST(:date_to AS date) + INTERVAL '1 day'"
                params["date_to"] = date_to
            async with get_pg_session(tid) as session:
                result = await session.execute(
                    text(
                        # Mitigación: se traen hasta 2000 eventos por tenant y se paginan
                        # en memoria. Para tenants con muchísima auditoría, los más viejos
                        # del rango podrían no entrar y el `total` queda topeado — el fix
                        # completo es paginar en SQL (UNION entre schemas). Suficiente para
                        # el volumen actual.
                        f"SELECT id, actor_id, actor_email, actor_role, action, resource, detail, ip_address, created_at "
                        f"FROM audit_log {where} ORDER BY created_at DESC LIMIT 2000"
                    ),
                    params,
                )
                for r in result.mappings().all():
                    all_events.append({
                        "tenant_id": tid,
                        "id": str(r["id"]),
                        "actor_id": r["actor_id"],
                        "actor_email": r["actor_email"],
                        "actor_role": r["actor_role"],
                        "action": r["action"],
                        "resource": r["resource"],
                        "detail": r["detail"],
                        "ip_address": r["ip_address"],
                        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                    })
        except Exception:
            pass  # tenant schema may not have audit_log yet — skip silently

    all_events.sort(key=lambda e: e["created_at"] or "", reverse=True)
    total = len(all_events)
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "tenants": tenant_ids,
        "events": all_events[offset: offset + limit],
    }
