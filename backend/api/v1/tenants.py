"""Tenant management endpoints — super-admin panel.

All endpoints require role=super_admin except /widget-token (admin).
"""

import hashlib
import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import text

import time

from core.config import settings
from core.database import get_pg_session
from core.prometheus import get_system_metrics
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

        # Auto-assign system templates (all plans get them for free)
        from api.v1.system_prompts import auto_assign_system_templates
        await auto_assign_system_templates(payload.id)

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


# ── Bot config (admin endpoint — read/update from settings page) ─────────────

class BotConfigResponse(BaseModel):
    bot_description: str | None
    bot_scope: str | None
    min_retrieval_score: float
    greeting_message: str | None
    prompt_query: str | None
    prompt_quality_gate: str | None
    prompt_cluster_label: str | None


class BotConfigUpdate(BaseModel):
    bot_description: str | None = None
    bot_scope: str | None = None
    min_retrieval_score: float | None = None
    greeting_message: str | None = None
    prompt_query: str | None = None
    prompt_quality_gate: str | None = None
    prompt_cluster_label: str | None = None


@router.get("/{tenant_id}/bot-config", response_model=BotConfigResponse)
async def get_bot_config(
    tenant_id: str,
    current_user: CurrentUser = Depends(require_admin),
):
    """Return bot configuration for this tenant."""
    if current_user.role.value != "super_admin" and current_user.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Cannot read config for another tenant")

    async with get_pg_session() as session:
        result = await session.execute(
            text("SELECT bot_description, bot_scope, min_retrieval_score, greeting_message, prompt_query, prompt_quality_gate, prompt_cluster_label FROM tenants WHERE id = :tid"),
            {"tid": tenant_id},
        )
        row = result.mappings().fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="Tenant not found")

    return BotConfigResponse(
        bot_description=row["bot_description"],
        bot_scope=row["bot_scope"],
        min_retrieval_score=float(row["min_retrieval_score"]) if row["min_retrieval_score"] is not None else 0.45,
        greeting_message=row["greeting_message"],
        prompt_query=row["prompt_query"],
        prompt_quality_gate=row["prompt_quality_gate"],
        prompt_cluster_label=row["prompt_cluster_label"],
    )


@router.patch("/{tenant_id}/bot-config", response_model=BotConfigResponse)
async def update_bot_config(
    tenant_id: str,
    body: BotConfigUpdate,
    request: Request,
    current_user: CurrentUser = Depends(require_admin),
):
    """Update bot description, scope, minimum relevance threshold and greeting message."""
    if current_user.role.value != "super_admin" and current_user.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Cannot update config for another tenant")

    if body.min_retrieval_score is not None and not (0.0 <= body.min_retrieval_score <= 1.0):
        raise HTTPException(status_code=422, detail="min_retrieval_score must be between 0.0 and 1.0")

    updates: list[str] = []
    params: dict = {"tid": tenant_id}

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
    if body.prompt_query is not None:
        updates.append("prompt_query = :prompt_query")
        params["prompt_query"] = body.prompt_query or None
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
        actor_email=None,
        actor_role=current_user.role.value,
        action="config.bot_config_update",
        detail={"fields": list(changed.keys())},
        request=request,
    ))

    return await get_bot_config(tenant_id, current_user)


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
        expires_in_days=settings.jwt_widget_expire_days,
        tenant_id=tenant_id,
    )


# ── Create / replace admin for an existing tenant (super_admin only) ──────────

class AdminCreate(BaseModel):
    email: str
    name: str
    password: str


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
