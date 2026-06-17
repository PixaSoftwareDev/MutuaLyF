"""Tenant management endpoints — super-admin panel.

All endpoints require role=super_admin except /widget-token (admin).
"""

import hashlib
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, EmailStr, Field, validator
from sqlalchemy import text

import time

from core.config import settings
from core.database import get_pg_session, get_redis_cache
from core.prometheus import get_system_metrics
from core.security import CurrentUser, create_widget_token, require_super_admin, require_admin, require_admin_or_super
from models.tenant import TenantCreate, TenantPlan, TenantStatus, WidgetTokenResponse

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
                    AND ue.created_at >= NOW() - INTERVAL '30 days') AS total_queries_30d,
                COUNT(ue.id) FILTER (WHERE ue.event_type = 'query'
                    AND ue.created_at >= date_trunc('month', NOW())) AS queries_this_month
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
            # Consumo del MES en curso (lo que realmente cuenta para la cuota mensual).
            "queries_this_month": int(r["queries_this_month"] or 0),
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

        # Auto-assign system infrastructure templates
        from api.v1.system_prompts import auto_assign_system_templates, _invalidate_tenant_cache
        await auto_assign_system_templates(payload.id)

        # Assign and activate the chosen personality
        async with get_pg_session(None) as session:
            tpl = await session.execute(
                text("SELECT id, plan_minimo FROM system_prompt_templates WHERE id = :id AND is_active = TRUE AND is_system = FALSE"),
                {"id": payload.personality_id},
            )
            tpl_row = tpl.mappings().fetchone()
            if not tpl_row:
                raise HTTPException(status_code=422, detail="La personalidad seleccionada no existe o está inactiva")

            from api.v1.system_prompts import PLAN_ORDER
            tenant_plan = payload.plan.value
            if PLAN_ORDER.get(tenant_plan, 0) < PLAN_ORDER.get(tpl_row["plan_minimo"], 0):
                raise HTTPException(
                    status_code=422,
                    detail=f"El plan {tenant_plan} no permite la personalidad seleccionada (requiere {tpl_row['plan_minimo']})",
                )

            await session.execute(text("""
                INSERT INTO tenant_prompt_assignments (tenant_id, template_id, assigned_by, is_active)
                VALUES (:tid, :tmpl, 'system', TRUE)
                ON CONFLICT (tenant_id, template_id) DO UPDATE SET is_active = TRUE
            """), {"tid": payload.id, "tmpl": payload.personality_id})

        await _invalidate_tenant_cache(payload.id)
        logger.info("tenant_create_complete id=%s personality=%s", payload.id, payload.personality_id)
        return {
            "id":          payload.id,
            "name":        payload.name,
            "plan":        payload.plan.value,
            "status":      "active",
            "admin_email": payload.admin_email,
        }
    except HTTPException:
        raise
    except Exception as exc:
        err = str(exc)
        # Distinguish PG duplicate (tenant truly exists) from Qdrant orphan mismatch
        if ("already exists" in err.lower() or "duplicate" in err.lower()) and "qdrant" not in err.lower() and "collection" not in err.lower():
            raise HTTPException(status_code=409, detail=f"Tenant '{payload.id}' ya existe")
        logger.error("tenant_create_failed id=%s error=%s", payload.id, exc)
        # No filtrar el stack trace/infra al usuario — el detalle ya quedó en logs.
        raise HTTPException(status_code=500, detail="No se pudo crear la organización. Revisá los datos e intentá de nuevo.")


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


# ── Reset tenant onboarding ───────────────────────────────────────────────────

@router.post("/{tenant_id}/reset-onboarding")
async def reset_tenant_onboarding(
    tenant_id: str,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Reset a tenant to onboarding state: clears bot config, sectors, and cache."""
    async with get_pg_session(None) as session:
        result = await session.execute(
            text("SELECT id FROM tenants WHERE id = :id"),
            {"id": tenant_id},
        )
        if not result.fetchone():
            raise HTTPException(status_code=404, detail="Tenant not found")

        await session.execute(text("""
            UPDATE tenants
            SET onboarding_completed = false,
                bot_name = null,
                bot_description = null,
                bot_scope = null,
                greeting_message = null,
                updated_at = NOW()
            WHERE id = :id
        """), {"id": tenant_id})

    async with get_pg_session(tenant_id) as session:
        await session.execute(text("DELETE FROM conversaciones"))
        # NO borrar el sector default: el DELETE total cascadea operador_sectores y deja
        # a los operadores invisibles para el handoff. Borramos solo los no-default,
        # garantizamos un default activo, y reasignamos los operadores a él.
        await session.execute(text("DELETE FROM sectores WHERE is_default = FALSE"))
        await session.execute(text("""
            INSERT INTO sectores (nombre, descripcion, is_default, is_active)
            VALUES ('Consultas Generales', 'Sector por defecto', TRUE, TRUE)
            ON CONFLICT (nombre) DO UPDATE SET is_active = TRUE, is_default = TRUE
        """))
        await session.execute(text("""
            INSERT INTO operador_sectores (operador_id, sector_id)
            SELECT u.id, s.id FROM usuarios u
            CROSS JOIN (SELECT id FROM sectores WHERE is_default = TRUE LIMIT 1) s
            WHERE u.role = 'operator' AND u.is_active = TRUE
            ON CONFLICT DO NOTHING
        """))

    redis = get_redis_cache()
    try:
        await redis.delete(
            f"{tenant_id}:bot_config",
            f"{tenant_id}:active_template",
        )
    except Exception:
        pass

    logger.info("tenant_onboarding_reset id=%s by=%s", tenant_id, current_user.user_id)
    return {"id": tenant_id, "reset": True}


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
    # Invalidar cache de status para que JWTs vigentes empiecen a fallar al
    # instante en lugar de esperar el TTL de 60s. Sin esto, una cuenta
    # comprometida tenia hasta 60s + 60min de uso del JWT actual.
    from core.security import invalidate_tenant_status_cache_sync
    invalidate_tenant_status_cache_sync(tenant_id)
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
    from core.security import invalidate_tenant_status_cache_sync
    invalidate_tenant_status_cache_sync(tenant_id)
    logger.info("tenant_activated id=%s by=%s", tenant_id, current_user.user_id)
    return {"id": tenant_id, "status": "active"}


# ── Email domains (email-first login) ─────────────────────────────────────────

import re as _re_dom
_DOMAIN_RE = _re_dom.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")


class EmailDomainBody(BaseModel):
    domain:     str  = Field(..., max_length=253)
    is_primary: bool = False


@router.get("/{tenant_id}/email-domains")
async def list_email_domains(
    tenant_id: str,
    _: CurrentUser = Depends(require_admin_or_super),
):
    """Lista los dominios de email asociados a un tenant.

    Admin del propio tenant puede ver los suyos; super-admin puede ver
    cualquiera. La validacion de "su propio tenant" se hace abajo.
    """
    async with get_pg_session(None) as session:
        result = await session.execute(
            text(
                "SELECT domain, is_primary, created_at FROM tenant_email_domains "
                "WHERE tenant_id = :tid ORDER BY is_primary DESC, domain ASC"
            ),
            {"tid": tenant_id},
        )
        return [
            {
                "domain":     r[0],
                "is_primary": r[1],
                "created_at": r[2].isoformat() if r[2] else None,
            }
            for r in result.fetchall()
        ]


@router.post("/{tenant_id}/email-domains", status_code=status.HTTP_201_CREATED)
async def add_email_domain(
    tenant_id: str,
    body: EmailDomainBody,
    request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Agrega un dominio a un tenant. Si is_primary=True, des-marca el anterior.

    Validaciones:
      - El dominio debe tener forma valida (sin @, en lowercase).
      - No puede ya existir en otra tenant (PK collision → 409).
      - Bloqueamos dominios genericos (gmail, hotmail) para evitar que un
        admin se "robe" todos los usuarios de Gmail accidentalmente.
    """
    BLOCKED_DOMAINS = {
        "gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "yahoo.com.ar",
        "live.com", "icloud.com", "protonmail.com", "msn.com", "googlemail.com",
    }
    domain = body.domain.lower().strip()
    if domain.startswith("@"):
        domain = domain[1:]
    if not _DOMAIN_RE.match(domain):
        raise HTTPException(status_code=400, detail="Dominio inválido. Ej: empresa.com.ar")
    if domain in BLOCKED_DOMAINS:
        raise HTTPException(
            status_code=400,
            detail=f"'{domain}' es un dominio público. Solo se pueden cargar dominios corporativos.",
        )

    async with get_pg_session(None) as session:
        # Verificar que el tenant existe
        t = await session.execute(text("SELECT 1 FROM tenants WHERE id = :tid"), {"tid": tenant_id})
        if t.scalar() is None:
            raise HTTPException(status_code=404, detail="Tenant no encontrado")

        # Verificar duplicado en otra tenant
        existing = await session.execute(
            text("SELECT tenant_id FROM tenant_email_domains WHERE domain = :d"),
            {"d": domain},
        )
        ex = existing.fetchone()
        if ex is not None:
            if ex[0] == tenant_id:
                raise HTTPException(status_code=409, detail="Ya está cargado en este tenant")
            raise HTTPException(status_code=409, detail=f"Ya pertenece a otro tenant ({ex[0]})")

        # Si is_primary=True, des-marcar el actual
        if body.is_primary:
            await session.execute(
                text("UPDATE tenant_email_domains SET is_primary = FALSE WHERE tenant_id = :tid"),
                {"tid": tenant_id},
            )
        await session.execute(
            text(
                "INSERT INTO tenant_email_domains (domain, tenant_id, is_primary) "
                "VALUES (:d, :tid, :p)"
            ),
            {"d": domain, "tid": tenant_id, "p": body.is_primary},
        )

    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
        tenant_id=tenant_id,
        actor_id=current_user.user_id,
        actor_email=current_user.email,
        actor_role=current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role),
        action="tenant.email_domain_added",
        resource=domain,
        detail={"is_primary": body.is_primary},
        request=request,
    ))
    return {"domain": domain, "tenant_id": tenant_id, "is_primary": body.is_primary}


