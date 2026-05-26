"""Widget conversation endpoints — used by the embeddable widget.

All endpoints require a widget_token (read-only, tenant-scoped).
The widget identifies the afiliado by widget_session_id (UUID in localStorage).

Flow:
  1. POST /widget/conversation/start     → create or resume conversation
  2. POST /widget/conversation/{id}/message → send message (bot responds or queued for operator)
  3. GET  /widget/conversation/{id}/poll    → long-poll for new messages (5s interval)
  4. POST /widget/conversation/{id}/human  → explicit human request
  5. POST /widget/conversation/{id}/confirm-handoff → afiliado confirms handoff offer
"""

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text

from core.database import get_pg_session
from core.security import CurrentUser, get_widget_user
from core.tenant import get_tenant_id
from services.handoff import (
    ConvStatus, HandoffTrigger,
    evaluate_handoff, request_handoff, get_default_sector_id,
)

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────

_MAX_MESSAGE_CHARS = 2000  # caps user input to prevent oversized LLM contexts and DoS


class StartConversationRequest(BaseModel):
    widget_session_id: str = Field(..., min_length=1, max_length=128)
    sector_id: str | None = Field(default=None, max_length=64)
    afiliado_nombre: str | None = Field(default=None, max_length=200)
    afiliado_email: str | None = Field(default=None, max_length=320)


class SendMessageRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=_MAX_MESSAGE_CHARS)
    widget_session_id: str = Field(..., min_length=1, max_length=128)


class PollRequest(BaseModel):
    last_message_id: str | None = None  # UUID of last known message


class ConfirmHandoffRequest(BaseModel):
    """Datos de identificación capturados just-in-time antes del handoff a operador.

    Opcional para no romper compat con clientes viejos. Cuando viene, se persisten
    en la conversación (afiliado_nombre, afiliado_dni) y quedan visibles para el
    operador. Sin estos datos, el handoff sigue funcionando (degraded mode).
    """
    afiliado_nombre: str | None = Field(default=None, min_length=1, max_length=200)
    afiliado_dni:    str | None = Field(default=None, min_length=4, max_length=20)


# ── Start / resume conversation ───────────────────────────────────────────────

@router.post("/widget/conversation/start")
async def start_conversation(
    body: StartConversationRequest,
    tenant_id: str = Depends(get_tenant_id),
    widget_user: CurrentUser = Depends(get_widget_user),
):
    """Create a new conversation or resume existing active one for this session."""
    async with get_pg_session(tenant_id) as session:
        # Check for existing open conversation
        result = await session.execute(text("""
            SELECT id, status, sector_id FROM conversaciones
            WHERE widget_session_id = :sid
              AND status != 'closed'
            ORDER BY created_at DESC LIMIT 1
        """), {"sid": body.widget_session_id})
        row = result.mappings().fetchone()

        if row:
            return {
                "conversation_id": str(row["id"]),
                "status": row["status"],
                "resumed": True,
            }

        # Resolve sector
        sector_id = body.sector_id
        if not sector_id:
            sector_id = await get_default_sector_id(tenant_id)

        # Fetch sector name for greeting
        sector_name = "consultas"
        if sector_id:
            sector_result = await session.execute(
                text("SELECT nombre FROM sectores WHERE id = :id"), {"id": sector_id}
            )
            sector_row = sector_result.fetchone()
            if sector_row:
                sector_name = sector_row[0]

        conv_id = str(uuid.uuid4())
        await session.execute(text("""
            INSERT INTO conversaciones
              (id, widget_session_id, sector_id, afiliado_nombre, afiliado_email)
            VALUES (:id, :sid, :sector_id, :nombre, :email)
        """), {
            "id": conv_id,
            "sid": body.widget_session_id,
            "sector_id": sector_id,
            "nombre": body.afiliado_nombre,
            "email": body.afiliado_email,
        })

        # Insert greeting as first bot message so it survives polling
        greeting = f"¡Hola! Soy el asistente de {sector_name}. ¿En qué te puedo ayudar hoy?"
        await session.execute(text("""
            INSERT INTO mensajes (conversation_id, sender_type, content)
            VALUES (:cid, 'bot', :msg)
        """), {"cid": conv_id, "msg": greeting})

    logger.info("conversation_started id=%s tenant=%s", conv_id, tenant_id)
    return {"conversation_id": conv_id, "status": ConvStatus.BOT_ACTIVE, "resumed": False, "greeting": greeting}


