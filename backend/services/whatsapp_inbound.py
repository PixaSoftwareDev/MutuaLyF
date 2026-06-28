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
from services.whatsapp import (
    WhatsAppAccount, send_text, send_typing_indicator,
    send_interactive_buttons, send_interactive_list,
)

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


async def _find_open_conversation(tenant_id: str, wa_id: str) -> dict | None:
    """Conversación abierta para este número, o None. Toma un advisory lock por
    wa_id (Meta puede entregar 2 webhooks en paralelo) durante el chequeo."""
    async with get_pg_session(tenant_id) as session:
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:sid, 0))"),
            {"sid": f"wa:{wa_id}"},
        )
        row = (await session.execute(text("""
            SELECT id, status, sector_id FROM conversaciones
            WHERE channel = 'whatsapp' AND external_id = :wa AND status != 'closed'
            ORDER BY created_at DESC LIMIT 1
        """), {"wa": wa_id})).mappings().fetchone()
    if not row:
        return None
    return {
        "id": str(row["id"]),
        "status": row["status"],
        "sector_id": str(row["sector_id"]) if row["sector_id"] else None,
        "created": False,
    }


async def _create_conversation(tenant_id: str, wa_id: str, profile_name: str | None,
                               sector_id: str | None) -> dict:
    """Crea la conversación de WhatsApp en el sector dado.

    Toma el advisory lock por wa_id y re-chequea la existencia DENTRO de la misma
    transacción que el INSERT. Meta puede entregar 2 webhooks del mismo número en
    paralelo: sin esto, ambos pasaban el find inicial (cuyo lock ya se liberó) y
    creaban conversaciones DUPLICADAS. Acá la creación es atómica — el segundo
    webhook ve la conversación que creó el primero y la reutiliza.
    """
    conv_id = str(uuid.uuid4())
    async with get_pg_session(tenant_id) as session:
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:sid, 0))"),
            {"sid": f"wa:{wa_id}"},
        )
        existing = (await session.execute(text("""
            SELECT id, status, sector_id FROM conversaciones
            WHERE channel = 'whatsapp' AND external_id = :wa AND status != 'closed'
            ORDER BY created_at DESC LIMIT 1
        """), {"wa": wa_id})).mappings().fetchone()
        if existing:
            logger.info("whatsapp_conversation_exists_skip_create wa=%s tenant=%s", wa_id, tenant_id)
            return {
                "id": str(existing["id"]),
                "status": existing["status"],
                "sector_id": str(existing["sector_id"]) if existing["sector_id"] else None,
                "created": False,
            }
        await session.execute(text("""
            INSERT INTO conversaciones
              (id, widget_session_id, channel, external_id, sector_id, afiliado_nombre)
            VALUES (:id, :sid, 'whatsapp', :wa, :sector_id, :nombre)
        """), {
            "id": conv_id, "sid": f"wa:{wa_id}", "wa": wa_id,
            "sector_id": sector_id, "nombre": profile_name,
        })
    logger.info("whatsapp_conversation_started id=%s tenant=%s sector=%s", conv_id, tenant_id, sector_id)
    return {"id": conv_id, "status": ConvStatus.BOT_ACTIVE, "sector_id": sector_id, "created": True}


# ── Onboarding: elegir área al primer contacto (espejo del menú del widget) ───

async def _list_active_sectors(tenant_id: str) -> list[dict]:
    """Sectores activos del tenant — misma fuente que /widget/sectors del web."""
    async with get_pg_session(tenant_id) as session:
        rows = (await session.execute(text("""
            SELECT id, nombre, descripcion FROM sectores
            WHERE is_active = TRUE
            ORDER BY is_default DESC, nombre ASC
        """))).mappings().all()
    return [dict(r) for r in rows]


async def _get_greeting(tenant_id: str) -> str | None:
    async with get_pg_session() as session:
        row = (await session.execute(
            text("SELECT greeting_message FROM tenants WHERE id = :tid"), {"tid": tenant_id},
        )).mappings().fetchone()
    return row["greeting_message"] if row else None


def _extract_interactive_id(message: dict) -> str | None:
    """Id del botón/fila que tocó el afiliado (interactive reply de Meta)."""
    inter = message.get("interactive") or {}
    if inter.get("type") == "list_reply":
        return (inter.get("list_reply") or {}).get("id")
    if inter.get("type") == "button_reply":
        return (inter.get("button_reply") or {}).get("id")
    return None


