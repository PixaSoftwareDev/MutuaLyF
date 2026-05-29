"""Celery tasks for operator panel handoff management.

check_operator_inactivity: runs every 60s.
Finds conversations in handoff_requested state that have been waiting
longer than handoff_config.inactivity_timeout_minutes.
Inserts a system alert message visible to the afiliado.
"""

import asyncio
import logging

from core.audit import fire_and_log
from workers.celery_app import app

logger = logging.getLogger(__name__)


@app.task(name="workers.handoff_tasks.check_operator_inactivity", queue="default")
def check_operator_inactivity() -> dict:
    """Rule 4: alert afiliado when no operator responds within timeout."""
    return asyncio.run(_run_inactivity_check())


async def _run_inactivity_check() -> dict:
    from core.database import get_worker_pg_session
    from sqlalchemy import text

    # Get all active tenants
    async with get_worker_pg_session(None) as session:
        result = await session.execute(
            text("SELECT id FROM tenants WHERE status = 'active'")
        )
        tenant_ids = [row[0] for row in result.fetchall()]

    total_alerts = 0
    for tenant_id in tenant_ids:
        try:
            alerts = await _check_tenant(tenant_id)
            total_alerts += alerts
        except Exception as exc:
            logger.error("inactivity_check_tenant_error tenant=%s error=%s", tenant_id, exc)

    logger.info("inactivity_check_done tenants=%d alerts=%d", len(tenant_ids), total_alerts)
    return {"tenants": len(tenant_ids), "alerts_sent": total_alerts}


async def _check_tenant(tenant_id: str) -> int:
    """Check one tenant for stale handoff requests. Returns count of alerts sent."""
    from core.database import get_worker_pg_session
    from sqlalchemy import text

    async with get_worker_pg_session(tenant_id) as session:
        # Get timeout from config
        config_result = await session.execute(
            text("SELECT inactivity_timeout_minutes FROM handoff_config LIMIT 1")
        )
        config_row = config_result.fetchone()
        timeout_minutes = config_row[0] if config_row else 15

        # Get message template
        msg_result = await session.execute(
            text("SELECT transition_messages->>'operator_inactive_alert' FROM handoff_config LIMIT 1")
        )
        msg_row = msg_result.fetchone()
        alert_msg = msg_row[0] if msg_row else "Seguís en cola. Un operador te atenderá a la brevedad."

        # Find conversations waiting too long without an alert in the last timeout period
        stale_result = await session.execute(text("""
            SELECT c.id
            FROM conversaciones c
            WHERE c.status = 'handoff_requested'
              AND c.updated_at < NOW() - INTERVAL '1 minute' * :timeout
              AND NOT EXISTS (
                SELECT 1 FROM mensajes m
                WHERE m.conversation_id = c.id
                  AND m.sender_type = 'system'
                  AND m.content = :alert_msg
                  AND m.created_at > NOW() - INTERVAL '1 minute' * :timeout
              )
        """), {"timeout": timeout_minutes, "alert_msg": alert_msg})
        stale_ids = [str(row[0]) for row in stale_result.fetchall()]

        for conv_id in stale_ids:
            await session.execute(text("""
                INSERT INTO mensajes (conversation_id, sender_type, content)
                VALUES (:cid, 'system', :msg)
            """), {"cid": conv_id, "msg": alert_msg})
            logger.info("inactivity_alert_sent conversation_id=%s tenant=%s", conv_id, tenant_id)

    return len(stale_ids)


# ── Auto-close stale bot_active conversations ─────────────────────────────────

@app.task(name="workers.handoff_tasks.close_stale_conversations", queue="default")
def close_stale_conversations() -> dict:
    """Close bot_active conversations with no activity in the last 30 minutes.

    A conversation that the user abandoned without closing stays bot_active
    forever otherwise, cluttering the operator panel.
    """
    return asyncio.run(_run_close_stale())