@router.delete("/{tenant_id}/email-domains/{domain}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_email_domain(
    tenant_id: str,
    domain: str,
    request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Quita un dominio. Los usuarios existentes siguen funcionando — solo
    deja de ofrecer el shortcut de branding por dominio en el login."""
    domain = domain.lower().strip()
    async with get_pg_session(None) as session:
        result = await session.execute(
            text("DELETE FROM tenant_email_domains WHERE domain = :d AND tenant_id = :tid RETURNING domain"),
            {"d": domain, "tid": tenant_id},
        )
        if result.fetchone() is None:
            raise HTTPException(status_code=404, detail="Dominio no encontrado en este tenant")

    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
        tenant_id=tenant_id,
        actor_id=current_user.user_id,
        actor_email=current_user.email,
        actor_role=current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role),
        action="tenant.email_domain_removed",
        resource=domain,
        request=request,
    ))


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


# ── Bot config (admin endpoint — read/update from settings page) ─────────────

class BotConfigResponse(BaseModel):
    bot_name: str | None
    bot_description: str | None
    bot_scope: str | None
    min_retrieval_score: float
    greeting_message: str | None
    prompt_quality_gate: str | None
    prompt_cluster_label: str | None
    onboarding_completed: bool


class BotConfigUpdate(BaseModel):
    bot_name: str | None = None
    bot_description: str | None = None
    bot_scope: str | None = None
    min_retrieval_score: float | None = None
    greeting_message: str | None = None
    prompt_quality_gate: str | None = None
    prompt_cluster_label: str | None = None


@router.get("/{tenant_id}/bot-config", response_model=BotConfigResponse)
async def get_bot_config(
    tenant_id: str,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Return bot configuration for this tenant."""
    if current_user.role.value != "super_admin" and current_user.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Cannot read config for another tenant")

    async with get_pg_session() as session:
        result = await session.execute(
            text("SELECT bot_name, bot_description, bot_scope, min_retrieval_score, greeting_message, prompt_quality_gate, prompt_cluster_label, onboarding_completed FROM tenants WHERE id = :tid"),
            {"tid": tenant_id},
        )
        row = result.mappings().fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="Tenant not found")

    return BotConfigResponse(
        bot_name=row["bot_name"],
        bot_description=row["bot_description"],
        bot_scope=row["bot_scope"],
        min_retrieval_score=float(row["min_retrieval_score"]) if row["min_retrieval_score"] is not None else 0.45,
        greeting_message=row["greeting_message"],
        prompt_quality_gate=row["prompt_quality_gate"],
        prompt_cluster_label=row["prompt_cluster_label"],
        onboarding_completed=bool(row["onboarding_completed"]),
    )