# ── Send message ──────────────────────────────────────────────────────────────

@router.post("/widget/conversation/{conversation_id}/message")
async def send_message(
    conversation_id: str,
    body: SendMessageRequest,
    tenant_id: str = Depends(get_tenant_id),
    widget_user: CurrentUser = Depends(get_widget_user),
):
    """Send a user message. Routes to bot (RAG) or operator queue based on conversation status."""
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text("SELECT status, insufficient_count, human_request_count FROM conversaciones WHERE id = :id"),
            {"id": conversation_id},
        )
        conv = result.mappings().fetchone()

    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    conv_status = conv["status"]

    # Store user message
    msg_id = str(uuid.uuid4())
    async with get_pg_session(tenant_id) as session:
        await session.execute(text("""
            INSERT INTO mensajes (id, conversation_id, sender_type, content)
            VALUES (:id, :cid, 'user', :content)
        """), {"id": msg_id, "cid": conversation_id, "content": body.content})
        await session.execute(text(
            "UPDATE conversaciones SET updated_at = NOW() WHERE id = :id"
        ), {"id": conversation_id})

    # If human is attending, just queue the message (operator will respond via panel)
    if conv_status == ConvStatus.HUMAN_ATTENDING:
        return {"message_id": msg_id, "status": conv_status, "bot_response": None}

    # If handoff requested, hold bot response
    if conv_status == ConvStatus.HANDOFF_REQUESTED:
        async with get_pg_session(tenant_id) as session:
            await session.execute(text("""
                INSERT INTO mensajes (conversation_id, sender_type, content)
                VALUES (:cid, 'system', 'Tu consulta está en cola. Un operador te atenderá pronto.')
            """), {"cid": conversation_id})
        return {"message_id": msg_id, "status": conv_status, "bot_response": None}

    # Bot active — fetch recent history then call RAG orchestrator
    from services.orchestrator import handle_query
    async with get_pg_session(tenant_id) as session:
        hist_result = await session.execute(text("""
            SELECT sender_type, content FROM mensajes
            WHERE conversation_id = :cid AND sender_type IN ('user', 'bot')
            ORDER BY created_at DESC LIMIT 20
        """), {"cid": conversation_id})
        history_rows = list(reversed(hist_result.mappings().fetchall()))
    # Build list of (role, content) tuples, excluding the just-inserted user message
    conversation_history = [
        (r["sender_type"], r["content"])
        for r in history_rows
        if r["content"] != body.content or r["sender_type"] != "user"
    ]
    try:
        rag_result = await handle_query(
            question=body.content,
            tenant_id=tenant_id,
            user_id=None,
            language="es",
            conversation_history=conversation_history,
        )
        bot_answer = rag_result["answer"]
        sources = rag_result.get("sources", [])
        intent_confidence = rag_result.get("intent_confidence")
    except Exception as exc:
        logger.error("widget_rag_failed conversation_id=%s error=%s", conversation_id, exc)
        bot_answer = "Lo siento, ocurrió un error. ¿Querés que te conecte con un operador?"
        sources = []
        intent_confidence = None

    # Store bot message
    bot_msg_id = str(uuid.uuid4())
    async with get_pg_session(tenant_id) as session:
        await session.execute(text("""
            INSERT INTO mensajes (id, conversation_id, sender_type, content)
            VALUES (:id, :cid, 'bot', :content)
        """), {"id": bot_msg_id, "cid": conversation_id, "content": bot_answer})

    # Evaluate handoff rules
    signal = await evaluate_handoff(
        conversation_id=conversation_id,
        tenant_id=tenant_id,
        user_message=body.content,
        sources=sources,
        intent_confidence=intent_confidence,
        bot_answer=bot_answer,
    )

    handoff_message = None
    if signal.trigger != HandoffTrigger.NONE:
        if signal.auto_activate:
            # Rule 2: auto handoff without confirmation
            await request_handoff(conversation_id, tenant_id, signal.offer_message)
            handoff_message = signal.offer_message
            conv_status = ConvStatus.HANDOFF_REQUESTED
        else:
            # Rules 1 & 3: offer handoff, wait for afiliado confirmation
            async with get_pg_session(tenant_id) as session:
                await session.execute(text("""
                    INSERT INTO mensajes (conversation_id, sender_type, content)
                    VALUES (:cid, 'system', :msg)
                """), {"cid": conversation_id, "msg": signal.offer_message})
            handoff_message = signal.offer_message

    return {
        "message_id": bot_msg_id,
        "status": conv_status,
        "bot_response": bot_answer,
        "sources_count": len(sources),
        "handoff_offered": signal.trigger != HandoffTrigger.NONE and not signal.auto_activate,
        "handoff_activated": signal.auto_activate,
        "handoff_message": handoff_message,
    }