# Flag en Redis: ya le mandamos el menú a este número y todavía no eligió. Evita
# re-mandar el menú en loop si el afiliado lo ignora y escribe texto.
_MENU_TTL_S = 3600


async def _menu_flag_set(tenant_id: str, wa_id: str) -> bool:
    try:
        return bool(await get_redis_cache().get(f"wa:menu:{tenant_id}:{wa_id}"))
    except Exception:
        # Redis caído: asumir que el menú YA se ofreció (fail-open). Si devolviera
        # False, la rama del menú —que NO crea conversación— se repetiría en cada
        # mensaje y el afiliado quedaría atrapado recibiendo el menú en loop, sin
        # llegar al bot. Asumiendo True, cae a crear la conversación en el sector
        # por defecto y lo atiende: sin menú, pero sin loop.
        return True


async def _set_menu_flag(tenant_id: str, wa_id: str) -> None:
    try:
        await get_redis_cache().set(f"wa:menu:{tenant_id}:{wa_id}", "1", ex=_MENU_TTL_S)
    except Exception:
        pass


async def _clear_menu_flag(tenant_id: str, wa_id: str) -> None:
    try:
        await get_redis_cache().delete(f"wa:menu:{tenant_id}:{wa_id}")
    except Exception:
        pass


async def _send_sector_menu(account: WhatsAppAccount, wa_id: str,
                            sectors: list[dict], greeting: str | None) -> None:
    """Saludo + menú de áreas. Botones si son ≤3, lista desplegable si son más."""
    intro = (greeting or "").strip() or "¡Hola! 👋 ¿Sobre qué tema querés consultar?"
    body = f"{intro}\n\nElegí una opción para empezar 👇"
    if len(sectors) <= 3:
        buttons = [{"id": f"sector:{s['id']}", "title": s["nombre"]} for s in sectors]
        await send_interactive_buttons(account, wa_id, body, buttons)
    else:
        rows = [{"id": f"sector:{s['id']}", "title": s["nombre"],
                 "description": s.get("descripcion") or ""} for s in sectors]
        await send_interactive_list(account, wa_id, body, "Ver áreas", rows)


