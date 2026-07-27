"""Tenant metrics dashboard — accesible por el admin del tenant.

Reúne, scopeado al tenant del usuario autenticado:
  - uso (consultas hoy/7d/30d/mes, ingestas, tokens LLM, serie diaria)
  - rendimiento (latencia p50/p95, cache hit rate, confianza promedio)
  - documentos por estado + almacenamiento + quality gate
  - conversaciones (por canal, derivaciones a humano, tiempo de resolución)
  - temas más consultados + consultas recientes
  - consumo del plan (cuota)

La variante de super-admin vive en tenants.py (GET /tenants/{id}/metrics);
esta toma el tenant_id del middleware de autenticación en vez del path param.
"""

import logging

from fastapi import APIRouter, Depends
from sqlalchemy import text

from core.database import get_pg_session
from core.security import CurrentUser, require_admin
from core.tenant import get_tenant_id

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/metrics")
async def get_metrics(
    days: int = 30,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Dashboard de métricas del tenant autenticado.

    `days` (7 | 30 | 90) define la ventana de los informes Asistente y Atención y
    de la serie de actividad. Se restringe a esos tres valores; cualquier otro
    cae a 30. Las cuotas del plan (mes en curso) y los KPIs de uso etiquetados
    (hoy / 7d / 30d) NO dependen de este parámetro.
    """
    days = days if days in (7, 30, 90) else 30
    prev_days = days * 2  # ventana previa para los chips "vs período anterior"
    # 1. Uso global (tabla usage_events, schema global) ─────────────────────────
    async with get_pg_session(None) as session:
        tenant_row = (await session.execute(
            text("SELECT plan, status, name FROM tenants WHERE id = :tid"),
            {"tid": tenant_id},
        )).mappings().fetchone()
        plan = tenant_row["plan"] if tenant_row else None

        usage_row = (await session.execute(text("""
            SELECT
                COALESCE(SUM(value) FILTER (WHERE event_type='query' AND created_at >= CURRENT_DATE),               0) AS queries_today,
                COALESCE(SUM(value) FILTER (WHERE event_type='query' AND created_at >= NOW() - INTERVAL '7 days'),  0) AS queries_7d,
                COALESCE(SUM(value) FILTER (WHERE event_type='query' AND created_at >= NOW() - INTERVAL '30 days'), 0) AS queries_30d,
                COALESCE(SUM(value) FILTER (WHERE event_type='query' AND created_at >= date_trunc('month', NOW())), 0) AS queries_this_month,
                COALESCE(SUM(value) FILTER (WHERE event_type='query' AND created_at >= date_trunc('month', NOW() - INTERVAL '1 month')
                                              AND created_at <  date_trunc('month', NOW())),                        0) AS queries_prev_month,
                COALESCE(COUNT(*) FILTER (WHERE event_type='ingest' AND created_at >= NOW() - INTERVAL '30 days'),  0) AS ingests_30d,
                COALESCE(SUM(value) FILTER (WHERE event_type='llm_tokens' AND created_at >= NOW() - INTERVAL '30 days'), 0) AS llm_tokens_30d,
                -- Ventana previa (60→30 días atrás) para los chips "vs período anterior"
                COALESCE(SUM(value) FILTER (WHERE event_type='query' AND created_at >= NOW() - INTERVAL '60 days'
                                              AND created_at <  NOW() - INTERVAL '30 days'),                        0) AS queries_prev_30d,
                COALESCE(SUM(value) FILTER (WHERE event_type='llm_tokens' AND created_at >= NOW() - INTERVAL '60 days'
                                              AND created_at <  NOW() - INTERVAL '30 days'),                        0) AS llm_tokens_prev_30d
            FROM usage_events WHERE tenant_id = :tid
        """), {"tid": tenant_id})).mappings().fetchone()

        # Series diarias de ingesta y tokens (para los informes Conocimiento y Plan)
        aux_daily_rows = (await session.execute(text("""
            SELECT DATE(created_at) AS day, event_type,
                   SUM(CASE WHEN event_type = 'ingest' THEN 1 ELSE value END)::bigint AS total
            FROM usage_events
            WHERE tenant_id = :tid AND event_type IN ('ingest', 'llm_tokens')
              AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at), event_type
            ORDER BY day
        """), {"tid": tenant_id})).mappings().all()
        ingest_daily = [{"day": r["day"].isoformat(), "total": int(r["total"])} for r in aux_daily_rows if r["event_type"] == "ingest"]
        tokens_daily = [{"day": r["day"].isoformat(), "total": int(r["total"])} for r in aux_daily_rows if r["event_type"] == "llm_tokens"]

        # Serie de actividad acotada a la ventana pedida (7/30/90).
        daily_rows = (await session.execute(text(f"""
            SELECT DATE(created_at) AS day, SUM(value)::int AS total
            FROM usage_events
            WHERE tenant_id = :tid AND event_type = 'query'
              AND created_at >= NOW() - INTERVAL '{days} days'
            GROUP BY DATE(created_at)
            ORDER BY day
        """), {"tid": tenant_id})).mappings().all()

    # 2. consultas_log del tenant (rendimiento + temas + recientes) ──────────────
    perf = {"latency_p50": None, "latency_p95": None, "cache_hit_rate": None, "total_logged": 0}
    recent_queries: list = []
    try:
        async with get_pg_session(tenant_id) as session:
            perf_row = (await session.execute(text(f"""
                SELECT
                    PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY latency_ms) AS p50,
                    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
                    AVG(CASE WHEN from_cache THEN 1.0 ELSE 0.0 END)          AS cache_hit_rate,
                    COUNT(*) AS total_logged
                FROM consultas_log
                WHERE created_at >= NOW() - INTERVAL '{days} days'
            """))).mappings().fetchone()
            if perf_row and int(perf_row["total_logged"] or 0) > 0:
                perf = {
                    "latency_p50":    int(perf_row["p50"]) if perf_row["p50"] else None,
                    "latency_p95":    int(perf_row["p95"]) if perf_row["p95"] else None,
                    "cache_hit_rate": round(float(perf_row["cache_hit_rate"] or 0), 3),
                    "total_logged":   int(perf_row["total_logged"]),
                }

            recent_queries = [
                {
                    "question_text":     r["question_text"],
                    "latency_ms":        r["latency_ms"],
                    "from_cache":        r["from_cache"],
                    "created_at":        r["created_at"].isoformat(),
                }
                for r in (await session.execute(text("""
                    SELECT question_text, latency_ms, from_cache, created_at
                    FROM consultas_log
                    ORDER BY created_at DESC LIMIT 10
                """))).mappings().all()
            ]
    except Exception as exc:
        logger.warning("metrics_log_failed tenant=%s err=%s", tenant_id, exc)

    # 3. Documentos + quality gate + usuarios ─────────────────────────────────────
    docs = {"total": 0, "ready": 0, "failed": 0, "processing": 0, "storage_bytes": 0}
    quality = {"passed": 0, "pending": 0, "skipped": 0}
    user_count = 0
    try:
        async with get_pg_session(tenant_id) as session:
            # Usuarios del tenant — para la cuota de usuarios del plan.
            user_count = int((await session.execute(
                text("SELECT COUNT(*) FROM usuarios")
            )).scalar() or 0)

            doc_row = (await session.execute(text("""
                SELECT
                    COUNT(*)::int                                     AS total,
                    COUNT(*) FILTER (WHERE status='ready')::int       AS ready,
                    COUNT(*) FILTER (WHERE status='failed')::int      AS failed,
                    COUNT(*) FILTER (WHERE status='processing')::int  AS processing,
                    COALESCE(SUM(size_bytes), 0)::bigint              AS storage_bytes
                FROM documentos
            """))).mappings().fetchone()
            if doc_row:
                docs = {k: int(doc_row[k]) for k in docs}

            for r in (await session.execute(text("""
                SELECT quality_gate_status, COUNT(*)::int AS cnt FROM documentos GROUP BY quality_gate_status
            """))).mappings().all():
                if r["quality_gate_status"] in quality:
                    quality[r["quality_gate_status"]] = r["cnt"]
    except Exception as exc:
        logger.warning("metrics_docs_failed tenant=%s err=%s", tenant_id, exc)

    # 4. Conversaciones — canal, derivaciones a humano, resolución (30 días) ──────
    conversations = {
        "total": 0, "widget": 0, "whatsapp": 0,
        "handoffs": 0, "handoff_rate": None, "bot_resolved_pct": None,
        "avg_resolution_seconds": None,
        "prev_total": 0, "avg_wait_seconds": None,
        "daily": [], "by_sector": [],
        "feedback": {"rated": 0, "happy": 0, "neutral": 0, "sad": 0,
                     "satisfaction_pct": None, "satisfaction_bot_pct": None,
                     "response_rate_pct": None, "pending_review": 0},
    }
    try:
        async with get_pg_session(tenant_id) as session:
            conv_row = (await session.execute(text(f"""
                SELECT
                    COUNT(*)::int                                                   AS total,
                    COUNT(*) FILTER (WHERE channel='widget')::int                   AS widget,
                    COUNT(*) FILTER (WHERE channel='whatsapp')::int                 AS whatsapp,
                    COUNT(*) FILTER (WHERE handoff_requested_at IS NOT NULL)::int    AS handoffs,
                    AVG(EXTRACT(EPOCH FROM (closed_at - created_at)))
                        FILTER (WHERE closed_at IS NOT NULL)                         AS avg_resolution_seconds
                FROM conversaciones
                WHERE created_at >= NOW() - INTERVAL '{days} days'
                  AND is_test IS NOT TRUE
            """))).mappings().fetchone()
            if conv_row and int(conv_row["total"] or 0) > 0:
                total = int(conv_row["total"])
                handoffs = int(conv_row["handoffs"])
                conversations.update({
                    "total": total,
                    "widget": int(conv_row["widget"]),
                    "whatsapp": int(conv_row["whatsapp"]),
                    "handoffs": handoffs,
                    "handoff_rate": round(handoffs / total, 3),
                    "bot_resolved_pct": round((1 - handoffs / total) * 100, 1),
                    "avg_resolution_seconds": int(conv_row["avg_resolution_seconds"]) if conv_row["avg_resolution_seconds"] else None,
                })

            # Ventana previa (2× la actual) para el chip "vs período anterior"
            prev_conv = (await session.execute(text(f"""
                SELECT COUNT(*)::int AS total FROM conversaciones
                WHERE created_at >= NOW() - INTERVAL '{prev_days} days'
                  AND created_at <  NOW() - INTERVAL '{days} days'
                  AND is_test IS NOT TRUE
            """))).scalar()
            conversations["prev_total"] = int(prev_conv or 0)

            # Espera promedio: del pedido de operador al primer mensaje humano
            wait_row = (await session.execute(text(f"""
                SELECT AVG(EXTRACT(EPOCH FROM (fo.created_at - c.handoff_requested_at))) AS avg_wait
                FROM conversaciones c
                JOIN LATERAL (
                    SELECT created_at FROM mensajes
                    WHERE conversation_id = c.id AND sender_type = 'operator'
                      AND created_at >= c.handoff_requested_at
                    ORDER BY created_at LIMIT 1
                ) fo ON TRUE
                WHERE c.handoff_requested_at IS NOT NULL
                  AND c.created_at >= NOW() - INTERVAL '{days} days'
                  AND c.is_test IS NOT TRUE
            """))).scalar()
            conversations["avg_wait_seconds"] = int(wait_row) if wait_row else None

            # Serie diaria (total + derivadas) para el gráfico del informe Atención
            conversations["daily"] = [
                {"day": r["day"].isoformat(), "total": int(r["total"]), "handoffs": int(r["handoffs"])}
                for r in (await session.execute(text(f"""
                    SELECT DATE(created_at) AS day, COUNT(*)::int AS total,
                           COUNT(*) FILTER (WHERE handoff_requested_at IS NOT NULL)::int AS handoffs
                    FROM conversaciones
                    WHERE created_at >= NOW() - INTERVAL '{days} days' AND is_test IS NOT TRUE
                    GROUP BY DATE(created_at) ORDER BY day
                """))).mappings().all()
            ]

            # Desglose por sector (top 8)
            conversations["by_sector"] = [
                {"nombre": r["nombre"], "total": int(r["total"])}
                for r in (await session.execute(text(f"""
                    SELECT COALESCE(s.nombre, 'Sin sector') AS nombre, COUNT(*)::int AS total
                    FROM conversaciones c
                    LEFT JOIN sectores s ON s.id = c.sector_id
                    WHERE c.created_at >= NOW() - INTERVAL '{days} days' AND c.is_test IS NOT TRUE
                    GROUP BY 1 ORDER BY 2 DESC LIMIT 8
                """))).mappings().all()
            ]

            # Satisfacción (caritas al cierre). is_test EXCLUIDO — el feedback de
            # Probar chat entra a la cola etiquetado pero no ensucia los números.
            # Se separa bot vs operador: la carita califica a quien resolvió.
            fb = (await session.execute(text(f"""
                SELECT COUNT(*)::int AS rated,
                       COUNT(*) FILTER (WHERE feedback_rating = 3)::int AS happy,
                       COUNT(*) FILTER (WHERE feedback_rating = 2)::int AS neutral,
                       COUNT(*) FILTER (WHERE feedback_rating = 1)::int AS sad,
                       COUNT(*) FILTER (WHERE feedback_rating = 3 AND assigned_operator_id IS NULL)::int  AS happy_bot,
                       COUNT(*) FILTER (WHERE feedback_rating IS NOT NULL AND assigned_operator_id IS NULL)::int AS rated_bot,
                       COUNT(*) FILTER (WHERE feedback_review_status = 'pending')::int AS pending_review,
                       (SELECT COUNT(*)::int FROM conversaciones
                        WHERE status = 'closed' AND is_test IS NOT TRUE
                          AND created_at >= NOW() - INTERVAL '{days} days') AS closed_total
                FROM conversaciones
                WHERE feedback_rating IS NOT NULL AND is_test IS NOT TRUE
                  AND feedback_at >= NOW() - INTERVAL '{days} days'
            """))).mappings().fetchone()
            rated = int(fb["rated"] or 0)
            rated_bot = int(fb["rated_bot"] or 0)
            closed_total = int(fb["closed_total"] or 0)
            conversations["feedback"] = {
                "rated": rated,
                "happy": int(fb["happy"] or 0),
                "neutral": int(fb["neutral"] or 0),
                "sad": int(fb["sad"] or 0),
                "satisfaction_pct": round(int(fb["happy"] or 0) / rated * 100, 1) if rated else None,
                "satisfaction_bot_pct": round(int(fb["happy_bot"] or 0) / rated_bot * 100, 1) if rated_bot else None,
                "response_rate_pct": round(rated / closed_total * 100, 1) if closed_total else None,
                "pending_review": int(fb["pending_review"] or 0),
            }
    except Exception as exc:
        logger.warning("metrics_conversations_failed tenant=%s err=%s", tenant_id, exc)

    # 5. Cuota del plan ───────────────────────────────────────────────────────────
    from core.plans import get_all_plans
    limits = (await get_all_plans()).get(plan, {}) if plan else {}
    q_used = int(usage_row["queries_this_month"])
    d_used = docs["total"] - docs["failed"]

    def quota_entry(used: int, limit: int) -> dict:
        return {"used": used, "limit": limit, "pct": round(used / limit * 100, 1) if limit and limit > 0 else None}

    # Variación mes vs mes anterior (para la tarjeta de consultas)
    prev = int(usage_row["queries_prev_month"])
    cur_month = int(usage_row["queries_this_month"])
    mom_pct = round((cur_month - prev) / prev * 100, 1) if prev > 0 else None

    return {
        "tenant": {"id": tenant_id, "name": tenant_row["name"] if tenant_row else None, "plan": plan, "limits": limits},
        "usage": {
            "queries_today":      int(usage_row["queries_today"]),
            "queries_7d":         int(usage_row["queries_7d"]),
            "queries_30d":        int(usage_row["queries_30d"]),
            "queries_this_month": cur_month,
            "queries_prev_month": prev,
            "mom_pct":            mom_pct,
            "ingests_30d":        int(usage_row["ingests_30d"]),
            "llm_tokens_30d":     int(usage_row["llm_tokens_30d"]),
            "queries_prev_30d":   int(usage_row["queries_prev_30d"]),
            "llm_tokens_prev_30d": int(usage_row["llm_tokens_prev_30d"]),
            "daily":              [{"day": r["day"].isoformat(), "total": r["total"]} for r in daily_rows],
            "ingest_daily":       ingest_daily,
            "tokens_daily":       tokens_daily,
        },
        "performance":   perf,
        "docs":          docs,
        "quality":       quality,
        "conversations": conversations,
        "recent_queries": recent_queries,
        "quota": {
            "queries_month": quota_entry(q_used, limits.get("queries_month", -1)),
            "documents":     quota_entry(d_used, limits.get("documents", -1)),
            "users":         quota_entry(user_count, limits.get("users", -1)),
        },
    }