# ── Polling ───────────────────────────────────────────────────────────────────

_LONG_POLL_TIMEOUT_S = 25.0


async def _read_conversation_snapshot(tenant_id: str, conversation_id: str) -> dict | None:
    """Single query: conversation status + latest 50 messages. Returns None if not found.

    Also marks operator messages as read when the conversation is being attended by a human.
    """
    async with get_pg_session(tenant_id) as session:
        conv_row = (await session.execute(
            text("""
                SELECT c.status, c.assigned_operator_id, u.name AS operator_name
                FROM conversaciones c
                LEFT JOIN usuarios u ON u.id = c.assigned_operator_id
                WHERE c.id = :id
            """),
            {"id": conversation_id},
        )).mappings().fetchone()
        if not conv_row:
            return None

        msg_rows = (await session.execute(text("""
            SELECT id, sender_type, content, created_at
            FROM mensajes
            WHERE conversation_id = :cid
            ORDER BY created_at ASC
            LIMIT 50
        """), {"cid": conversation_id})).mappings().all()

        messages = [
            {
                "id": str(r["id"]),
                "sender_type": r["sender_type"],
                "content": r["content"],
                "created_at": r["created_at"].isoformat(),
            }
            for r in msg_rows
        ]

        if messages and conv_row["status"] == ConvStatus.HUMAN_ATTENDING:
            await session.execute(text("""
                UPDATE mensajes SET read_at = NOW()
                WHERE conversation_id = :cid
                  AND sender_type = 'operator'
                  AND read_at IS NULL
            """), {"cid": conversation_id})

    return {
        "conversation_id": conversation_id,
        "status": conv_row["status"],
        "operator_name": conv_row["operator_name"],
        "messages": messages,
    }


@router.get("/widget/conversation/{conversation_id}/poll")
async def poll_messages(
    conversation_id: str,
    last_message_id: str | None = None,
    tenant_id: str = Depends(get_tenant_id),
    widget_user: CurrentUser = Depends(get_widget_user),
):
    """Long-polling: returns immediately if the conversation has new messages
    or status changes since `last_message_id`; otherwise holds the request
    open up to ~25s waiting for a relevant pub/sub event. Falls back to a
    final fresh read when timeout expires so the client always gets the
    current snapshot.

    No `last_message_id` → always returns the latest snapshot (used for the
    first poll after starting a conversation). This preserves the existing
    contract for the widget that does not track ids.
    """
    snapshot = await _read_conversation_snapshot(tenant_id, conversation_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # First poll (no anchor) → snapshot immediately.
    # Otherwise, if the latest message id differs from the anchor, the client
    # is behind → return now. If they match, long-poll until something changes.
    if last_message_id is None:
        return snapshot
    if snapshot["messages"] and snapshot["messages"][-1]["id"] != last_message_id:
        return snapshot

    # Hold the request until either:
    #   - new_message arrives for this conversation
    #   - conversation_updated (status change: handoff accepted, returned to bot, closed)
    #   - timeout (~25s) — client retries naturally
    from services.events import wait_for_event

    def _relevant(event: dict) -> bool:
        if event.get("conversation_id") != conversation_id:
            return False
        return event.get("type") in {"new_message", "conversation_updated"}

    event = await wait_for_event(tenant_id, _relevant, timeout=_LONG_POLL_TIMEOUT_S)
    if event is None:
        # Timeout: return whatever we have so the client stays in sync.
        return snapshot

    # Re-read after the event to capture the new message + any concurrent updates.
    fresh = await _read_conversation_snapshot(tenant_id, conversation_id)
    return fresh or snapshot


# ── Explicit human request ────────────────────────────────────────────────────

@router.post("/widget/conversation/{conversation_id}/human")
async def request_human(
    conversation_id: str,
    tenant_id: str = Depends(get_tenant_id),
    widget_user: CurrentUser = Depends(get_widget_user),
):
    """Afiliado explicitly requests human operator."""
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text("SELECT status FROM conversaciones WHERE id = :id"),
            {"id": conversation_id},
        )
        row = result.fetchone()
    if not row or row[0] == ConvStatus.CLOSED:
        raise HTTPException(status_code=404, detail="Conversation not found or closed")
    if row[0] != ConvStatus.BOT_ACTIVE:
        return {"status": row[0], "message": "Ya en proceso de atención"}

    from services.handoff import _get_handoff_config
    config = await _get_handoff_config(tenant_id)
    msg = config["transition_messages"]["handoff_auto"]
    await request_handoff(conversation_id, tenant_id, msg)
    return {"status": ConvStatus.HANDOFF_REQUESTED, "message": msg}