async def _run_close_stale() -> dict:
    from core.database import get_worker_pg_session
    from sqlalchemy import text

    async with get_worker_pg_session(None) as session:
        result = await session.execute(
            text("SELECT id FROM tenants WHERE status = 'active'")
        )
        tenant_ids = [row[0] for row in result.fetchall()]

    total = 0
    for tenant_id in tenant_ids:
        try:
            closed = await _close_stale_tenant(tenant_id)
            total += closed
        except Exception as exc:
            logger.error("close_stale_error tenant=%s error=%s", tenant_id, exc)

    logger.info("close_stale_done tenants=%d closed=%d", len(tenant_ids), total)
    return {"tenants": len(tenant_ids), "closed": total}


_TIMEOUT_MESSAGES = {
    "bot_active":        "La conversación se cerró por inactividad. Si necesitás ayuda, iniciá una nueva consulta.",
    "handoff_requested": "La derivación se canceló porque no hubo operador disponible. Podés volver a intentar más tarde.",
    "human_attending":   "La conversación se cerró por inactividad prolongada.",
}


async def _close_stale_tenant(tenant_id: str) -> int:
    """Cierra conversaciones inactivas por estado, con thresholds distintos:

    bot_active          → 30 min  (el bot respondio, user no volvio)
    handoff_requested   → 2 h     (espera de operador muy larga)
    human_attending     → 12 h    (operador atendio, user abandono el chat)

    Para cada cierre: UPDATE + INSERT mensaje system + publish SSE. Sin
    el publish el operador queda con UI stale (panel mostrando conv en
    "atendiendo" cuando en realidad fue cerrada por timeout).
    """
    from core.database import get_worker_pg_session
    from services.events import publish
    from sqlalchemy import text

    async def _close_batch(session, where_clause: str, from_status: str) -> list[str]:
        result = await session.execute(text(f"""
            UPDATE conversaciones
            SET status = 'closed', updated_at = NOW(), closed_at = NOW()
            WHERE {where_clause}
            RETURNING id
        """))
        ids = [str(r[0]) for r in result.fetchall()]
        if not ids:
            return []
        # Insertar mensaje system en cada conv cerrada
        msg = _TIMEOUT_MESSAGES[from_status]
        for cid in ids:
            await session.execute(text("""
                INSERT INTO mensajes (conversation_id, sender_type, content)
                VALUES (:cid, 'system', :msg)
            """), {"cid": cid, "msg": msg})
        return ids

    async with get_worker_pg_session(tenant_id) as session:
        bot_ids = await _close_batch(
            session,
            "status = 'bot_active' AND updated_at < NOW() - INTERVAL '30 minutes'",
            "bot_active",
        )
        handoff_ids = await _close_batch(
            session,
            "status = 'handoff_requested' AND updated_at < NOW() - INTERVAL '2 hours'",
            "handoff_requested",
        )
        # human_attending: usamos last user message, no updated_at, porque
        # updated_at se renueva con cada mensaje del operador y eso enmascararia
        # el abandono del afiliado.
        human_ids = await _close_batch(
            session,
            """status = 'human_attending'
               AND id IN (
                 SELECT c.id FROM conversaciones c
                 LEFT JOIN LATERAL (
                   SELECT MAX(created_at) AS last_user_msg
                   FROM mensajes
                   WHERE conversation_id = c.id AND sender_type = 'user'
                 ) m ON TRUE
                 WHERE c.status = 'human_attending'
                   AND COALESCE(m.last_user_msg, c.created_at) < NOW() - INTERVAL '12 hours'
               )""",
            "human_attending",
        )

    # Publish SSE despues del commit. Si el publish falla, el cierre ya quedo
    # persistido — el operador lo va a ver via polling de respaldo (~6s).
    for cid in (*bot_ids, *handoff_ids, *human_ids):
        fire_and_log(publish(tenant_id, "conversation_updated", {
            "conversation_id": cid,
            "status": "closed",
        }))

    total = len(bot_ids) + len(handoff_ids) + len(human_ids)
    if total:
        logger.info(
            "stale_conversations_closed tenant=%s bot=%d handoff=%d human=%d total=%d",
            tenant_id, len(bot_ids), len(handoff_ids), len(human_ids), total,
        )
    return total