@router.patch("/{tenant_id}/bot-config", response_model=BotConfigResponse)
async def update_bot_config(
    tenant_id: str,
    body: BotConfigUpdate,
    request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Update bot description, scope, minimum relevance threshold and greeting message."""
    if current_user.role.value != "super_admin" and current_user.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Cannot update config for another tenant")

    if body.min_retrieval_score is not None and not (0.0 <= body.min_retrieval_score <= 1.0):
        raise HTTPException(status_code=422, detail="min_retrieval_score must be between 0.0 and 1.0")

    updates: list[str] = []
    params: dict = {"tid": tenant_id}

    if body.bot_name is not None:
        updates.append("bot_name = :bot_name")
        params["bot_name"] = body.bot_name.strip() or None
    if body.bot_description is not None:
        updates.append("bot_description = :bot_description")
        params["bot_description"] = body.bot_description or None
    if body.bot_scope is not None:
        updates.append("bot_scope = :bot_scope")
        params["bot_scope"] = body.bot_scope or None
    if body.min_retrieval_score is not None:
        updates.append("min_retrieval_score = :min_retrieval_score")
        params["min_retrieval_score"] = body.min_retrieval_score
    if body.greeting_message is not None:
        updates.append("greeting_message = :greeting_message")
        params["greeting_message"] = body.greeting_message or None
    if body.prompt_quality_gate is not None:
        updates.append("prompt_quality_gate = :prompt_quality_gate")
        params["prompt_quality_gate"] = body.prompt_quality_gate or None
    if body.prompt_cluster_label is not None:
        updates.append("prompt_cluster_label = :prompt_cluster_label")
        params["prompt_cluster_label"] = body.prompt_cluster_label or None

    if updates:
        updates.append("updated_at = NOW()")
        async with get_pg_session() as session:
            await session.execute(
                text(f"UPDATE tenants SET {', '.join(updates)} WHERE id = :tid"),
                params,
            )

    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        await redis.delete(f"{tenant_id}:bot_config")
    except Exception:
        pass

    logger.info("bot_config_updated tenant_id=%s by=%s", tenant_id, current_user.user_id)

    from core.audit import record as audit, fire_and_log
    changed = {k: v for k, v in body.model_dump().items() if v is not None}
    fire_and_log(audit(
        tenant_id=tenant_id,
        actor_id=current_user.user_id,
        actor_email=current_user.email,
        actor_role=current_user.role.value,
        action="config.bot_config_update",
        detail={"fields": list(changed.keys())},
        request=request,
    ))

    return await get_bot_config(tenant_id, current_user)


# ── Onboarding (admin — first-login setup) ────────────────────────────────────
# Flujo hibrido: 5 preguntas curadas + 1 followup adaptativo opcional.
# - Las 5 fijas garantizan cobertura minima de los aspectos esenciales del bot.
# - La 6ta (followup) es generada por IA y profundiza UN aspecto si vale la pena.
# - La descripcion final se arma con TODO + los docs cargados.

class OnboardingFixedAnswers(BaseModel):
    """5 respuestas del wizard curado. Cubren los 5 elementos minimos que
    necesita el system prompt del bot."""
    audience:           str = Field(default="", max_length=500)
    typical_questions:  str = Field(default="", max_length=1000)
    excluded_topics:    str = Field(default="", max_length=500)
    fallback:           str = Field(default="suggest_contact")
    additional_notes:   str = Field(default="", max_length=500)


class OnboardingGenerateRequest(BaseModel):
    """Pide la generacion final del bot_description. Toma respuestas curadas
    + opcional followup + lee documentos cargados del tenant."""
    org_name:           str = Field(..., min_length=1, max_length=200)
    org_type:           str = Field(..., min_length=1, max_length=100)
    tone:               str = Field(..., min_length=1, max_length=50)
    bot_name:           str = Field(default="", max_length=100)
    answers:            OnboardingFixedAnswers
    followup_question:  str = Field(default="", max_length=500)
    followup_answer:    str = Field(default="", max_length=1000)


class OnboardingGenerateResponse(BaseModel):
    bot_description: str


class OnboardingCompleteRequest(BaseModel):
    bot_name: str
    bot_description: str


class OnboardingTestQueryRequest(BaseModel):
    """Permite probar interactivamente como respondera el bot con un bot_description
    tentativo durante el wizard, sin persistir nada."""
    question: str = Field(..., min_length=1, max_length=500)
    bot_description: str = Field(..., min_length=20, max_length=2000)


class OnboardingTestQueryResponse(BaseModel):
    answer: str


class OnboardingFollowupRequest(BaseModel):
    """Pide a la IA si vale la pena profundizar en UN aspecto despues de las
    5 preguntas curadas. La IA puede devolver una pregunta o null si ya hay
    suficiente contexto."""
    org_name:  str = Field(..., min_length=1, max_length=200)
    org_type:  str = Field(..., min_length=1, max_length=100)
    tone:      str = Field(..., min_length=1, max_length=50)
    bot_name:  str = Field(default="", max_length=100)
    answers:   OnboardingFixedAnswers


class OnboardingFollowupResponse(BaseModel):
    """question=null significa que la IA decidio que no hay nada para profundizar."""
    question: str | None = None


# Mapeo de fallback_behavior → instruccion concreta que entra al bot_description.
_FALLBACK_INSTRUCTIONS: dict[str, str] = {
    "suggest_contact":        "Cuando no encuentra la respuesta en sus documentos, sugiere consultar directamente con la organización.",
    "offer_handoff":          "Cuando no encuentra la respuesta en sus documentos, ofrece derivar la consulta a un operador humano.",
    "request_contact":        "Cuando no encuentra la respuesta en sus documentos, pide al usuario su email o teléfono e indica que la organización lo contactará.",
    "suggest_business_hours": "Cuando no encuentra la respuesta en sus documentos, sugiere comunicarse durante el horario de atención de la organización.",
}


async def _read_doc_previews(tenant_id: str) -> str:
    """Devuelve string formateado con preview de los 3 docs ready mas recientes.
    Vacio si no hay docs o falla la lectura."""
    try:
        async with get_pg_session(tenant_id) as session:
            result = await session.execute(text("""
                SELECT d.title,
                    (SELECT LEFT(p.text, 400) FROM parent_chunks p
                     WHERE p.document_id = d.id ORDER BY p.chunk_index ASC LIMIT 1) AS preview
                FROM documentos d WHERE d.status = 'ready'
                ORDER BY d.created_at DESC LIMIT 3
            """))
            rows = [r for r in result.mappings().all() if r["preview"]]
        if not rows:
            return ""
        return "\n\nDocumentos ya cargados (fragmentos reales):\n" + "\n---\n".join(
            f"📄 {r['title']}:\n{r['preview']}" for r in rows
        )
    except Exception as exc:
        logger.warning("onboarding_doc_preview_failed tenant_id=%s err=%s", tenant_id, exc)
        return ""


def _format_answers_block(answers: OnboardingFixedAnswers) -> str:
    """Convierte las 5 respuestas curadas en un bloque legible para el prompt."""
    fallback_text = _FALLBACK_INSTRUCTIONS.get(
        answers.fallback, _FALLBACK_INSTRUCTIONS["suggest_contact"]
    )
    return (
        f"- Audiencia: {answers.audience.strip() or '(sin especificar)'}\n"
        f"- Preguntas típicas que recibirá: {answers.typical_questions.strip() or '(no especificadas)'}\n"
        f"- Temas que NO debe responder: {answers.excluded_topics.strip() or '(ninguno indicado)'}\n"
        f"- Comportamiento ante consultas fuera del alcance: {fallback_text}\n"
        f"- Notas adicionales del admin: {answers.additional_notes.strip() or '(ninguna)'}"
    )


@router.post("/{tenant_id}/onboarding/followup", response_model=OnboardingFollowupResponse)
async def onboarding_followup(
    tenant_id: str,
    body: OnboardingFollowupRequest,
    current_user: CurrentUser = Depends(require_admin),
):
    """Decide si vale la pena hacer UNA pregunta de profundizacion al admin,
    despues de las 5 preguntas curadas. Lee respuestas + docs cargados, y:
    - Si hay algo ambiguo o no cubierto → devuelve la pregunta
    - Si las respuestas + docs ya alcanzan → devuelve question=null
    """
    if current_user.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Cannot ask for another tenant")

    async with get_pg_session() as session:
        result = await session.execute(
            text("SELECT onboarding_completed FROM tenants WHERE id = :tid"),
            {"tid": tenant_id},
        )
        row = result.mappings().fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    if row["onboarding_completed"]:
        raise HTTPException(status_code=409, detail="Onboarding already completed")

    doc_context = await _read_doc_previews(tenant_id)
    bot_name_str = f"El asistente se llama '{body.bot_name}'." if body.bot_name.strip() else ""
    answers_block = _format_answers_block(body.answers)

    prompt = f"""Sos un especialista en configurar asistentes virtuales. \
Tu única tarea ahora es decidir si hay UN aspecto importante que valga la pena \
profundizar para mejorar la configuración del bot.

Contexto:
- Organización: {body.org_name} ({body.org_type})
- Tono elegido: {body.tone}
{f"- {bot_name_str}" if bot_name_str else ""}

Respuestas del admin (ya respondidas, NO repreguntes esto):
{answers_block}
{doc_context}

REGLAS:
1. Mirá si las respuestas son MUY vagas, ambiguas, o si hay algo en los docs que el admin no mencionó.
2. Si todo está bien cubierto → respondé exactamente "null" (sin comillas, sin texto extra).
3. Si vale la pena profundizar → hacé UNA sola pregunta corta (max 20 palabras), en español cotidiano.
4. La pregunta debe ayudar a precisar el bot, no a abrir nuevos temas.

PROHIBIDO usar jerga: "alcance funcional", "operativa", "stakeholders", "protocolos", \
"métricas", "particularidades operacionales", "casos de uso".

EJEMPLOS BUENOS de profundización:
✅ "Mencionaste que atendés socios. ¿Hay diferencia entre socios nuevos y antiguos?"
✅ "¿El tema sensible que excluiste también incluye consultas sobre precios?"
✅ "Vi que los docs mencionan horarios. ¿Querés que el bot los diga al saludar?"

EJEMPLOS MALOS (NO los hagas):
❌ "¿Cuál es la operativa institucional?"
❌ "¿Qué protocolos diferenciales aplican?"

Respondé SOLO con la pregunta en texto plano, o exactamente "null". Sin JSON, sin comillas, sin markdown."""

    from services.groq_client import complete, QueryComplexity
    import re as _re

    try:
        raw = await complete(
            messages=[{"role": "user", "content": prompt}],
            complexity=QueryComplexity.SIMPLE,
            temperature=0.3,
            max_tokens=100,
        )
    except Exception as exc:
        logger.error("onboarding_followup_failed tenant_id=%s err=%s", tenant_id, exc)
        # No bloquear el onboarding si la IA falla — devolver null (skip natural).
        return OnboardingFollowupResponse(question=None)

    # Limpiar respuesta
    question = raw.strip()
    md_match = _re.search(r"```(?:\w+)?\s*([\s\S]*?)```", question)
    if md_match:
        question = md_match.group(1).strip()
    question = question.strip('"\'`').strip()

    # "null" en cualquier forma → no preguntar
    if not question or question.lower() in ("null", "none", "nada", "no", "n/a"):
        return OnboardingFollowupResponse(question=None)

    # Validacion: rechazar si tiene jerga prohibida (el LLM ignoro las reglas)
    FORBIDDEN = ("alcance funcional", "stakeholder", "operativa institucional",
                 "protocolos diferenciales", "métricas", "casos de uso", "particularidades")
    if any(j in question.lower() for j in FORBIDDEN):
        logger.info("onboarding_followup_rejected_jargon tenant_id=%s q=%r", tenant_id, question[:80])
        return OnboardingFollowupResponse(question=None)

    # Truncar si vino muy larga
    if len(question) > 300:
        question = question[:300].rsplit(" ", 1)[0]
        if not question.endswith("?"):
            question += "?"

    return OnboardingFollowupResponse(question=question)


@router.post("/{tenant_id}/onboarding/generate", response_model=OnboardingGenerateResponse)
async def onboarding_generate(
    tenant_id: str,
    body: OnboardingGenerateRequest,
    current_user: CurrentUser = Depends(require_admin),
):
    """Genera el bot_description final a partir de:
    - Las 5 respuestas curadas del admin (audience, typical_questions, excluded, fallback, notes)
    - Opcional: pregunta+respuesta del followup adaptativo
    - Contenido real de documentos cargados en el tenant (top 3)

    El LLM combina todo y emite una descripcion concisa optimizada como system prompt.
    No persiste — el admin la confirma despues via /onboarding/complete.
    """
    if current_user.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Cannot generate for another tenant")

    async with get_pg_session() as session:
        result = await session.execute(
            text("SELECT onboarding_completed FROM tenants WHERE id = :tid"),
            {"tid": tenant_id},
        )
        row = result.mappings().fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    if row["onboarding_completed"]:
        raise HTTPException(status_code=409, detail="Onboarding already completed")

    bot_name_line = (
        f"El asistente se llama '{body.bot_name}'."
        if body.bot_name.strip()
        else "El asistente no tiene nombre propio."
    )

    answers_block = _format_answers_block(body.answers)
    doc_context = await _read_doc_previews(tenant_id)
    if doc_context:
        doc_context += (
            "\n\nIMPORTANTE: si el contenido REAL de los documentos cubre temas distintos a "
            "los listados por el admin, privilegiá el contenido real para describir qué sabe "
            "responder el bot. Los documentos son la fuente de verdad sobre el alcance."
        )

    followup_block = ""
    if body.followup_question.strip() and body.followup_answer.strip():
        followup_block = (
            f"\n\nPregunta de profundización (adaptativa):\n"
            f"- IA preguntó: {body.followup_question.strip()}\n"
            f"- Admin respondió: {body.followup_answer.strip()}"
        )

    prompt = f"""Generá una descripción concisa (4-6 oraciones) de un asistente virtual, \
optimizada para ser leída por un modelo de lenguaje como parte de su system prompt. \
Español neutro, tercera persona, sin saludos, sin listas, sin markdown.

Debe incluir explícitamente:
1. Quién es la organización (nombre + tipo)
2. A quién atiende el bot (audiencia)
3. Qué temas puede responder (basado en docs cargados + típicas mencionadas por el admin)
4. Qué temas NO debe responder (si los hay)
5. Qué tono usa
6. Qué hace cuando no encuentra la respuesta

Datos:
- Nombre de la organización: {body.org_name}
- Tipo: {body.org_type}
- Tono elegido: {body.tone}
- {bot_name_line}

Respuestas del admin:
{answers_block}{followup_block}{doc_context}

Respondé ÚNICAMENTE con el texto de la descripción, sin título, sin comillas, sin formato extra."""

    from services.groq_client import complete, QueryComplexity
    import re as _re

    try:
        raw = await complete(
            messages=[{"role": "user", "content": prompt}],
            complexity=QueryComplexity.SIMPLE,
            temperature=0.35,
            max_tokens=400,
        )
    except Exception as exc:
        logger.error("onboarding_generate_failed tenant_id=%s error=%s", tenant_id, exc)
        raise HTTPException(status_code=502, detail="No se pudo generar la descripción. Intentá de nuevo.")

    # Limpiar: quitar fences markdown, comillas externas
    desc = raw.strip()
    md_match = _re.search(r"```(?:\w+)?\s*([\s\S]*?)```", desc)
    if md_match:
        desc = md_match.group(1).strip()
    desc = desc.strip('"\'`')

    # Fallback defensivo si vino algo demasiado corto
    if len(desc) < 30:
        fallback_text = _FALLBACK_INSTRUCTIONS.get(
            body.answers.fallback, _FALLBACK_INSTRUCTIONS["suggest_contact"]
        )
        desc = (
            f"Asistente virtual de {body.org_name} ({body.org_type}). "
            f"Responde consultas en base a los documentos institucionales cargados, "
            f"en tono {body.tone}. {fallback_text}"
        )

    return OnboardingGenerateResponse(bot_description=desc)


@router.post("/{tenant_id}/onboarding/test-query", response_model=OnboardingTestQueryResponse)
async def onboarding_test_query(
    tenant_id: str,
    body: OnboardingTestQueryRequest,
    current_user: CurrentUser = Depends(require_admin),
):
    """Test interactivo del bot durante el wizard.

    Le manda al LLM (Groq fast) el bot_description tentativo + la pregunta del admin
    y devuelve la respuesta. Sirve para validar tono, scope y fallback antes de
    confirmar el onboarding.

    Importante: NO usa RAG (no consulta documentos del tenant). Lo que prueba es
    como el LLM interpretara el bot_description, no como respondera con docs reales.
    """
    if current_user.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Cannot test for another tenant")

    system_prompt = f"""Sos un asistente virtual con la siguiente descripcion oficial:

{body.bot_description}

REGLAS DE RESPUESTA:
1. Respondé en el tono que la descripcion indica.
2. Si la pregunta esta dentro del alcance descripto, intenta responder lo mejor posible.
3. Si la pregunta esta FUERA del alcance descripto (tema excluido o no cubierto), aplica
   el comportamiento de fallback que tu descripcion menciona.
4. Esta es una prueba durante la configuracion inicial — todavia no tenes documentos
   cargados, asi que para preguntas factuales especificas, indica honestamente que
   necesitarias consultar los documentos cargados de la organizacion."""

    from services.groq_client import complete, QueryComplexity
    try:
        answer = await complete(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": body.question},
            ],
            complexity=QueryComplexity.SIMPLE,
            temperature=0.3,
            max_tokens=250,
        )
    except Exception as exc:
        logger.error("onboarding_test_query_failed tenant_id=%s error=%s", tenant_id, exc)
        raise HTTPException(status_code=502, detail="No se pudo generar la respuesta de prueba. Intentá de nuevo.")

    return OnboardingTestQueryResponse(answer=answer.strip())


@router.post("/{tenant_id}/onboarding/complete", status_code=204)
async def onboarding_complete(
    tenant_id: str,
    body: OnboardingCompleteRequest,
    request: Request,
    current_user: CurrentUser = Depends(require_admin),
):
    """Persist bot_name + bot_description and mark onboarding as done.
    Only callable once — after that returns 409.
    """
    if current_user.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Cannot complete onboarding for another tenant")

    if not body.bot_description.strip():
        raise HTTPException(status_code=422, detail="bot_description cannot be empty")

    async with get_pg_session() as session:
        result = await session.execute(
            text("SELECT onboarding_completed FROM tenants WHERE id = :tid"),
            {"tid": tenant_id},
        )
        row = result.mappings().fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    if row["onboarding_completed"]:
        raise HTTPException(status_code=409, detail="Onboarding already completed")

    async with get_pg_session() as session:
        await session.execute(
            text("""
                UPDATE tenants
                SET bot_name = :bot_name,
                    bot_description = :bot_description,
                    onboarding_completed = true,
                    updated_at = NOW()
                WHERE id = :tid
            """),
            {
                "tid": tenant_id,
                "bot_name": body.bot_name.strip() or None,
                "bot_description": body.bot_description.strip(),
            },
        )

    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        await redis.delete(f"{tenant_id}:bot_config")
    except Exception:
        pass

    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
        tenant_id=tenant_id,
        actor_id=current_user.user_id,
        actor_email=current_user.email,
        actor_role=current_user.role.value,
        action="config.onboarding_completed",
        request=request,
    ))

    logger.info("onboarding_completed tenant_id=%s by=%s", tenant_id, current_user.user_id)


# ── Widget token (admin endpoint — also used from settings page) ──────────────

@router.post("/{tenant_id}/widget-token", response_model=WidgetTokenResponse)
async def generate_widget_token(
    tenant_id: str,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Generate a non-expiring widget token scoped to this tenant.

    Revocación: regenerar reemplaza el hash en DB → el token previo deja
    de validar al instante (cache de Redis se busta también).
    """
    if current_user.role.value != "super_admin" and current_user.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Cannot generate token for another tenant")

    token = create_widget_token(tenant_id)
    token_hash = hashlib.sha256(token.encode()).hexdigest()

    async with get_pg_session(None) as session:
        await session.execute(
            text("UPDATE tenants SET widget_token_hash = :hash, updated_at = NOW() WHERE id = :tid"),
            {"hash": token_hash, "tid": tenant_id},
        )

    # Bust the cached hash so the new token is valid immediately
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        await redis.delete(f"{tenant_id}:widget_token_hash")
    except Exception:
        pass

    logger.info("widget_token_generated tenant_id=%s by=%s", tenant_id, current_user.user_id)
    return WidgetTokenResponse(
        widget_token=token,
        tenant_id=tenant_id,
    )


# ── List users of a tenant (super_admin only) ────────────────────────────────

@router.get("/{tenant_id}/users")
async def list_tenant_users(
    tenant_id: str,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Return all users of a tenant. Super-admin only."""
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text("SELECT id, email, name, role, is_active, created_at FROM usuarios ORDER BY created_at DESC")
        )
        rows = result.mappings().fetchall()
    return [
        {
            "id": str(r["id"]),
            "email": r["email"],
            "name": r["name"],
            "role": r["role"],
            "is_active": r["is_active"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        }
        for r in rows
    ]


# ── Update user (super_admin only) ───────────────────────────────────────────

class UserUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    role: str | None = Field(None, pattern="^(admin|operator|user)$")
    is_active: bool | None = None
    password: str | None = Field(None, max_length=200)

    @validator("password", pre=True, always=True)
    @classmethod
    def blank_password_to_none(cls, v: str | None) -> str | None:
        if v is not None and v.strip() == "":
            return None
        if v is not None and len(v) < 8:
            raise ValueError("La contraseña debe tener al menos 8 caracteres")
        return v


@router.patch("/{tenant_id}/users/{user_id}")
async def update_tenant_user(
    tenant_id: str,
    user_id: str,
    body: UserUpdate,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Update a tenant user's name, role, active status or password. Super-admin only."""
    from core.security import hash_password

    updates: dict = {}
    if body.name is not None:
        updates["name"] = body.name.strip()
    if body.role is not None:
        updates["role"] = body.role
    if body.is_active is not None:
        updates["is_active"] = body.is_active
    if body.password is not None:
        updates["hashed_password"] = hash_password(body.password)

    if not updates:
        raise HTTPException(status_code=400, detail="Nada que actualizar")

    set_clause = ", ".join(f"{k} = :{k}" for k in updates)
    updates["user_id"] = user_id

    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text(f"UPDATE usuarios SET {set_clause} WHERE id = :user_id RETURNING id, email, name, role, is_active"),
            updates,
        )
        row = result.mappings().fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Usuario no encontrado")

        # Si se desactivó al usuario, liberar sus conversaciones activas en la misma
        # transacción para que no queden huérfanas (asignadas a alguien inactivo).
        if body.is_active is False:
            from services.handoff import release_operator_conversations
            await release_operator_conversations(session, user_id)
            # Consistente con el borrado de operadores: limpiar sectores y tokens vivos
            # (el id se reusa si luego se reactiva → un token viejo revivía).
            await session.execute(text(
                "DELETE FROM operador_sectores WHERE operador_id = :id"
            ), {"id": user_id})
            await session.execute(text(
                "UPDATE public.password_reset_tokens SET used_at = NOW() "
                "WHERE user_id = :id AND tenant_id = :tid AND used_at IS NULL"
            ), {"id": user_id, "tid": tenant_id})

    logger.info("tenant_user_updated tenant=%s user=%s by=%s", tenant_id, user_id, current_user.user_id)
    return {"id": str(row["id"]), "email": row["email"], "name": row["name"], "role": row["role"], "is_active": row["is_active"]}


# ── Create / replace admin for an existing tenant (super_admin only) ──────────

class AdminCreate(BaseModel):
    email: EmailStr
    name: str = Field(..., min_length=1, max_length=120)
    # Sin password → invitación por email (el usuario define la suya). Con
    # password → alta manual clásica.
    password: str | None = Field(None, min_length=8, max_length=200)


@router.post("/{tenant_id}/admin", status_code=201)
async def create_tenant_admin(
    tenant_id: str,
    body: AdminCreate,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Create (or replace) the admin user for a tenant. Super-admin only."""
    import secrets as _secrets
    import uuid
    from core.security import hash_password

    invite = body.password is None
    effective_password = body.password or _secrets.token_urlsafe(24)

    email_norm = body.email.lower().strip()
    async with get_pg_session(tenant_id) as session:
        existing = await session.execute(
            text("SELECT id, is_active FROM usuarios WHERE email = :email"),
            {"email": email_norm},
        )
        existing_row = existing.mappings().fetchone()
        if existing_row and existing_row["is_active"]:
            raise HTTPException(status_code=409, detail="Ya existe un usuario con ese email en este tenant")

        if existing_row:
            # Email de una cuenta dada de baja (email es UNIQUE): la REACTIVAMOS como
            # admin (el super-admin la está recreando explícitamente). Sin esto, recrear
            # un usuario borrado con el mismo mail respondía 409 para siempre.
            new_id = str(existing_row["id"])
            await session.execute(text("""
                UPDATE usuarios
                SET name = :name, hashed_password = :pwd, role = 'admin',
                    is_active = TRUE, updated_at = NOW()
                WHERE id = :id
            """), {"id": new_id, "name": body.name.strip(), "pwd": hash_password(effective_password)})
            # Limpiar estado que sobrevive a la baja (el id se reusa): tokens vivos y
            # sectores heredados.
            await session.execute(text(
                "UPDATE public.password_reset_tokens SET used_at = NOW() "
                "WHERE user_id = :id AND tenant_id = :tid AND used_at IS NULL"
            ), {"id": new_id, "tid": tenant_id})
            await session.execute(text(
                "DELETE FROM operador_sectores WHERE operador_id = :id"
            ), {"id": new_id})
        else:
            new_id = str(uuid.uuid4())
            await session.execute(text("""
                INSERT INTO usuarios (id, email, name, hashed_password, role, is_active)
                VALUES (:id, :email, :name, :pwd, 'admin', true)
            """), {
                "id": new_id,
                "email": email_norm,
                "name": body.name.strip(),
                "pwd": hash_password(effective_password),
            })

    invitation_sent = False
    if invite:
        from services.invitations import send_account_invitation
        invitation_sent = await send_account_invitation(
            tenant_id, new_id, body.email.lower().strip(), body.name.strip())

    logger.info("tenant_admin_created tenant=%s email=%s by=%s invited=%s",
                tenant_id, body.email, current_user.user_id, invitation_sent)
    return {"id": new_id, "email": body.email.lower().strip(), "name": body.name.strip(),
            "role": "admin", "tenant_id": tenant_id, "invitation_sent": invitation_sent if invite else None}


# ── Platform health summary ───────────────────────────────────────────────────

@router.get("/platform/health")
async def get_platform_health(
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Lightweight platform overview: active tenants, queries today, near-quota anomalies."""
    async with get_pg_session(None) as session:
        counts = await session.execute(text("""
            SELECT
                COUNT(*) FILTER (WHERE status = 'active')    AS active_count,
                COUNT(*)                                      AS total_count
            FROM tenants
        """))
        counts_row = counts.mappings().fetchone()

        today_q = await session.execute(text("""
            SELECT COALESCE(SUM(value), 0) AS queries_today
            FROM usage_events
            WHERE event_type = 'query' AND created_at >= CURRENT_DATE
        """))
        queries_today = int(today_q.scalar() or 0)

        month_rows = await session.execute(text("""
            SELECT
                t.id, t.name, t.plan,
                COALESCE(SUM(ue.value) FILTER (WHERE ue.event_type = 'query'), 0)  AS queries_month,
                COALESCE(COUNT(ue.id) FILTER (WHERE ue.event_type = 'ingest'), 0) AS ingests_month
            FROM tenants t
            LEFT JOIN usage_events ue
                   ON ue.tenant_id = t.id
                  AND ue.created_at >= date_trunc('month', NOW())
            WHERE t.status = 'active'
            GROUP BY t.id, t.name, t.plan
        """))
        month_data = month_rows.mappings().all()

    anomalies = []
    for r in month_data:
        limit = PLAN_LIMITS.get(r["plan"], {}).get("queries_month", -1)
        if limit > 0:
            used = int(r["queries_month"])
            pct = used / limit
            if pct >= 0.8:
                anomalies.append({
                    "tenant_id":   r["id"],
                    "tenant_name": r["name"],
                    "type":        "near_quota",
                    "pct":         round(pct * 100, 1),
                    "detail":      f"{used:,} / {limit:,} consultas este mes",
                })

    return {
        "active_tenants": int(counts_row["active_count"]),
        "total_tenants":  int(counts_row["total_count"]),
        "queries_today":  queries_today,
        "anomalies":      anomalies,
    }


# ── Per-tenant comprehensive metrics ──────────────────────────────────────────

@router.get("/{tenant_id}/metrics")
async def get_tenant_metrics(
    tenant_id: str,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Full metrics for a single tenant: usage, performance, docs, quality, quota, recent activity."""
    # 1. Global usage_events
    async with get_pg_session(None) as session:
        tenant_row = (await session.execute(
            text("SELECT plan, status, name, admin_email, created_at FROM tenants WHERE id = :tid"),
            {"tid": tenant_id},
        )).mappings().fetchone()

        if not tenant_row:
            raise HTTPException(status_code=404, detail="Tenant not found")

        usage_row = (await session.execute(text("""
            SELECT
                COALESCE(SUM(value) FILTER (WHERE event_type='query' AND created_at >= CURRENT_DATE),                     0) AS queries_today,
                COALESCE(SUM(value) FILTER (WHERE event_type='query' AND created_at >= NOW() - INTERVAL '7 days'),        0) AS queries_7d,
                COALESCE(SUM(value) FILTER (WHERE event_type='query' AND created_at >= NOW() - INTERVAL '30 days'),       0) AS queries_30d,
                COALESCE(SUM(value) FILTER (WHERE event_type='query' AND created_at >= date_trunc('month', NOW())),       0) AS queries_this_month,
                COALESCE(COUNT(*) FILTER (WHERE event_type='ingest' AND created_at >= NOW() - INTERVAL '30 days'),      0) AS ingests_30d,
                COALESCE(SUM(value) FILTER (WHERE event_type='llm_tokens' AND created_at >= NOW() - INTERVAL '30 days'), 0) AS llm_tokens_30d
            FROM usage_events WHERE tenant_id = :tid
        """), {"tid": tenant_id})).mappings().fetchone()

        # Daily queries last 30 days for sparkline
        daily_rows = (await session.execute(text("""
            SELECT DATE(created_at) AS day, SUM(value)::int AS total
            FROM usage_events
            WHERE tenant_id = :tid AND event_type = 'query'
              AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY day
        """), {"tid": tenant_id})).mappings().all()

    # 2. Per-tenant consultas_log (performance + quality + intents + recent)
    perf = {"latency_p50": None, "latency_p95": None, "cache_hit_rate": None, "avg_confidence": None, "total_logged": 0}
    quality = {"passed": 0, "pending": 0, "skipped": 0}
    recent_queries: list = []
    top_intents: list = []

    try:
        async with get_pg_session(tenant_id) as session:
            perf_row = (await session.execute(text("""
                SELECT
                    PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY latency_ms)                     AS p50,
                    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)                     AS p95,
                    AVG(CASE WHEN from_cache THEN 1.0 ELSE 0.0 END)                              AS cache_hit_rate,
                    AVG(intent_confidence) FILTER (WHERE intent_confidence IS NOT NULL)           AS avg_confidence,
                    COUNT(*)                                                                       AS total_logged
                FROM consultas_log
                WHERE created_at >= NOW() - INTERVAL '30 days'
            """))).mappings().fetchone()

            if perf_row and int(perf_row["total_logged"] or 0) > 0:
                perf = {
                    "latency_p50":    int(perf_row["p50"])  if perf_row["p50"]  else None,
                    "latency_p95":    int(perf_row["p95"])  if perf_row["p95"]  else None,
                    "cache_hit_rate": round(float(perf_row["cache_hit_rate"] or 0), 3),
                    "avg_confidence": round(float(perf_row["avg_confidence"]), 3) if perf_row["avg_confidence"] else None,
                    "total_logged":   int(perf_row["total_logged"]),
                }

            for r in (await session.execute(text("""
                SELECT quality_gate_status, COUNT(*)::int AS cnt
                FROM consultas_log
                WHERE created_at >= NOW() - INTERVAL '30 days'
                GROUP BY quality_gate_status
            """))).mappings().all():
                quality[r["quality_gate_status"]] = r["cnt"]

            recent_queries = [
                {
                    "question_text":    r["question_text"],
                    "intent_label":     r["intent_label"],
                    "intent_confidence": round(float(r["intent_confidence"]), 2) if r["intent_confidence"] else None,
                    "latency_ms":       r["latency_ms"],
                    "from_cache":       r["from_cache"],
                    "created_at":       r["created_at"].isoformat(),
                }
                for r in (await session.execute(text("""
                    SELECT question_text, intent_label, intent_confidence,
                           latency_ms, from_cache, created_at
                    FROM consultas_log
                    ORDER BY created_at DESC LIMIT 10
                """))).mappings().all()
            ]

            top_intents = [
                {
                    "label":          r["intent_label"],
                    "count":          int(r["cnt"]),
                    "avg_confidence": round(float(r["avg_conf"]), 2) if r["avg_conf"] else None,
                }
                for r in (await session.execute(text("""
                    SELECT intent_label, COUNT(*)::int AS cnt,
                           AVG(intent_confidence) AS avg_conf
                    FROM consultas_log
                    WHERE intent_label IS NOT NULL
                      AND created_at >= NOW() - INTERVAL '30 days'
                    GROUP BY intent_label
                    ORDER BY cnt DESC LIMIT 10
                """))).mappings().all()
            ]

    except Exception as exc:
        logger.warning("tenant_metrics_log_failed tenant=%s err=%s", tenant_id, exc)

    # 3. Documents
    docs = {"total": 0, "ready": 0, "failed": 0, "processing": 0, "storage_bytes": 0}
    try:
        async with get_pg_session(tenant_id) as session:
            doc_row = (await session.execute(text("""
                SELECT
                    COUNT(*)::int                                               AS total,
                    COUNT(*) FILTER (WHERE status='ready')::int                AS ready,
                    COUNT(*) FILTER (WHERE status='failed')::int               AS failed,
                    COUNT(*) FILTER (WHERE status='processing')::int           AS processing,
                    COALESCE(SUM(size_bytes), 0)::bigint                       AS storage_bytes
                FROM documentos
            """))).mappings().fetchone()
            if doc_row:
                docs = {k: int(doc_row[k]) for k in docs}
    except Exception as exc:
        logger.warning("tenant_metrics_docs_failed tenant=%s err=%s", tenant_id, exc)

    # 4. Quota
    plan   = tenant_row["plan"]
    limits = PLAN_LIMITS.get(plan, {})
    q_used = int(usage_row["queries_this_month"])
    d_used = docs["total"] - docs["failed"]  # coincide con el enforce de cuota (excluye 'failed')

    def quota_entry(used: int, limit: int) -> dict:
        return {
            "used":  used,
            "limit": limit,
            "pct":   round(used / limit * 100, 1) if limit > 0 else None,
        }

    return {
        "tenant": {
            "id":          tenant_id,
            "name":        tenant_row["name"],
            "plan":        plan,
            "status":      tenant_row["status"],
            "admin_email": tenant_row["admin_email"],
            "created_at":  tenant_row["created_at"].isoformat() if tenant_row["created_at"] else None,
            "limits":      limits,
        },
        "usage": {
            "queries_today":  int(usage_row["queries_today"]),
            "queries_7d":     int(usage_row["queries_7d"]),
            "queries_30d":    int(usage_row["queries_30d"]),
            "ingests_30d":    int(usage_row["ingests_30d"]),
            "llm_tokens_30d": int(usage_row["llm_tokens_30d"]),
            "daily_30d":      [{"day": r["day"].isoformat(), "total": r["total"]} for r in daily_rows],
        },
        "docs":        docs,
        "performance": perf,
        "quality":     quality,
        "quota": {
            "queries_month": quota_entry(q_used, limits.get("queries_month", -1)),
            "documents":     quota_entry(d_used, limits.get("documents", -1)),
        },
        "recent_queries": recent_queries,
        "top_intents":    top_intents,
    }


# ── Platform system metrics (Prometheus) ─────────────────────────────────────

def _disk_status() -> dict:
    """Uso de disco del filesystem raíz (refleja el disco del host)."""
    import shutil
    try:
        du = shutil.disk_usage("/")
        return {
            "total_bytes": du.total,
            "used_bytes": du.used,
            "free_bytes": du.free,
            "used_pct": round(du.used / du.total * 100, 1) if du.total else None,
        }
    except Exception:
        return {"total_bytes": None, "used_bytes": None, "free_bytes": None, "used_pct": None}


def _backups_status() -> dict | None:
    """Estado del último backup diario y semanal (pg_dump al volumen /backups).

    El volumen se monta read-only en el backend. Umbrales de salud: el diario
    corre a las 03:00 UTC → >26h sin backup = vencido; el semanal corre los
    domingos → >8 días = vencido. None si el volumen no está montado.
    """
    import os
    base = os.getenv("BACKUPS_DIR", "/backups")
    if not os.path.isdir(base):
        return None

    def _latest(kind: str, max_age_hours: float) -> dict | None:
        d = os.path.join(base, kind)
        try:
            dumps = [os.path.join(d, f) for f in os.listdir(d) if f.endswith(".dump")]
        except OSError:
            return None
        if not dumps:
            return None
        latest = max(dumps, key=os.path.getmtime)
        st = os.stat(latest)
        age_h = (time.time() - st.st_mtime) / 3600
        return {
            "filename": os.path.basename(latest),
            "completed_at": int(st.st_mtime),
            "size_bytes": st.st_size,
            "age_hours": round(age_h, 1),
            "healthy": age_h <= max_age_hours,
            "count": len(dumps),
        }

    def _history(kind: str, max_items: int = 7) -> list[dict]:
        """Los últimos N dumps (más nuevo primero) — para ver de un vistazo que
        toda la semana corrió, y detectar un backup sospechosamente chico."""
        d = os.path.join(base, kind)
        try:
            dumps = [os.path.join(d, f) for f in os.listdir(d) if f.endswith(".dump")]
        except OSError:
            return []
        dumps.sort(key=os.path.getmtime, reverse=True)
        out = []
        for p in dumps[:max_items]:
            st = os.stat(p)
            out.append({
                "filename": os.path.basename(p),
                "completed_at": int(st.st_mtime),
                "size_bytes": st.st_size,
            })
        return out

    daily = _latest("daily", 26)
    weekly = _latest("weekly", 8 * 24)

    # Los domingos el cron del diario no corre (corre Lun-Sáb 03:00 UTC); ese
    # día el weekly de la madrugada cubre la ventana. Sin este ajuste, cada
    # domingo el panel marca el diario como "Vencido" (~34h) pese a que el
    # backup está sano. El diario se considera al día si hubo un dump completo
    # de cualquier tipo en las últimas 26h.
    if daily and not daily["healthy"] and weekly and weekly["age_hours"] <= 26:
        daily["healthy"] = True
        daily["covered_by_weekly"] = True

    return {
        "daily": daily,
        "weekly": weekly,
        "daily_history": _history("daily"),
    }


def _json_safe(o):
    """Reemplaza NaN/inf por None recursivamente.

    Prometheus devuelve NaN cuando una ventana no tiene datos (p.ej. p95 de
    latencia recién reiniciado el backend) y la serialización JSON estricta
    explota con 500 → la tab Sistema quedaba vacía.
    """
    import math
    if isinstance(o, dict):
        return {k: _json_safe(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_json_safe(v) for v in o]
    if isinstance(o, float) and not math.isfinite(o):
        return None
    return o


@router.get("/platform/system")
async def get_platform_system(
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Infrastructure health from Prometheus: PostgreSQL, Redis, HTTP, Groq, application counters."""
    now = int(time.time())
    data = await get_system_metrics(now)
    # Backups y disco no salen de Prometheus: se leen del filesystem.
    data["storage"] = _disk_status()
    data["backups"] = _backups_status()
    return _json_safe(data)


@router.get("/platform/alerts")
async def get_platform_alerts(
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Alertas ACTIVAS de Alertmanager (las mismas que llegan por email), en el panel."""
    import os
    import httpx
    base = os.getenv("ALERTMANAGER_URL", "http://alertmanager:9093")
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{base}/api/v2/alerts", params={"active": "true", "silenced": "false"})
            r.raise_for_status()
            alerts = r.json()
    except Exception as exc:
        logger.warning("alertmanager_unreachable error=%s", exc)
        return {"available": False, "alerts": []}

    return {
        "available": True,
        "alerts": [
            {
                "name": a.get("labels", {}).get("alertname", "alerta"),
                "severity": a.get("labels", {}).get("severity", "warning"),
                "summary": a.get("annotations", {}).get("summary")
                    or a.get("annotations", {}).get("description") or "",
                "since": a.get("startsAt"),
            }
            for a in alerts
        ],
    }


@router.get("/platform/errors")
async def get_platform_errors(
    limit: int = Query(50, ge=1, le=200),
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Errores/warnings recientes del backend (buffer en Redis, ver core/error_buffer)."""
    import asyncio as _aio
    from core.error_buffer import get_recent_errors
    errors = await _aio.to_thread(get_recent_errors, limit)
    return {"errors": errors}


@router.get("/platform/ops")
async def get_platform_ops(
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Señales operativas de negocio: colas de espera por tenant y derivaciones de hoy.

    El peor escenario en producción es un afiliado esperando sin que nadie lo
    vea — esta vista lo hace imposible de ignorar desde el Inicio.
    """
    async with get_pg_session(None) as session:
        result = await session.execute(
            text("SELECT id, name FROM tenants WHERE status = 'active' ORDER BY id"))
        tenants_list = [(r[0], r[1]) for r in result.fetchall()]

    queues = []
    handoffs_today_total = 0
    for tid, tname in tenants_list:
        try:
            async with get_pg_session(tid) as session:
                # OJO: el FILTER va pegado al agregado MIN(...) — afuera del
                # paréntesis es un syntax error que el try de abajo tragaba y
                # dejaba las colas siempre vacías.
                row = (await session.execute(text("""
                    SELECT
                        COUNT(*) FILTER (WHERE status = 'handoff_requested') AS waiting,
                        EXTRACT(EPOCH FROM (NOW() - MIN(handoff_requested_at)
                            FILTER (WHERE status = 'handoff_requested'))) AS oldest_wait_s,
                        COUNT(*) FILTER (WHERE status = 'human_attending') AS attending,
                        COUNT(*) FILTER (WHERE handoff_requested_at >= CURRENT_DATE) AS handoffs_today
                    FROM conversaciones
                """))).mappings().fetchone()
            waiting = int(row["waiting"] or 0)
            handoffs_today_total += int(row["handoffs_today"] or 0)
            if waiting > 0 or int(row["attending"] or 0) > 0:
                queues.append({
                    "tenant_id": tid,
                    "tenant_name": tname,
                    "waiting": waiting,
                    "attending": int(row["attending"] or 0),
                    "oldest_wait_min": round((row["oldest_wait_s"] or 0) / 60, 1) if waiting else 0,
                })
        except Exception:
            continue  # schema a medio provisionar

    queues.sort(key=lambda q: (-q["waiting"], -q["oldest_wait_min"]))
    return {"queues": queues, "handoffs_today": handoffs_today_total}


# ── Platform-wide traffic (super_admin only) ──────────────────────────────────

@router.get("/platform/traffic")
async def get_platform_traffic(
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Return daily traffic across all tenants for the last 30 days. No message content."""
    async with get_pg_session(None) as session:
        # Daily totals
        daily = await session.execute(text("""
            SELECT
                DATE(created_at)  AS day,
                event_type,
                SUM(value)        AS total
            FROM usage_events
            WHERE created_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at), event_type
            ORDER BY day DESC
        """))
        daily_rows = daily.mappings().all()

        # Per-tenant totals (last 30d) — no message content, only counts
        per_tenant = await session.execute(text("""
            SELECT
                t.id,
                t.name,
                t.plan,
                t.status,
                COALESCE(SUM(ue.value) FILTER (WHERE ue.event_type = 'query'), 0)  AS queries_30d,
                COALESCE(COUNT(ue.id) FILTER (WHERE ue.event_type = 'ingest'), 0) AS ingests_30d,
                COALESCE(SUM(ue.value) FILTER (WHERE ue.event_type = 'llm_tokens'), 0) AS tokens_30d
            FROM tenants t
            LEFT JOIN usage_events ue ON ue.tenant_id = t.id
                AND ue.created_at >= NOW() - INTERVAL '30 days'
            GROUP BY t.id, t.name, t.plan, t.status
            ORDER BY queries_30d DESC
        """))
        per_tenant_rows = per_tenant.mappings().all()

    return {
        "daily": [
            {
                "day":        r["day"].isoformat(),
                "event_type": r["event_type"],
                "total":      int(r["total"] or 0),
            }
            for r in daily_rows
        ],
        "per_tenant": [
            {
                "id":          r["id"],
                "name":        r["name"],
                "plan":        r["plan"],
                "status":      r["status"],
                "queries_30d": int(r["queries_30d"]),
                "ingests_30d": int(r["ingests_30d"]),
                "tokens_30d":  int(r["tokens_30d"]),
            }
            for r in per_tenant_rows
        ],
    }


# ── Salud por organización (super_admin) ─────────────────────────────────────

def _tenant_minio_usage(tenant_id: str) -> dict:
    """Huella en MinIO de un tenant (docs + adjuntos). Sync — llamar via to_thread."""
    from core.database import get_minio_client
    total, count = 0, 0
    try:
        client = get_minio_client()
        for obj in client.list_objects(settings.minio_bucket, prefix=f"{tenant_id}/", recursive=True):
            total += obj.size or 0
            count += 1
            if count >= 50_000:  # tope de cordura
                break
        return {"bytes": total, "objects": count}
    except Exception as exc:
        logger.warning("tenant_minio_usage_failed tenant=%s error=%s", tenant_id, exc)
        return {"bytes": None, "objects": None}


@router.get("/{tenant_id}/health")
async def get_tenant_health(
    tenant_id: str,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Salud de UNA organización: actividad del bot, colas, errores propios y
    huella de almacenamiento. Lo que es de la plataforma (backups, memoria,
    servicios) NO está acá — vive en /platform/system."""
    import asyncio as _aio
    from core.error_buffer import get_recent_errors

    async with get_pg_session(None) as session:
        exists = (await session.execute(
            text("SELECT 1 FROM tenants WHERE id = :id"), {"id": tenant_id})).scalar()
        if not exists:
            raise HTTPException(status_code=404, detail="Organización no encontrada.")

        activity = (await session.execute(text("""
            SELECT
                MAX(created_at) FILTER (WHERE event_type = 'query')   AS last_query_at,
                MAX(created_at) FILTER (WHERE event_type = 'ingest')  AS last_ingest_at,
                COALESCE(SUM(value) FILTER (WHERE event_type = 'query'
                    AND created_at >= NOW() - INTERVAL '7 days'), 0)  AS queries_7d,
                COALESCE(COUNT(*) FILTER (WHERE event_type = 'ingest'
                    AND created_at >= NOW() - INTERVAL '7 days'), 0)  AS ingests_7d,
                COALESCE(SUM(value) FILTER (WHERE event_type = 'llm_tokens'
                    AND created_at >= NOW() - INTERVAL '7 days'), 0)  AS tokens_7d
            FROM usage_events WHERE tenant_id = :id
        """), {"id": tenant_id})).mappings().fetchone()

        by_day = (await session.execute(text("""
            SELECT DATE(created_at) AS day, COALESCE(SUM(value), 0) AS queries
            FROM usage_events
            WHERE tenant_id = :id AND event_type = 'query'
              AND created_at >= NOW() - INTERVAL '7 days'
            GROUP BY DATE(created_at) ORDER BY day
        """), {"id": tenant_id})).mappings().all()

        schema_bytes = (await session.execute(text("""
            SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0)
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = :schema
        """), {"schema": f"tenant_{tenant_id}"})).scalar()

    # Colas y derivaciones de hoy — mismo criterio que /platform/ops.
    ops = {"waiting": 0, "attending": 0, "oldest_wait_min": 0, "handoffs_today": 0}
    docs_count = None
    try:
        async with get_pg_session(tenant_id) as session:
            row = (await session.execute(text("""
                SELECT
                    COUNT(*) FILTER (WHERE status = 'handoff_requested') AS waiting,
                    EXTRACT(EPOCH FROM (NOW() - MIN(handoff_requested_at)
                        FILTER (WHERE status = 'handoff_requested'))) AS oldest_wait_s,
                    COUNT(*) FILTER (WHERE status = 'human_attending') AS attending,
                    COUNT(*) FILTER (WHERE handoff_requested_at >= CURRENT_DATE) AS handoffs_today
                FROM conversaciones
            """))).mappings().fetchone()
            waiting = int(row["waiting"] or 0)
            ops = {
                "waiting": waiting,
                "attending": int(row["attending"] or 0),
                "oldest_wait_min": round((row["oldest_wait_s"] or 0) / 60, 1) if waiting else 0,
                "handoffs_today": int(row["handoffs_today"] or 0),
            }
            docs_count = (await session.execute(
                text("SELECT COUNT(*) FROM documentos"))).scalar()
    except Exception:
        pass  # schema a medio provisionar — devolvemos lo que haya

    errors, minio = await _aio.gather(
        _aio.to_thread(get_recent_errors, 30, None, tenant_id),
        _aio.to_thread(_tenant_minio_usage, tenant_id),
    )

    return _json_safe({
        "activity": {
            "last_query_at":  activity["last_query_at"].isoformat() if activity["last_query_at"] else None,
            "last_ingest_at": activity["last_ingest_at"].isoformat() if activity["last_ingest_at"] else None,
            "queries_7d": int(activity["queries_7d"]),
            "ingests_7d": int(activity["ingests_7d"]),
            "tokens_7d":  int(activity["tokens_7d"]),
            "queries_by_day": [
                {"day": r["day"].isoformat(), "queries": int(r["queries"])} for r in by_day
            ],
        },
        "ops": ops,
        "errors": errors,
        "storage": {
            "documents": int(docs_count) if docs_count is not None else None,
            "schema_bytes": int(schema_bytes or 0),
            "minio_bytes": minio["bytes"],
            "minio_objects": minio["objects"],
        },
    })
