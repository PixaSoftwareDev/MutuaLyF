"""Pipeline entrante de WhatsApp: espejo de widget_conversation.send_message.

Un mensaje de WhatsApp entra por el webhook (api/v1/channels.py), se resuelve
el tenant por phone_number_id y termina acá. La conversación vive en la MISMA
tabla `conversaciones` del tenant, con channel='whatsapp' y external_id=wa_id
(el teléfono del cliente). Operadores la ven en la bandeja como cualquier otra.

Diferencias con el widget (no hay botones en WhatsApp):
  - La oferta de derivación se confirma respondiendo "OPERADOR" (o "sí").
  - El nombre del afiliado sale del perfil de WhatsApp; sin formulario de DNI.
  - Cada respuesta del bot/sistema se reenvía por la Graph API.
"""

import logging
import re
import uuid

from sqlalchemy import text

from core.database import get_pg_session, get_redis_cache
from services.events import publish as publish_event
from services.handoff import (
    ConvStatus, HandoffTrigger,
    evaluate_handoff, request_handoff, get_default_sector_id,
)
from services.whatsapp import WhatsAppAccount, send_text

logger = logging.getLogger(__name__)

# Respuestas que confirman la oferta de derivación pendiente. Cortas a
# propósito: solo confirmaciones inequívocas; cualquier otra cosa sigue al bot.
_CONFIRM_RE = re.compile(
    r"^\s*(operador|operadora|si|sí|dale|ok|quiero hablar con (un |una )?(operador|persona|humano))\s*[.!]*\s*$",
    re.IGNORECASE,
)

_DEDUP_TTL_S = 24 * 3600


async def _already_processed(message_id: str) -> bool:
    """Meta reintenta webhooks ante timeouts → dedup por wamid en Redis."""
    try:
        redis = get_redis_cache()
        added = await redis.set(f"wa:msg:{message_id}", "1", nx=True, ex=_DEDUP_TTL_S)
        return not bool(added)
    except Exception:
        # Redis caído: preferimos procesar (posible duplicado) a perder mensajes.
        return False


async def _insert_message(tenant_id: str, conversation_id: str, sender_type: str,
                          content: str, is_handoff_offer: bool = False) -> str:
    msg_id = str(uuid.uuid4())
    async with get_pg_session(tenant_id) as session:
        await session.execute(text("""
            INSERT INTO mensajes (id, conversation_id, sender_type, content, is_handoff_offer)
            VALUES (:id, :cid, :stype, :content, :offer)
        """), {"id": msg_id, "cid": conversation_id, "stype": sender_type,
               "content": content, "offer": is_handoff_offer})
        await session.execute(
            text("UPDATE conversaciones SET updated_at = NOW() WHERE id = :id"),
            {"id": conversation_id},
        )
    await publish_event(tenant_id, "new_message", {"conversation_id": conversation_id})
    return msg_id


async def _get_or_create_conversation(tenant_id: str, wa_id: str, profile_name: str | None) -> dict:
    """Conversación abierta para este número, o una nueva con el sector default."""
    async with get_pg_session(tenant_id) as session:
        # Advisory lock por wa_id: Meta puede entregar 2 webhooks en paralelo.
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:sid, 0))"),
            {"sid": f"wa:{wa_id}"},
        )
        row = (await session.execute(text("""
            SELECT id, status, sector_id FROM conversaciones
            WHERE channel = 'whatsapp' AND external_id = :wa AND status != 'closed'
            ORDER BY created_at DESC LIMIT 1
        """), {"wa": wa_id})).mappings().fetchone()
        if row:
            return {
                "id": str(row["id"]),
                "status": row["status"],
                "sector_id": str(row["sector_id"]) if row["sector_id"] else None,
                "created": False,
            }

    sector_id = await get_default_sector_id(tenant_id)
    conv_id = str(uuid.uuid4())
    async with get_pg_session(tenant_id) as session:
        await session.execute(text("""
            INSERT INTO conversaciones
              (id, widget_session_id, channel, external_id, sector_id, afiliado_nombre)
            VALUES (:id, :sid, 'whatsapp', :wa, :sector_id, :nombre)
        """), {
            "id": conv_id,
            "sid": f"wa:{wa_id}",
            "wa": wa_id,
            "sector_id": sector_id,
            "nombre": profile_name,
        })
    logger.info("whatsapp_conversation_started id=%s tenant=%s", conv_id, tenant_id)
    return {"id": conv_id, "status": ConvStatus.BOT_ACTIVE, "sector_id": sector_id, "created": True}


async def _has_pending_offer(tenant_id: str, conversation_id: str) -> bool:
    """¿El último mensaje no-user de la conversación fue una oferta de derivación?"""
    async with get_pg_session(tenant_id) as session:
        row = (await session.execute(text("""
            SELECT is_handoff_offer FROM mensajes
            WHERE conversation_id = :cid AND sender_type IN ('bot', 'system')
            ORDER BY created_at DESC LIMIT 1
        """), {"cid": conversation_id})).fetchone()
    return bool(row and row[0])