# ── Confirm handoff offer ─────────────────────────────────────────────────────

@router.post("/widget/conversation/{conversation_id}/confirm-handoff")
async def confirm_handoff(
    conversation_id: str,
    body: ConfirmHandoffRequest | None = None,
    tenant_id: str = Depends(get_tenant_id),
    widget_user: CurrentUser = Depends(get_widget_user),
):
    """Afiliado confirma handoff. Opcionalmente envía nombre + DNI para que el
    operador tenga la identificación al recibir la conversación.

    Si llegan datos en el body, se persisten en `conversaciones` antes de
    disparar el handoff (sin esto el operador ve "Afiliado anónimo").
    """
    # Persistir datos de identificación si vinieron en el body
    if body and (body.afiliado_nombre or body.afiliado_dni):
        updates = []
        params: dict[str, str] = {"cid": conversation_id}
        if body.afiliado_nombre:
            updates.append("afiliado_nombre = :nombre")
            params["nombre"] = body.afiliado_nombre.strip()
        if body.afiliado_dni:
            updates.append("afiliado_dni = :dni")
            params["dni"] = body.afiliado_dni.strip()
        if updates:
            async with get_pg_session(tenant_id) as session:
                await session.execute(
                    text(
                        f"UPDATE conversaciones SET {', '.join(updates)}, updated_at = NOW() "
                        "WHERE id = :cid"
                    ),
                    params,
                )

    from services.handoff import _get_handoff_config
    config = await _get_handoff_config(tenant_id)
    msg = config["transition_messages"]["handoff_auto"]
    await request_handoff(conversation_id, tenant_id, msg)
    return {"status": ConvStatus.HANDOFF_REQUESTED, "message": msg}


# ── Operators online count ────────────────────────────────────────────────────

@router.get("/widget/operators-online")
async def operators_online(
    sector_id: str | None = None,
    tenant_id: str = Depends(get_tenant_id),
    widget_user: CurrentUser = Depends(get_widget_user),
):
    """Return count of operators currently marked as online for a sector."""
    from services.events import get_online_operators
    online_ops = await get_online_operators(tenant_id)

    if not sector_id:
        return {"online": len(online_ops), "operators": [o["name"] for o in online_ops]}

    # Filter online operators by those assigned to the requested sector
    if not online_ops:
        return {"online": 0, "operators": []}

    online_ids = [o["user_id"] for o in online_ops]
    async with get_pg_session(tenant_id) as session:
        placeholders = ", ".join(f":uid_{i}" for i in range(len(online_ids)))
        result = await session.execute(text(f"""
            SELECT DISTINCT u.id, u.name
            FROM usuarios u
            JOIN operador_sectores os ON os.operador_id = u.id
            WHERE os.sector_id = :sector_id
              AND u.id::text IN ({placeholders})
        """), {"sector_id": sector_id, **{f"uid_{i}": uid for i, uid in enumerate(online_ids)}})
        rows = result.fetchall()

    return {"online": len(rows), "operators": [r[1] for r in rows]}