async def _onboard_sector(account: WhatsAppAccount, tenant_id: str, wa_id: str,
                          profile_name: str | None, selected_id: str | None,
                          has_text: bool) -> dict:
    """Primer contacto sin conversación: ofrece el menú de áreas o resuelve la
    elección. Devuelve {done: bool, conv: dict|None}.
      - done=True  → ya se respondió (menú enviado o sector confirmado); cortar.
      - done=False → se creó la conversación con el default; seguir con el texto.
    """
    sectors = await _list_active_sectors(tenant_id)

    # ¿Eligió un área de la lista/botones?
    if selected_id and selected_id.startswith("sector:"):
        sid = selected_id.split("sector:", 1)[1]
        match = next((s for s in sectors if str(s["id"]) == sid), None)
        if match:
            conv = await _create_conversation(tenant_id, wa_id, profile_name, str(match["id"]))
            await _clear_menu_flag(tenant_id, wa_id)
            ack = f"¡Listo! 👍 Te ayudo con *{match['nombre']}*. Contame, ¿qué necesitás?"
            await _insert_message(tenant_id, conv["id"], "system", ack)
            await send_text(account, wa_id, ack)
            return {"done": True, "conv": conv}

    # No eligió. Si hay más de un área y no le mostramos el menú aún → mostrarlo.
    if len(sectors) > 1 and not await _menu_flag_set(tenant_id, wa_id):
        await _send_sector_menu(account, wa_id, sectors, await _get_greeting(tenant_id))
        await _set_menu_flag(tenant_id, wa_id)
        return {"done": True, "conv": None}

    # 0/1 área, o ya ignoró el menú una vez → atender en el sector por defecto.
    default_sid = await get_default_sector_id(tenant_id)
    conv = await _create_conversation(tenant_id, wa_id, profile_name, default_sid)
    await _clear_menu_flag(tenant_id, wa_id)
    return {"done": False, "conv": conv}


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

        msg_type = message.get("type")
        selected_id = _extract_interactive_id(message) if msg_type == "interactive" else None
        content = ""
        if msg_type == "text":
            content = ((message.get("text") or {}).get("body") or "").strip()[:2000]

        conv = await _find_open_conversation(tenant_id, wa_id)

        # Primer contacto (sin conversación): ofrecer el menú de áreas o resolver
        # la elección. Si done=True ya respondimos (menú enviado o sector elegido).
        if conv is None:
            result = await _onboard_sector(
                account, tenant_id, wa_id, profile_name, selected_id, has_text=bool(content),
            )
            if result["done"]:
                return
            conv = result["conv"]  # se creó en el sector por defecto; seguimos con el texto
        elif selected_id is not None:
            # Un toque a un menú viejo con la conversación ya abierta no aplica.
            return

        # Media entrante (imagen/PDF): descargar de Meta, guardar en MinIO reusando
        # la infra de adjuntos e insertar como mensaje del cliente. El bot no "lee"
        # el archivo (es texto) → acusa recibo y deja que lo revise un operador.
        if msg_type != "text":
            media = message.get("image") or message.get("document")
            if msg_type in ("image", "document") and media and media.get("id"):
                from services.whatsapp import download_media
                from api.v1.attachments import (
                    store_attachment_bytes, _insert_attachment_message, _publish_event,
                )
                binary = await download_media(account, media["id"])
                meta = await store_attachment_bytes(
                    binary, media.get("filename") or (msg_type + ".jpg"), tenant_id, conv["id"],
                ) if binary else None
                if meta:
                    await _insert_attachment_message(tenant_id, conv["id"], "user", meta)
                    await _publish_event(tenant_id, "new_message", {"conversation_id": conv["id"]})
                    if conv["status"] == ConvStatus.HUMAN_ATTENDING:
                        return  # el operador lo ve en la bandeja y responde desde ahí
                    await send_text(account, wa_id,
                                    "Recibí tu archivo 📎. Si querés que un agente lo revise, escribí *OPERADOR*.")
                    return
            # Audio, video, sticker, ubicación o media que no validó (no es imagen/PDF)
            note = "[El cliente envió un adjunto no soportado todavía por este canal]"
            await _insert_message(tenant_id, conv["id"], "user", note)
            await send_text(account, wa_id,
                            "Por ahora puedo recibir texto, imágenes y PDF. ¿Me escribís tu consulta?")
            return

        if not content:
            return

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
        # "Escribiendo…" + leído (✓✓): best-effort, fire-and-forget. Se dispara
        # acá —apenas sabemos que el bot VA a responder (no en derivaciones)— y
        # corre en paralelo al RAG/LLM, así no suma latencia a la respuesta.
        import asyncio
        _typing = asyncio.ensure_future(send_typing_indicator(account, message_id))

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

        # Evaluación de derivación — misma regla que el widget. Se evalúa ANTES de
        # enviar el bot_answer: si se va a mostrar la oferta de operador, el genérico
        # ("no pude / fuera de mi área") es redundante con la oferta y no se envía.
        # En WhatsApp la oferta es texto plano y se confirma respondiendo "OPERADOR".
        signal = await evaluate_handoff(
            conversation_id=conv_id,
            tenant_id=tenant_id,
            user_message=content,
            sources=sources,
            bot_answer=bot_answer,
        )
        from services.handoff import has_online_operators, build_no_operators_message, _get_handoff_config, _mark_offer_pending
        offer_with_operators = (
            signal.trigger != HandoffTrigger.NONE
            and await has_online_operators(tenant_id, conv_sector_id)
        )
        if offer_with_operators:
            # Oferta de operador: el bot_answer genérico es redundante → no se envía.
            offer = f"{signal.offer_message}\n\nRespondé *OPERADOR* para hablar con una persona."
            await _insert_message(tenant_id, conv_id, "system", offer, is_handoff_offer=True)
            await send_text(account, wa_id, offer)
            await _mark_offer_pending(conv_id)  # cooldown 90s SOLO al mostrar el cartel
        else:
            await _insert_message(tenant_id, conv_id, "bot", bot_answer)
            await send_text(account, wa_id, bot_answer)
            if signal.trigger != HandoffTrigger.NONE:
                # Deriva pero sin operadores: el genérico aporta contexto al aviso.
                cfg = await _get_handoff_config(tenant_id)
                msg = build_no_operators_message(cfg)
                await _insert_message(tenant_id, conv_id, "system", msg)
                await send_text(account, wa_id, msg)

    except Exception:
        logger.exception("whatsapp_inbound_error tenant=%s", tenant_id)