async def process_incoming_message(account: WhatsAppAccount, value: dict, message: dict) -> None:
    """Procesa UN mensaje del payload del webhook. Nunca lanza (se ejecuta en
    background): cualquier error se loguea y se descarta el mensaje."""
    tenant_id = account.tenant_id
    try:
        message_id = message.get("id") or ""
        if message_id and await _already_processed(message_id):
            return

        wa_id = message.get("from")
        if not wa_id:
            return

        contacts = value.get("contacts") or []
        profile_name = None
        if contacts:
            profile_name = (contacts[0].get("profile") or {}).get("name")

        # Solo texto en el MVP. Media (imágenes/audio) es fase siguiente:
        # avisamos al cliente en vez de ignorar en silencio.
        if message.get("type") != "text":
            conv = await _get_or_create_conversation(tenant_id, wa_id, profile_name)
            note = "[El cliente envió un adjunto no soportado todavía por este canal]"
            await _insert_message(tenant_id, conv["id"], "user", note)
            await send_text(account, wa_id,
                            "Por ahora solo puedo leer mensajes de texto. ¿Me escribís tu consulta?")
            return

        content = ((message.get("text") or {}).get("body") or "").strip()
        if not content:
            return
        content = content[:2000]  # mismo cap que el widget

        conv = await _get_or_create_conversation(tenant_id, wa_id, profile_name)
        conv_id = conv["id"]
        conv_status = conv["status"]
        conv_sector_id = conv["sector_id"]

        # ¿Estaba pendiente una oferta de derivación y el cliente confirma?
        # Se evalúa ANTES de insertar el mensaje para que la oferta siga siendo
        # el último mensaje no-user al momento del chequeo.
        confirm_handoff = (
            conv_status == ConvStatus.BOT_ACTIVE
            and _CONFIRM_RE.match(content) is not None
            and await _has_pending_offer(tenant_id, conv_id)
        )

        await _insert_message(tenant_id, conv_id, "user", content)

        if conv_status == ConvStatus.HUMAN_ATTENDING:
            return  # el operador lo ve por la bandeja y responde desde ahí

        if conv_status == ConvStatus.HANDOFF_REQUESTED:
            note = "Tu consulta está en cola. Un operador te atenderá pronto."
            await _insert_message(tenant_id, conv_id, "system", note)
            await send_text(account, wa_id, note)
            return

        if confirm_handoff:
            from services.handoff import _get_handoff_config
            config = await _get_handoff_config(tenant_id)
            messages = config["transition_messages"]
            msg = (messages.get("handoff_confirmed")
                   or "Listo, tu solicitud fue recibida. Un operador te atenderá en breve.")
            await request_handoff(conv_id, tenant_id, msg)
            await send_text(account, wa_id, msg)
            return

        # ── Bot activo: mismo flujo que el widget ────────────────────────────
        from services.orchestrator import handle_query
        from core.plan_limits import enforce_query_limit
        from fastapi import HTTPException

        async with get_pg_session(tenant_id) as session:
            hist = (await session.execute(text("""
                SELECT sender_type, content FROM mensajes
                WHERE conversation_id = :cid AND sender_type IN ('user', 'bot')
                ORDER BY created_at DESC LIMIT 20
            """), {"cid": conv_id})).mappings().fetchall()
        history_rows = list(reversed(hist))
        conversation_history = [
            (r["sender_type"], r["content"])
            for r in history_rows
            if r["content"] != content or r["sender_type"] != "user"
        ]

        try:
            await enforce_query_limit(tenant_id)
            over_quota = False
        except HTTPException:
            over_quota = True

        if over_quota:
            bot_answer = ("El asistente no está disponible en este momento. "
                          "Por favor, comunicate directamente con la organización.")
            sources = []
        else:
            try:
                rag_result = await handle_query(
                    question=content,
                    tenant_id=tenant_id,
                    user_id=None,
                    language="es",
                    conversation_history=conversation_history,
                )
                bot_answer = rag_result["answer"]
                sources = rag_result.get("sources", [])
            except Exception as exc:
                logger.error("whatsapp_rag_failed conversation_id=%s error=%s", conv_id, exc)
                bot_answer = "Lo siento, ocurrió un error. Intentá de nuevo en un momento."
                sources = []

        await _insert_message(tenant_id, conv_id, "bot", bot_answer)
        await send_text(account, wa_id, bot_answer)

        # Evaluación de derivación — misma regla que el widget. En WhatsApp la
        # oferta es texto plano y se confirma respondiendo "OPERADOR".
        signal = await evaluate_handoff(
            conversation_id=conv_id,
            tenant_id=tenant_id,
            user_message=content,
            sources=sources,
            bot_answer=bot_answer,
        )
        if signal.trigger != HandoffTrigger.NONE:
            from services.handoff import has_online_operators, build_no_operators_message, _get_handoff_config
            if await has_online_operators(tenant_id, conv_sector_id):
                offer = f"{signal.offer_message}\n\nRespondé *OPERADOR* para hablar con una persona."
                await _insert_message(tenant_id, conv_id, "system", offer, is_handoff_offer=True)
                await send_text(account, wa_id, offer)
            else:
                cfg = await _get_handoff_config(tenant_id)
                msg = build_no_operators_message(cfg)
                await _insert_message(tenant_id, conv_id, "system", msg)
                await send_text(account, wa_id, msg)

    except Exception:
        logger.exception("whatsapp_inbound_error tenant=%s", tenant_id)
