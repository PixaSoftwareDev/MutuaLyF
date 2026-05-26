"""Tenant management endpoints — super-admin panel.

All endpoints require role=super_admin except /widget-token (admin).
"""

import hashlib
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field
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
        raise HTTPException(status_code=500, detail=f"Provisioning failed: {err[:300]}")


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
        await session.execute(text("DELETE FROM sectores"))

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

    import asyncio
    from core.audit import record as audit
    changed = {k: v for k, v in body.model_dump().items() if v is not None}
    asyncio.ensure_future(audit(
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

    import asyncio
    from core.audit import record as audit
    asyncio.ensure_future(audit(
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


# ── Create / replace admin for an existing tenant (super_admin only) ──────────

class AdminCreate(BaseModel):
    email: EmailStr
    name: str = Field(..., min_length=1, max_length=120)
    password: str = Field(..., min_length=8, max_length=200)


@router.post("/{tenant_id}/admin", status_code=201)
async def create_tenant_admin(
    tenant_id: str,
    body: AdminCreate,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Create (or replace) the admin user for a tenant. Super-admin only."""
    import uuid
    from core.security import hash_password

    async with get_pg_session(tenant_id) as session:
        existing = await session.execute(
            text("SELECT id FROM usuarios WHERE email = :email"),
            {"email": body.email.lower().strip()},
        )
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=409, detail="Ya existe un usuario con ese email en este tenant")

        new_id = str(uuid.uuid4())
        await session.execute(text("""
            INSERT INTO usuarios (id, email, name, hashed_password, role, is_active)
            VALUES (:id, :email, :name, :pwd, 'admin', true)
        """), {
            "id": new_id,
            "email": body.email.lower().strip(),
            "name": body.name.strip(),
            "pwd": hash_password(body.password),
        })

    logger.info("tenant_admin_created tenant=%s email=%s by=%s", tenant_id, body.email, current_user.user_id)
    return {"id": new_id, "email": body.email.lower().strip(), "name": body.name.strip(), "role": "admin", "tenant_id": tenant_id}


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
                COALESCE(SUM(ue.value) FILTER (WHERE ue.event_type = 'ingest'), 0) AS ingests_month
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
                COALESCE(SUM(value) FILTER (WHERE event_type='ingest' AND created_at >= NOW() - INTERVAL '30 days'),      0) AS ingests_30d,
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
    d_used = docs["total"]

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

@router.get("/platform/system")
async def get_platform_system(
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Infrastructure health from Prometheus: PostgreSQL, Redis, HTTP, Groq, application counters."""
    now = int(time.time())
    return await get_system_metrics(now)


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
                COALESCE(SUM(ue.value) FILTER (WHERE ue.event_type = 'ingest'), 0) AS ingests_30d,
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
