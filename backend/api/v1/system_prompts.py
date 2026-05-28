"""System prompt templates — super_admin CRUD + tenant assignment + admin activation."""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text

from core.database import get_pg_session, get_redis_cache
from core.security import CurrentUser, require_admin, require_super_admin
from core.tenant import get_tenant_id

logger = logging.getLogger(__name__)
router = APIRouter()

PLANS = Literal["starter", "professional", "enterprise"]
PLAN_ORDER = {"starter": 0, "professional": 1, "enterprise": 2}
MAX_PROMPT_LENGTH = 4000  # ~3000 tokens

# ── Schemas ───────────────────────────────────────────────────────────────────

class TemplateCreate(BaseModel):
    nombre: str = Field(..., min_length=2, max_length=100)
    descripcion: str | None = Field(None, max_length=500)
    contenido: str = Field(..., min_length=10, max_length=MAX_PROMPT_LENGTH)
    categoria: str = "general"
    plan_minimo: str = "starter"

    @field_validator("contenido")
    @classmethod
    def sanitize_content(cls, v: str) -> str:
        # Strip null bytes and control chars (allow newlines/tabs)
        return "".join(c for c in v if c.isprintable() or c in ("\n", "\t"))

    @field_validator("plan_minimo")
    @classmethod
    def valid_plan(cls, v: str) -> str:
        if v not in PLAN_ORDER:
            raise ValueError(f"plan_minimo must be one of {list(PLAN_ORDER)}")
        return v


class TemplateUpdate(BaseModel):
    nombre: str | None = Field(None, min_length=2, max_length=100)
    descripcion: str | None = Field(None, max_length=500)
    contenido: str | None = Field(None, min_length=10, max_length=MAX_PROMPT_LENGTH)
    categoria: str | None = None
    plan_minimo: str | None = None
    is_active: bool | None = None

    @field_validator("contenido")
    @classmethod
    def sanitize_content(cls, v: str | None) -> str | None:
        if v is None:
            return v
        return "".join(c for c in v if c.isprintable() or c in ("\n", "\t"))


class AssignRequest(BaseModel):
    tenant_ids: list[str] = Field(..., min_length=1)


# ── Helpers ───────────────────────────────────────────────────────────────────

async def auto_assign_system_templates(tenant_id: str) -> None:
    """Assign system infrastructure + Asistente estándar to a newly created tenant."""
    async with get_pg_session(None) as session:
        # System infrastructure (is_system=TRUE) + Asistente estándar (is_system=FALSE, created_by=system)
        result = await session.execute(text("""
            SELECT id FROM system_prompt_templates
            WHERE is_active = TRUE AND (is_system = TRUE OR created_by = 'system')
        """))
        auto_ids = [str(r[0]) for r in result.fetchall()]

        for tmpl_id in auto_ids:
            await session.execute(text("""
                INSERT INTO tenant_prompt_assignments (tenant_id, template_id, assigned_by, is_active)
                VALUES (:tid, :tmpl, 'system',
                    -- Activate Asistente estándar by default
                    (SELECT nombre = 'Asistente estándar' FROM system_prompt_templates WHERE id = :tmpl)
                )
                ON CONFLICT (tenant_id, template_id) DO NOTHING
            """), {"tid": tenant_id, "tmpl": tmpl_id})

    logger.info("system_templates_auto_assigned tenant=%s count=%d", tenant_id, len(auto_ids))


async def _invalidate_tenant_cache(tenant_id: str) -> None:
    """Evict active-template and bot-config caches so next query picks up changes."""
    redis = get_redis_cache()
    try:
        await redis.delete(f"{tenant_id}:active_template", f"{tenant_id}:bot_config")
    except Exception as exc:
        logger.warning("cache_invalidate_failed tenant_id=%s error=%s", tenant_id, exc)


def _fmt(row: dict) -> dict:
    return {
        "id": str(row["id"]),
        "nombre": row["nombre"],
        "descripcion": row["descripcion"],
        "categoria": row["categoria"],
        "plan_minimo": row["plan_minimo"],
        "is_active": row["is_active"],
        "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
        "updated_at": row["updated_at"].isoformat() if row.get("updated_at") else None,
        # contenido is intentionally omitted from list views — returned only on detail
    }


