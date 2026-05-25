"""Celery tasks for operator panel handoff management.

check_operator_inactivity: runs every 60s.
Finds conversations in handoff_requested state that have been waiting
longer than handoff_config.inactivity_timeout_minutes.
Inserts a system alert message visible to the afiliado.
"""

import asyncio
import logging

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


async def _close_stale_tenant(tenant_id: str) -> int:
    """Cierra conversaciones inactivas por estado, con thresholds distintos:

    bot_active          → 30 min  (el bot respondio, user no volvio)
    handoff_requested   → 2 h     (espera de operador muy larga)
    human_attending     → 12 h    (operador atendio, user abandono el chat)

    Sin esto, conversaciones quedan abiertas para siempre y el operador
    puede mandar mensajes a 'sesiones fantasma' (afiliado ya cerro el browser).
    """
    from core.database import get_worker_pg_session
    from sqlalchemy import text

    async with get_worker_pg_session(tenant_id) as session:
        # bot_active sin actividad > 30 min
        result = await session.execute(text("""
            UPDATE conversaciones
            SET status = 'closed', updated_at = NOW(), closed_at = NOW()
            WHERE status = 'bot_active'
              AND updated_at < NOW() - INTERVAL '30 minutes'
            RETURNING id
        """))
        bot_closed = result.fetchall()

        # handoff_requested sin operador aceptando > 2 h
        result = await session.execute(text("""
            UPDATE conversaciones
            SET status = 'closed', updated_at = NOW(), closed_at = NOW()
            WHERE status = 'handoff_requested'
              AND updated_at < NOW() - INTERVAL '2 hours'
            RETURNING id
        """))
        handoff_closed = result.fetchall()

        # human_attending sin mensajes nuevos del usuario > 12 h
        # (la conversacion sigue tecnicamente activa pero el afiliado ya
        # cerro el browser — el operador no debe seguir respondiendo).
        # Usamos LAST(mensaje del user), no updated_at, porque updated_at
        # se renueva con cada mensaje del operador y eso enmascararia el abandono.
        result = await session.execute(text("""
            UPDATE conversaciones
            SET status = 'closed', updated_at = NOW(), closed_at = NOW()
            WHERE status = 'human_attending'
              AND id IN (
                SELECT c.id FROM conversaciones c
                LEFT JOIN LATERAL (
                  SELECT MAX(created_at) AS last_user_msg
                  FROM mensajes
                  WHERE conversation_id = c.id AND sender_type = 'user'
                ) m ON TRUE
                WHERE c.status = 'human_attending'
                  AND COALESCE(m.last_user_msg, c.created_at) < NOW() - INTERVAL '12 hours'
              )
            RETURNING id
        """))
        human_closed = result.fetchall()

    total = len(bot_closed) + len(handoff_closed) + len(human_closed)
    if total:
        logger.info(
            "stale_conversations_closed tenant=%s bot=%d handoff=%d human=%d total=%d",
            tenant_id, len(bot_closed), len(handoff_closed), len(human_closed), total,
        )
    return total