# ═══════════════════════════════════════════════════════════════════════════════
# SUPER ADMIN — template management
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/superadmin/prompt-categories")
async def list_categories(
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Return all distinct categories in use across non-system templates, sorted."""
    async with get_pg_session(None) as session:
        result = await session.execute(text(
            "SELECT DISTINCT categoria FROM system_prompt_templates WHERE is_active = TRUE AND is_system = FALSE ORDER BY categoria"
        ))
        cats = [r[0] for r in result.fetchall()]
    return {"categories": cats}


@router.get("/superadmin/system-components")
async def list_system_components(
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Return the 3 system templates (read-only, always active)."""
    async with get_pg_session(None) as session:
        result = await session.execute(text("""
            SELECT id, nombre, descripcion, categoria, contenido, updated_at
            FROM system_prompt_templates
            WHERE is_system = TRUE
            ORDER BY nombre ASC
        """))
        rows = result.mappings().all()
    return [
        {
            "id":          str(r["id"]),
            "nombre":      r["nombre"],
            "descripcion": r["descripcion"],
            "categoria":   r["categoria"],
            "contenido":   r["contenido"],
            "updated_at":  r["updated_at"].isoformat() if r["updated_at"] else None,
        }
        for r in rows
    ]


@router.get("/superadmin/prompt-templates")
async def list_templates(
    current_user: CurrentUser = Depends(require_super_admin),
):
    """List all prompt templates with assignment counts."""
    async with get_pg_session(None) as session:
        result = await session.execute(text("""
            SELECT t.id, t.nombre, t.descripcion, t.categoria, t.plan_minimo,
                   t.is_active, t.created_at, t.updated_at,
                   COUNT(a.id) AS assigned_count,
                   COUNT(a.id) FILTER (WHERE a.is_active) AS active_count
            FROM system_prompt_templates t
            LEFT JOIN tenant_prompt_assignments a ON a.template_id = t.id
            WHERE t.is_system = FALSE AND t.is_active = TRUE
            GROUP BY t.id
            ORDER BY t.created_at DESC
        """))
        rows = result.mappings().all()

    return [
        {**_fmt(dict(r)), "assigned_count": r["assigned_count"], "active_count": r["active_count"]}
        for r in rows
    ]


@router.get("/superadmin/prompt-templates/{template_id}")
async def get_template(
    template_id: str,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Get full template including prompt content and tenant assignments."""
    async with get_pg_session(None) as session:
        result = await session.execute(
            text("SELECT * FROM system_prompt_templates WHERE id = :id"),
            {"id": template_id},
        )
        row = result.mappings().fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Template no encontrado")

        assignments = await session.execute(text("""
            SELECT a.id, a.tenant_id, a.is_active, a.assigned_at, t.name AS tenant_name
            FROM tenant_prompt_assignments a
            JOIN tenants t ON t.id = a.tenant_id
            WHERE a.template_id = :tid
            ORDER BY a.assigned_at DESC
        """), {"tid": template_id})

    return {
        **_fmt(dict(row)),
        "contenido": row["contenido"],
        "assignments": [
            {
                "id": str(a["id"]),
                "tenant_id": a["tenant_id"],
                "tenant_name": a["tenant_name"],
                "is_active": a["is_active"],
                "assigned_at": a["assigned_at"].isoformat() if a["assigned_at"] else None,
            }
            for a in assignments.mappings().all()
        ],
    }


@router.post("/superadmin/prompt-templates", status_code=status.HTTP_201_CREATED)
async def create_template(
    body: TemplateCreate,
    current_user: CurrentUser = Depends(require_super_admin),
):
    async with get_pg_session(None) as session:
        result = await session.execute(text("""
            INSERT INTO system_prompt_templates
                (nombre, descripcion, contenido, categoria, plan_minimo, created_by)
            VALUES (:nombre, :desc, :contenido, :categoria, :plan_minimo, :created_by)
            RETURNING id, nombre, descripcion, categoria, plan_minimo, is_active, created_at, updated_at
        """), {
            "nombre": body.nombre,
            "desc": body.descripcion,
            "contenido": body.contenido,
            "categoria": body.categoria,
            "plan_minimo": body.plan_minimo,
            "created_by": current_user.user_id,
        })
        row = result.mappings().fetchone()

    logger.info("prompt_template_created id=%s by=%s", row["id"], current_user.user_id)
    return {**_fmt(dict(row)), "contenido": body.contenido}


@router.patch("/superadmin/prompt-templates/{template_id}")
async def update_template(
    template_id: str,
    body: TemplateUpdate,
    current_user: CurrentUser = Depends(require_super_admin),
):
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No hay campos para actualizar")

    set_parts = [f"{k} = :{k}" for k in updates] + ["updated_at = NOW()"]
    updates["template_id"] = template_id

    async with get_pg_session(None) as session:
        # Validate placeholders before writing — fetch current nombre/categoria if not in body
        result = await session.execute(
            text(f"UPDATE system_prompt_templates SET {', '.join(set_parts)} WHERE id = :template_id RETURNING id"),
            updates,
        )
        if not result.fetchone():
            raise HTTPException(status_code=404, detail="Template no encontrado")

        if "contenido" in updates or "is_active" in updates:
            # Invalidate tenant caches for assigned templates
            active = await session.execute(text("""
                SELECT tenant_id FROM tenant_prompt_assignments
                WHERE template_id = :tid AND is_active = TRUE
            """), {"tid": template_id})
            for a in active.mappings().all():
                await _invalidate_tenant_cache(a["tenant_id"])

            # Invalidate system template cache for calidad/intenciones templates
            sys_tmpl = await session.execute(text("""
                SELECT nombre, categoria FROM system_prompt_templates
                WHERE id = :id AND is_system = TRUE
            """), {"id": template_id})
            sys_row = sys_tmpl.mappings().fetchone()
            if sys_row:
                redis = get_redis_cache()
                try:
                    await redis.delete(f"platform:system_template:{sys_row['nombre']}")
                except Exception:
                    pass

    return {"id": template_id, "updated": True}


@router.delete("/superadmin/prompt-templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(
    template_id: str,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Hard-delete: removes template and all its assignments."""
    async with get_pg_session(None) as session:
        # Collect tenants to invalidate before deleting
        active = await session.execute(text("""
            SELECT tenant_id FROM tenant_prompt_assignments
            WHERE template_id = :tid
        """), {"tid": template_id})
        affected_tenants = [r["tenant_id"] for r in active.mappings().all()]

        await session.execute(text("""
            DELETE FROM tenant_prompt_assignments WHERE template_id = :id
        """), {"id": template_id})
        await session.execute(text("""
            DELETE FROM system_prompt_templates WHERE id = :id AND is_system = FALSE
        """), {"id": template_id})

    for tid in affected_tenants:
        await _invalidate_tenant_cache(tid)


@router.post("/superadmin/prompt-templates/{template_id}/assign")
async def assign_to_tenants(
    template_id: str,
    body: AssignRequest,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Assign a template to one or more tenants. Respects max_prompt_templates per tenant."""
    errors: list[dict] = []
    assigned: list[str] = []

    async with get_pg_session(None) as session:
        # Verify template exists and is active
        tpl = await session.execute(
            text("SELECT plan_minimo FROM system_prompt_templates WHERE id = :id AND is_active = TRUE"),
            {"id": template_id},
        )
        tpl_row = tpl.mappings().fetchone()
        if not tpl_row:
            raise HTTPException(status_code=404, detail="Template no encontrado o inactivo")

        for tenant_id in body.tenant_ids:
            tenant = await session.execute(
                text("SELECT plan, max_prompt_templates FROM tenants WHERE id = :id"),
                {"id": tenant_id},
            )
            t = tenant.mappings().fetchone()
            if not t:
                errors.append({"tenant_id": tenant_id, "error": "Tenant no encontrado"})
                continue

            # Plan compatibility check
            if PLAN_ORDER.get(t["plan"], 0) < PLAN_ORDER.get(tpl_row["plan_minimo"], 0):
                errors.append({
                    "tenant_id": tenant_id,
                    "error": f"Plan {t['plan']} no permite este template (requiere {tpl_row['plan_minimo']})",
                })
                continue

            # Capacity check — system templates don't count against the quota
            count = await session.execute(text("""
                SELECT COUNT(*) FROM tenant_prompt_assignments a
                JOIN system_prompt_templates t ON t.id = a.template_id
                WHERE a.tenant_id = :tid AND t.is_system = FALSE
            """), {"tid": tenant_id})
            current_count = count.scalar() or 0
            if current_count >= t["max_prompt_templates"]:
                errors.append({
                    "tenant_id": tenant_id,
                    "error": f"Límite alcanzado ({t['max_prompt_templates']} templates)",
                })
                continue

            await session.execute(text("""
                INSERT INTO tenant_prompt_assignments (tenant_id, template_id, assigned_by)
                VALUES (:tid, :tmpl, :by)
                ON CONFLICT (tenant_id, template_id) DO NOTHING
            """), {"tid": tenant_id, "tmpl": template_id, "by": current_user.user_id})
            assigned.append(tenant_id)

    logger.info("templates_assigned template=%s tenants=%s by=%s", template_id, assigned, current_user.user_id)
    return {"assigned": assigned, "errors": errors}


@router.delete("/superadmin/tenants/{tenant_id}/prompt-assignments/{template_id}",
               status_code=status.HTTP_204_NO_CONTENT)
async def unassign_from_tenant(
    tenant_id: str,
    template_id: str,
    current_user: CurrentUser = Depends(require_super_admin),
):
    async with get_pg_session(None) as session:
        result = await session.execute(text("""
            DELETE FROM tenant_prompt_assignments
            WHERE tenant_id = :tid AND template_id = :tmpl
            RETURNING is_active
        """), {"tid": tenant_id, "tmpl": template_id})
        row = result.fetchone()
        if row and row[0]:  # was active → invalidate cache
            await _invalidate_tenant_cache(tenant_id)


@router.get("/superadmin/tenants/{tenant_id}/bots")
async def list_tenant_bots(
    tenant_id: str,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """List all templates assigned to a specific tenant, with is_active status."""
    async with get_pg_session(None) as session:
        result = await session.execute(text("""
            SELECT t.id, t.nombre, t.descripcion, t.categoria, t.plan_minimo,
                   a.is_active, a.assigned_at
            FROM tenant_prompt_assignments a
            JOIN system_prompt_templates t ON t.id = a.template_id
            WHERE a.tenant_id = :tid AND t.is_active = TRUE AND t.is_system = FALSE
            ORDER BY a.is_active DESC, t.nombre ASC
        """), {"tid": tenant_id})
        rows = result.mappings().all()

    return {
        "bots": [
            {
                "id": str(r["id"]),
                "nombre": r["nombre"],
                "descripcion": r["descripcion"],
                "categoria": r["categoria"],
                "is_active": r["is_active"],
                "assigned_at": r["assigned_at"].isoformat() if r["assigned_at"] else None,
            }
            for r in rows
        ]
    }


@router.post("/superadmin/tenants/{tenant_id}/bots/{template_id}/activate")
async def superadmin_activate_tenant_bot(
    tenant_id: str,
    template_id: str,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Activate a specific bot for a tenant (atomic swap). Super admin can do this directly."""
    async with get_pg_session(None) as session:
        check = await session.execute(text("""
            SELECT a.id FROM tenant_prompt_assignments a
            JOIN system_prompt_templates t ON t.id = a.template_id
            WHERE a.tenant_id = :tid AND a.template_id = :tmpl AND t.is_active = TRUE
        """), {"tid": tenant_id, "tmpl": template_id})
        if not check.fetchone():
            raise HTTPException(status_code=404, detail="Template no asignado a este tenant")

        await session.execute(text("""
            UPDATE tenant_prompt_assignments SET is_active = FALSE WHERE tenant_id = :tid
        """), {"tid": tenant_id})
        await session.execute(text("""
            UPDATE tenant_prompt_assignments
            SET is_active = TRUE WHERE tenant_id = :tid AND template_id = :tmpl
        """), {"tid": tenant_id, "tmpl": template_id})

    await _invalidate_tenant_cache(tenant_id)
    logger.info("superadmin_bot_activated template=%s tenant=%s by=%s", template_id, tenant_id, current_user.user_id)
    return {"template_id": template_id, "is_active": True}


@router.delete("/superadmin/tenants/{tenant_id}/bots/active", status_code=200)
async def superadmin_deactivate_tenant_bot(
    tenant_id: str,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Deactivate any active bot for a tenant. Tenant reverts to default prompt."""
    async with get_pg_session(None) as session:
        await session.execute(text("""
            UPDATE tenant_prompt_assignments SET is_active = FALSE WHERE tenant_id = :tid
        """), {"tid": tenant_id})

    await _invalidate_tenant_cache(tenant_id)
    logger.info("superadmin_bot_deactivated tenant=%s by=%s", tenant_id, current_user.user_id)
    return {"is_active": False}


@router.patch("/superadmin/tenants/{tenant_id}/max-templates")
async def set_tenant_max_templates(
    tenant_id: str,
    body: dict,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Override max_prompt_templates for a specific tenant (e.g. gifting extra slots)."""
    max_val = body.get("max_prompt_templates")
    if not isinstance(max_val, int) or max_val < 0:
        raise HTTPException(status_code=400, detail="max_prompt_templates must be a non-negative integer")

    async with get_pg_session(None) as session:
        result = await session.execute(
            text("UPDATE tenants SET max_prompt_templates = :m WHERE id = :id RETURNING id"),
            {"m": max_val, "id": tenant_id},
        )
        if not result.fetchone():
            raise HTTPException(status_code=404, detail="Tenant no encontrado")

    return {"tenant_id": tenant_id, "max_prompt_templates": max_val}


# ═══════════════════════════════════════════════════════════════════════════════
# ADMIN — read assigned templates + activate/deactivate
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/admin/prompt-templates")
async def list_assigned_templates(
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """List templates assigned to this tenant. Content hidden from admin."""
    async with get_pg_session(None) as session:
        result = await session.execute(text("""
            SELECT t.id, t.nombre, t.descripcion, t.categoria, t.plan_minimo,
                   a.is_active, a.assigned_at, a.id AS assignment_id
            FROM tenant_prompt_assignments a
            JOIN system_prompt_templates t ON t.id = a.template_id
            WHERE a.tenant_id = :tid AND t.is_active = TRUE AND t.is_system = FALSE
            ORDER BY a.is_active DESC, t.nombre ASC
        """), {"tid": tenant_id})
        rows = result.mappings().all()

        # Tenant limits
        limits = await session.execute(
            text("SELECT max_prompt_templates FROM tenants WHERE id = :tid"),
            {"tid": tenant_id},
        )
        limit_row = limits.mappings().fetchone()

    return {
        "max_prompt_templates": limit_row["max_prompt_templates"] if limit_row else 1,
        "templates": [
            {
                "id": str(r["id"]),
                "assignment_id": str(r["assignment_id"]),
                "nombre": r["nombre"],
                "descripcion": r["descripcion"],
                "categoria": r["categoria"],
                "is_active": r["is_active"],
                "assigned_at": r["assigned_at"].isoformat() if r["assigned_at"] else None,
            }
            for r in rows
        ],
    }


@router.post("/admin/prompt-templates/{template_id}/activate", status_code=200)
async def activate_template(
    template_id: str,
    request: Request,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Activate a template for this tenant. Deactivates the previous one atomically."""
    async with get_pg_session(None) as session:
        # Verify this template is assigned to this tenant
        check = await session.execute(text("""
            SELECT a.id FROM tenant_prompt_assignments a
            JOIN system_prompt_templates t ON t.id = a.template_id
            WHERE a.tenant_id = :tid AND a.template_id = :tmpl AND t.is_active = TRUE
        """), {"tid": tenant_id, "tmpl": template_id})
        if not check.fetchone():
            raise HTTPException(status_code=404, detail="Template no asignado a este tenant")

        # Atomic swap: deactivate all → activate the chosen one
        await session.execute(text("""
            UPDATE tenant_prompt_assignments SET is_active = FALSE WHERE tenant_id = :tid
        """), {"tid": tenant_id})
        await session.execute(text("""
            UPDATE tenant_prompt_assignments
            SET is_active = TRUE
            WHERE tenant_id = :tid AND template_id = :tmpl
        """), {"tid": tenant_id, "tmpl": template_id})

    await _invalidate_tenant_cache(tenant_id)

    import asyncio
    from core.audit import record as audit
    asyncio.ensure_future(audit(
        tenant_id=tenant_id, actor_id=current_user.user_id, actor_email=current_user.email,
        actor_role=current_user.role.value, action="bot.template_activated",
        resource=template_id, request=request,
    ))

    logger.info("template_activated template=%s tenant=%s by=%s", template_id, tenant_id, current_user.user_id)
    return {"template_id": template_id, "is_active": True}


@router.post("/admin/prompt-templates/deactivate", status_code=200)
async def deactivate_all_templates(
    request: Request,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Deactivate all templates — tenant reverts to default system prompt."""
    async with get_pg_session(None) as session:
        await session.execute(text("""
            UPDATE tenant_prompt_assignments SET is_active = FALSE WHERE tenant_id = :tid
        """), {"tid": tenant_id})

    await _invalidate_tenant_cache(tenant_id)

    import asyncio
    from core.audit import record as audit
    asyncio.ensure_future(audit(
        tenant_id=tenant_id, actor_id=current_user.user_id, actor_email=current_user.email,
        actor_role=current_user.role.value, action="bot.template_deactivated",
        request=request,
    ))

    return {"is_active": False, "using_default": True}
