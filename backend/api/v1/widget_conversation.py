"""Widget conversation endpoints — used by the embeddable widget.

All endpoints require a widget_token (read-only, tenant-scoped).
The widget identifies the afiliado by widget_session_id (UUID in localStorage).

Flow:
  1. POST /widget/conversation/start     → create or resume conversation
  2. POST /widget/conversation/{id}/message → send message (bot responds; si el
     bot no encuentra info N veces seguidas, ofrece derivacion)
  3. GET  /widget/conversation/{id}/poll    → long-poll for new messages
  4. POST /widget/conversation/{id}/confirm-handoff → afiliado confirma la
     oferta del bot (con nombre + DNI) y la conversacion pasa a la cola de
     operadores. Es la unica manera de derivar.
"""

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import text

from core.database import get_pg_session
from core.rate_limit import check_widget_rate_limit
from core.security import CurrentUser, TokenScope, get_widget_or_chat_user
from core.tenant import get_tenant_id
from services.handoff import (
    ConvStatus, HandoffTrigger, HandoffSignal,
    evaluate_handoff, request_handoff, get_default_sector_id,
)
from services.events import publish as _publish_event

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────

_MAX_MESSAGE_CHARS = 2000  # caps user input to prevent oversized LLM contexts and DoS


class StartConversationRequest(BaseModel):
    widget_session_id: str = Field(..., min_length=1, max_length=128)
    sector_id: str | None = Field(default=None, max_length=64)
    afiliado_nombre: str | None = Field(default=None, max_length=200)
    afiliado_email: str | None = Field(default=None, max_length=320)
    is_test: bool = Field(default=False)


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
    # El DNI es solo un identificador para el operador (el handoff funciona incluso
    # sin él, ver degraded mode). min_length=1 para coincidir con el front, que no
    # impone un mínimo — antes estaba en 4 y un DNI corto rebotaba con 422 silencioso.
    afiliado_dni:    str | None = Field(default=None, min_length=1, max_length=20)
    # El sector se elige en el momento del handoff (no al abrir el chat): la
    # conversación arranca en el sector default y acá se re-etiqueta para que
    # caiga en la cola de operadores correcta. Inválido/ausente → queda como está.
    sector_id:       str | None = Field(default=None, max_length=64)


# ── Start / resume conversation ───────────────────────────────────────────────

@router.post("/widget/conversation/start")
async def start_conversation(
    request: Request,
    body: StartConversationRequest,
    tenant_id: str = Depends(get_tenant_id),
    widget_user: CurrentUser = Depends(get_widget_or_chat_user),
):
    """Create a new conversation or resume existing active one for this session."""
    # Canal widget desactivado desde el panel (Configuración → Canales) → 403.
    # "Probar chat" (is_test) sigue funcionando para que el admin pueda probar:
    # el botón del panel abre /chat con un WIDGET token (admin-generado) + test=1.
    # Un afiliado anónimo usa un PUBLIC_CHAT token (/public/chat-token) y NO puede
    # saltear el flag seteando is_test=true → solo el scope WIDGET lo habilita.
    # try/except: tolera bases que aún no corrieron la migración 023.
    if not (body.is_test and widget_user.scope == TokenScope.WIDGET):
        try:
            async with get_pg_session() as gsession:
                row = (await gsession.execute(
                    text("SELECT widget_enabled FROM public.tenants WHERE id = :tid"),
                    {"tid": tenant_id},
                )).fetchone()
            if row is not None and row[0] is False:
                raise HTTPException(status_code=403, detail="El canal de chat web está desactivado.")
        except HTTPException:
            raise
        except Exception:
            logger.warning("widget_enabled_check_failed tenant=%s (¿falta migración 023?)", tenant_id)

    async with get_pg_session(tenant_id) as session:
        # Advisory lock por widget_session_id para serializar requests
        # concurrentes del mismo afiliado (2 tabs abriendo a la vez). Sin esto,
        # ambas tabs hacian SELECT (vacio) -> INSERT -> 2 conversaciones
        # duplicadas para el mismo afiliado. El lock se libera al COMMIT/ROLLBACK
        # automaticamente (xact = transaction-scoped).
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:sid, 0))"),
            {"sid": body.widget_session_id},
        )

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

        # Reapertura: si la conversación anterior de esta sesión quedó cerrada
        # SIN calificar (y es reciente), el frontend ofrece las caritas una vez
        # antes de arrancar la nueva. Ventana 48h: calificar una charla de hace
        # una semana ya no aporta señal y molesta.
        prev_fb = (await session.execute(text("""
            SELECT id FROM conversaciones
            WHERE widget_session_id = :sid
              AND status = 'closed'
              AND feedback_rating IS NULL
              AND closed_at >= NOW() - INTERVAL '48 hours'
            ORDER BY created_at DESC LIMIT 1
        """), {"sid": body.widget_session_id})).scalar()

        # Resolve sector. body.sector_id lo controla el cliente: validar que sea
        # un UUID real, exista en ESTE tenant y esté activo. Si no, caer al sector
        # por defecto en vez de insertar un sector_id basura (que rompería la FK
        # conversaciones.sector_id → sectores con un 500, o quedaría colgado).
        sector_id = (body.sector_id or "").strip() or None
        if sector_id:
            try:
                uuid.UUID(sector_id)
            except ValueError:
                sector_id = None

        sector_row = None
        if sector_id:
            sector_result = await session.execute(
                text("SELECT 1 FROM sectores WHERE id = :id AND is_active = TRUE"),
                {"id": sector_id},
            )
            sector_row = sector_result.fetchone()

        if not sector_row:
            # sector inválido/inactivo/ausente → default del tenant
            sector_id = await get_default_sector_id(tenant_id)

        # Personalización del saludo: greeting_message custom, bot_name y nombre de
        # la organización (tabla global public.tenants). Si el admin configuró un
        # saludo propio se usa tal cual; si no, el default se presenta como asistente
        # DE LA ORGANIZACIÓN — no del sector, que es un detalle interno de ruteo y
        # confunde al visitante ("el asistente de Consultas Generales").
        tenant_cfg = await session.execute(
            text("SELECT greeting_message, bot_name, name FROM public.tenants WHERE id = :tid"),
            {"tid": tenant_id},
        )
        cfg_row = tenant_cfg.mappings().fetchone()
        custom_greeting = cfg_row["greeting_message"] if cfg_row else None
        bot_name = (cfg_row["bot_name"] or "").strip() if cfg_row else ""
        org_name = (cfg_row["name"] if cfg_row else None) or "la organización"

        conv_id = str(uuid.uuid4())
        # IP: X-Forwarded-For (Nginx) tiene prioridad; fallback al IP directo
        forwarded = request.headers.get("X-Forwarded-For")
        afiliado_ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else None)
        await session.execute(text("""
            INSERT INTO conversaciones
              (id, widget_session_id, sector_id, afiliado_nombre, afiliado_email, afiliado_ip, is_test)
            VALUES (:id, :sid, :sector_id, :nombre, :email, :ip, :is_test)
        """), {
            "id": conv_id,
            "sid": body.widget_session_id,
            "sector_id": sector_id,
            "nombre": body.afiliado_nombre,
            "email": body.afiliado_email,
            "ip": afiliado_ip,
            "is_test": body.is_test,
        })

        # Insert greeting as first bot message so it survives polling
        if custom_greeting:
            greeting = custom_greeting
        elif bot_name:
            greeting = f"¡Hola! Soy {bot_name}, el asistente de {org_name}. ¿En qué te puedo ayudar hoy?"
        else:
            # Sin bot_name configurado: presentarse solo con la organización,
            # no con un "Asistente" genérico que parece nombre propio.
            greeting = f"¡Hola! Soy el asistente de {org_name}. ¿En qué te puedo ayudar hoy?"
        await session.execute(text("""
            INSERT INTO mensajes (conversation_id, sender_type, content)
            VALUES (:cid, 'bot', :msg)
        """), {"cid": conv_id, "msg": greeting})

    logger.info("conversation_started id=%s tenant=%s", conv_id, tenant_id)
    return {
        "conversation_id": conv_id, "status": ConvStatus.BOT_ACTIVE,
        "resumed": False, "greeting": greeting,
        # id de la conversación anterior cerrada sin calificar (o None) — el
        # frontend muestra las caritas para ESA conversación, una sola vez.
        "prev_feedback_pending": str(prev_fb) if prev_fb else None,
    }


# ── Send message ──────────────────────────────────────────────────────────────

@router.post("/widget/conversation/{conversation_id}/message", dependencies=[Depends(check_widget_rate_limit)])
async def send_message(
    conversation_id: str,
    body: SendMessageRequest,
    tenant_id: str = Depends(get_tenant_id),
    widget_user: CurrentUser = Depends(get_widget_or_chat_user),
):
    """Send a user message. Routes to bot (RAG) or operator queue based on conversation status."""
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text("SELECT status, sector_id FROM conversaciones WHERE id = :id AND widget_session_id = :sid"),
            {"id": conversation_id, "sid": body.widget_session_id},
        )
        conv = result.mappings().fetchone()

    # Anti-IDOR: si la conv no existe O no pertenece a este widget_session_id → 404.
    if not conv:
        raise HTTPException(status_code=404, detail="No encontramos la conversación. Iniciá una nueva.")

    conv_status = conv["status"]
    conv_sector_id = str(conv["sector_id"]) if conv["sector_id"] else None

    # Conversacion cerrada (operador cerro o timeout): rechazar con 410 para
    # que el frontend abra una nueva conv. Sin esto el bot respondia normal
    # sobre una conv "muerta" y el state local quedaba en un limbo raro.
    if conv_status == ConvStatus.CLOSED:
        raise HTTPException(status_code=410, detail="La conversación fue cerrada. Iniciá una nueva.")

    # Store user message
    msg_id = str(uuid.uuid4())
    async with get_pg_session(tenant_id) as session:
        await session.execute(text("""
            INSERT INTO mensajes (id, conversation_id, sender_type, content)
            VALUES (:id, :cid, 'user', :content)
        """), {"id": msg_id, "cid": conversation_id, "content": body.content})
        # updated_at SOLO se renueva mientras la conversación está con el bot.
        # En cola (handoff_requested) el reloj de cierre debe contar desde que
        # entró a la cola — si cada mensaje del afiliado esperando lo reseteara,
        # la conversación no cerraría nunca (incidente Josué 2026-07-29). En
        # atención (human_attending) el cierre usa el último msg del afiliado,
        # no updated_at, así que congelarlo acá tampoco molesta.
        if conv_status == ConvStatus.BOT_ACTIVE:
            await session.execute(text(
                "UPDATE conversaciones SET updated_at = NOW() WHERE id = :id"
            ), {"id": conversation_id})
    await _publish_event(tenant_id, "new_message", {"conversation_id": conversation_id})

    # If human is attending, just queue the message (operator will respond via panel)
    if conv_status == ConvStatus.HUMAN_ATTENDING:
        return {"message_id": msg_id, "status": conv_status, "bot_response": None}

    # If handoff requested, hold bot response
    if conv_status == ConvStatus.HANDOFF_REQUESTED:
        async with get_pg_session(tenant_id) as session:
            # No spamear el cartel "en cola": insertarlo solo si el último mensaje del
            # sistema no es ya ese (el afiliado puede escribir varias veces esperando).
            queue_msg = "Tu consulta está en cola. Un operador te atenderá pronto."
            last_sys = (await session.execute(text("""
                SELECT content FROM mensajes
                WHERE conversation_id = :cid AND sender_type = 'system'
                ORDER BY created_at DESC LIMIT 1
            """), {"cid": conversation_id})).fetchone()
            if not last_sys or last_sys[0] != queue_msg:
                await session.execute(text("""
                    INSERT INTO mensajes (conversation_id, sender_type, content)
                    VALUES (:cid, 'system', :msg)
                """), {"cid": conversation_id, "msg": queue_msg})
        return {"message_id": msg_id, "status": conv_status, "bot_response": None}

    # ── Pedido de humano por texto — determinístico, ANTES del LLM ────────────
    # Incidente 2026-07-27: "si" tras la invitación a derivar iba al RAG y el
    # LLM prometía "voy a derivar tu consulta" sin ejecutar nada. Formas
    # explícitas ("quiero hablar con un operador") disparan siempre; el "sí" a
    # secas solo si lo último del bot/sistema invitaba a derivar. Respuesta
    # determinística + cartel con botón — el LLM jamás gestiona derivaciones.
    from services.handoff import (
        is_explicit_human_request, is_bare_affirmation,
        has_online_operators as _has_ops_fn, offer_expectation_suffix as _exp_suffix,
        _get_handoff_config as _get_cfg, _mark_offer_pending as _mark_pending,
    )
    _explicit = is_explicit_human_request(body.content)
    _affirm = not _explicit and is_bare_affirmation(body.content)
    if _explicit or _affirm:
        proceed = _explicit
        if _affirm:
            async with get_pg_session(tenant_id) as session:
                last_bot = (await session.execute(text("""
                    SELECT content, is_handoff_offer FROM mensajes
                    WHERE conversation_id = :cid AND sender_type != 'user'
                    ORDER BY created_at DESC LIMIT 1
                """), {"cid": conversation_id})).mappings().fetchone()
            proceed = bool(last_bot and (
                last_bot["is_handoff_offer"]
                or "operador" in (last_bot["content"] or "").lower()
                or "derivar" in (last_bot["content"] or "").lower()
            ))
        if proceed:
            _cfg = await _get_cfg(tenant_id)
            offer_text = (
                "¡Perfecto! Tocá el botón y dejá tu nombre y DNI para conectarte con un operador."
            )
            if not await _has_ops_fn(tenant_id, conv_sector_id):
                offer_text = f"{offer_text}{_exp_suffix(_cfg)}"
            async with get_pg_session(tenant_id) as session:
                await session.execute(text("""
                    INSERT INTO mensajes (conversation_id, sender_type, content, is_handoff_offer)
                    VALUES (:cid, 'system', :msg, TRUE)
                """), {"cid": conversation_id, "msg": offer_text})
            await _publish_event(tenant_id, "new_message", {"conversation_id": conversation_id})
            await _mark_pending(conversation_id)
            logger.info("handoff_text_request conversation_id=%s explicit=%s", conversation_id, _explicit)
            return {
                "message_id": msg_id,
                "status": conv_status,
                "bot_response": None,
                "sources_count": 0,
                "handoff_offered": True,
                "handoff_activated": False,
                "handoff_message": offer_text,
            }

    # El bot corre el RAG para el resto. Las reglas de derivación miran el
    # resultado (insuficiente xN, frustración, keywords del tenant).
    from services.orchestrator import handle_query
    # Si hubo un logout en esta conversación, el historial ANTERIOR no se le pasa
    # al modelo: ahí quedaron datos personales que ya respondió, y sin este corte
    # los repite sin credencial (la charla completa sigue en la base, intacta,
    # para el operador y la auditoría).
    from services import connector_memory as _connmem
    corte = await _connmem.get_history_cut(tenant_id, str(conversation_id))
    async with get_pg_session(tenant_id) as session:
        hist_result = await session.execute(text("""
            SELECT sender_type, content FROM mensajes
            WHERE conversation_id = :cid AND sender_type IN ('user', 'bot')
              AND (CAST(:corte AS timestamptz) IS NULL OR created_at > CAST(:corte AS timestamptz))
            ORDER BY created_at DESC LIMIT 20
        """), {"cid": conversation_id, "corte": corte})
        history_rows = list(reversed(hist_result.mappings().fetchall()))
    conversation_history = [
        (r["sender_type"], r["content"])
        for r in history_rows
        if r["content"] != body.content or r["sender_type"] != "user"
    ]
    # Si el afiliado abre y su PRIMER mensaje es solo un saludo, el greeting de
    # bienvenida (ya mostrado al abrir) cumple ese rol: no dejamos que el bot
    # re-salude. Ack breve sin volver a saludar y sin gastar RAG/cuota.
    from services.handoff import _is_chitchat
    greeted = any(r["sender_type"] == "bot" for r in history_rows)
    user_count = sum(1 for r in history_rows if r["sender_type"] == "user")
    first_greeting_chitchat = greeted and user_count == 1 and _is_chitchat(body.content)

    # Cuota mensual del plan del tenant. Si está agotada, NO corremos el RAG (lo
    # caro) y devolvemos un mensaje neutral al afiliado en vez de un 429 crudo.
    # Es per-tenant (facturación), no afecta a un usuario individual.
    from core.plan_limits import enforce_query_limit
    over_quota = False
    if not first_greeting_chitchat:
        try:
            await enforce_query_limit(tenant_id)
        except HTTPException:
            over_quota = True

    # Router de conectores (Tool Calling): si el turno es de datos personales
    # (FSM de login en curso, o intención que dispara una tool), lo maneja acá y
    # NO pasa por el RAG ni por su cache compartido (los datos personales no se
    # cachean cruzados entre usuarios). Si devuelve None, sigue el flujo RAG normal.
    connector_result = None
    if not first_greeting_chitchat and not over_quota:
        try:
            from services.connector_router import maybe_handle
            connector_result = await maybe_handle(
                tenant_id=tenant_id,
                conversation_id=conversation_id,
                message=body.content,
            )
        except Exception as exc:
            # Fail-closed hacia el RAG: si el router falla, no rompemos la conversación.
            logger.error("connector_router_failed conversation_id=%s error=%s", conversation_id, exc)
            connector_result = None

    if connector_result is not None:
        bot_answer = connector_result["answer"]
        sources = []
    elif first_greeting_chitchat:
        bot_answer = "😊 Contame, ¿qué necesitás?"
        sources = []
    elif over_quota:
        bot_answer = ("El asistente no está disponible en este momento. "
                      "Por favor, comunicate directamente con la organización.")
        sources = []
    else:
        # Ruteo unificado: la MISMA llamada LLM del RAG recibe el catálogo de
        # tools del tenant y decide tool-vs-responder (cero hops extra en turnos
        # RAG). Si eligió tool, se ejecuta acá — capa de conversación, con estado —
        # por el mismo camino que el FSM de login (público / sesión).
        from core.config import settings as _settings
        tool_schemas = None
        tool_domains = None
        if _settings.connectors_enabled:
            try:
                from services.connector_router import _build_tool_schemas
                from services.connectors_dao import list_tools_for_tool_calling
                from services.prompt_builder import tool_domain_summary
                catalog = await list_tools_for_tool_calling(tenant_id)
                if catalog:
                    tool_schemas = _build_tool_schemas(catalog)
                    # Dominios cubiertos por las tools → el módulo de alcance del
                    # prompt los declara en-scope (sin esto, la política de alcance
                    # institucional rechazaba temas que las tools sí cubren).
                    tool_domains = tool_domain_summary(catalog)
            except Exception as exc:
                # Sin catálogo no hay tools este turno; el RAG sigue normal.
                logger.warning("tool_catalog_failed tenant_id=%s error=%s", tenant_id, exc)
        try:
            rag_result = await handle_query(
                question=body.content,
                tenant_id=tenant_id,
                user_id=None,
                language="es",
                conversation_history=conversation_history,
                tool_schemas=tool_schemas,
                tool_domains=tool_domains,
            )
            if rag_result.get("tool_call"):
                from services.connector_router import handle_tool_signal
                tc = rag_result["tool_call"]
                connector_result = await handle_tool_signal(
                    tenant_id, conversation_id, body.content,
                    tc["name"], tc.get("arguments"),
                )
                if connector_result is not None:
                    bot_answer = connector_result["answer"]
                    sources = []
                else:
                    # Slug alucinado / tool desactivada entre medio (raro): la llamada
                    # devolvió tool_call sin texto → reintento RAG puro, sin tools.
                    logger.warning("tool_signal_unresolved tenant_id=%s tool=%s — retry RAG",
                                   tenant_id, tc.get("name"))
                    rag_result = await handle_query(
                        question=body.content,
                        tenant_id=tenant_id,
                        user_id=None,
                        language="es",
                        conversation_history=conversation_history,
                    )
                    bot_answer = rag_result["answer"]
                    sources = rag_result.get("sources", [])
            else:
                bot_answer = rag_result["answer"]
                sources = rag_result.get("sources", [])
        except Exception as exc:
            logger.error("widget_rag_failed conversation_id=%s error=%s", conversation_id, exc)
            bot_answer = "Lo siento, ocurrió un error. Intentá de nuevo en un momento."
            sources = []

    # Se evalúa el handoff ANTES de persistir la respuesta del bot: si se va a
    # mostrar la oferta de operador, el bot_answer genérico ("no pude / fuera de
    # mi área") es redundante con la oferta y NO se inserta ni se devuelve.
    # Excepción: si el router de conectores manejó el turno (FSM de login o dato
    # personal), NO evaluamos handoff — un "pasame tu DNI" o "tenés 2 órdenes" no
    # es una respuesta insuficiente y no debe ofrecer operador humano.
    if connector_result is not None:
        signal = HandoffSignal(trigger=HandoffTrigger.NONE, auto_activate=False, offer_message="")
    else:
        signal = await evaluate_handoff(
            conversation_id=conversation_id,
            tenant_id=tenant_id,
            user_message=body.content,
            sources=sources,
            bot_answer=bot_answer,
        )

    bot_msg_id = None
    handoff_message = None
    handoff_offered = False
    suppress_bot = False  # se suprime el genérico SOLO cuando se muestra la oferta

    from services.handoff import (
        has_online_operators, offer_expectation_suffix, _get_handoff_config, _mark_offer_pending,
    )

    # POLÍTICA FAIL-SOFT (incidente 2026-07-27: "no hay operadores" con el
    # operador conectado, por presencia vencida): la disponibilidad NUNCA
    # bloquea la oferta de derivación — solo MODULA el mensaje de expectativa.
    # El pedido siempre puede entrar a la fila; si la presencia mintió, el
    # costo es una espera, nunca una puerta cerrada falsa.
    if signal.trigger != HandoffTrigger.NONE:
        has_ops = await has_online_operators(tenant_id, conv_sector_id)
        # keep_answer (Regla 5 por keyword): la respuesta del bot SÍ se persiste
        # y el cartel va debajo — el afiliado pudo pedir info que el bot tiene.
        # Reglas por fallo: el bot_answer genérico es redundante y no se persiste.
        if signal.keep_answer:
            bot_msg_id = str(uuid.uuid4())
            async with get_pg_session(tenant_id) as session:
                await session.execute(text("""
                    INSERT INTO mensajes (id, conversation_id, sender_type, content)
                    VALUES (:id, :cid, 'bot', :content)
                """), {"id": bot_msg_id, "cid": conversation_id, "content": bot_answer})
        offer_text = signal.offer_message
        if not has_ops:
            cfg = await _get_handoff_config(tenant_id)
            offer_text = f"{offer_text}{offer_expectation_suffix(cfg)}"
        async with get_pg_session(tenant_id) as session:
            await session.execute(text("""
                INSERT INTO mensajes (conversation_id, sender_type, content, is_handoff_offer)
                VALUES (:cid, 'system', :msg, TRUE)
            """), {"cid": conversation_id, "msg": offer_text})
        await _publish_event(tenant_id, "new_message", {"conversation_id": conversation_id})
        await _mark_offer_pending(conversation_id)  # cooldown 90s SOLO al mostrar el cartel
        if signal.trigger == HandoffTrigger.KEYWORD:
            from services.handoff import mark_keyword_offered
            await mark_keyword_offered(conversation_id)  # supresión 1h por conversación
        handoff_message = offer_text
        handoff_offered = True
        suppress_bot = not signal.keep_answer
    else:
        # Respuesta normal del bot, sin señal de derivación.
        bot_msg_id = str(uuid.uuid4())
        async with get_pg_session(tenant_id) as session:
            await session.execute(text("""
                INSERT INTO mensajes (id, conversation_id, sender_type, content)
                VALUES (:id, :cid, 'bot', :content)
            """), {"id": bot_msg_id, "cid": conversation_id, "content": bot_answer})
        await _publish_event(tenant_id, "new_message", {"conversation_id": conversation_id})

    return {
        "message_id": bot_msg_id,
        "status": conv_status,
        "bot_response": None if suppress_bot else bot_answer,
        "sources_count": len(sources),
        "handoff_offered": handoff_offered,
        "handoff_activated": False,  # nunca auto-activa — el afiliado siempre confirma
        "handoff_message": handoff_message,
    }


# ── Polling ───────────────────────────────────────────────────────────────────

_LONG_POLL_TIMEOUT_S = 25.0


async def _read_conversation_snapshot(tenant_id: str, conversation_id: str, widget_session_id: str) -> dict | None:
    """Single query: conversation status + latest 50 messages. Returns None if not found
    OR si la conversación no pertenece a este widget_session_id (anti-IDOR).

    Also marks operator messages as read when the conversation is being attended by a human.
    """
    async with get_pg_session(tenant_id) as session:
        conv_row = (await session.execute(
            text("""
                SELECT c.status, c.assigned_operator_id, c.afiliado_nombre, c.afiliado_dni,
                       c.feedback_rating, u.name AS operator_name
                FROM conversaciones c
                LEFT JOIN usuarios u ON u.id = c.assigned_operator_id
                WHERE c.id = :id AND c.widget_session_id = :sid
            """),
            {"id": conversation_id, "sid": widget_session_id},
        )).mappings().fetchone()
        if not conv_row:
            return None

        # Los ÚLTIMOS 50 mensajes (no los primeros). Antes era ORDER BY ASC LIMIT 50,
        # que devolvía los 50 más VIEJOS: en conversaciones de más de 50 mensajes el
        # widget se "congelaba" en los primeros 50 y los nuevos no aparecían (el polling
        # comparaba contra el mensaje #50, que nunca cambiaba). Tomamos los 50 recientes
        # con DESC y los reordenamos cronológicamente para renderizar.
        msg_rows = (await session.execute(text("""
            SELECT id, sender_type, content, is_handoff_offer, created_at,
                   attachment_key, attachment_name, attachment_mime, attachment_size
            FROM (
                SELECT id, sender_type, content, is_handoff_offer, created_at,
                       attachment_key, attachment_name, attachment_mime, attachment_size
                FROM mensajes
                WHERE conversation_id = :cid
                ORDER BY created_at DESC
                LIMIT 50
            ) sub
            ORDER BY created_at ASC
        """), {"cid": conversation_id})).mappings().all()

        messages = [
            {
                "id": str(r["id"]),
                "sender_type": r["sender_type"],
                "content": r["content"],
                "is_handoff_offer": bool(r["is_handoff_offer"]),
                "created_at": r["created_at"].isoformat(),
                # Adjunto (None si el mensaje es solo texto). El frontend usa
                # attachment_name/mime para decidir si renderiza imagen o link.
                "attachment_name": r["attachment_name"],
                "attachment_mime": r["attachment_mime"],
                "attachment_size": r["attachment_size"],
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
        # Si la conversación ya tiene nombre + DNI (el afiliado se identificó en un
        # handoff previo), el frontend NO vuelve a pedirlos: deriva directo. Genérico
        # y por-conversación — no depende del tenant ni de hardcodeos.
        "afiliado_identified": bool(conv_row["afiliado_nombre"] and conv_row["afiliado_dni"]),
        # El frontend muestra las caritas cuando status=closed y esto es False.
        "feedback_given": conv_row["feedback_rating"] is not None,
        "messages": messages,
    }


@router.get("/widget/conversation/{conversation_id}/poll")
async def poll_messages(
    conversation_id: str,
    widget_session_id: str,
    last_message_id: str | None = None,
    tenant_id: str = Depends(get_tenant_id),
    widget_user: CurrentUser = Depends(get_widget_or_chat_user),
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
    snapshot = await _read_conversation_snapshot(tenant_id, conversation_id, widget_session_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="No encontramos la conversación. Iniciá una nueva.")

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
    fresh = await _read_conversation_snapshot(tenant_id, conversation_id, widget_session_id)
    return fresh or snapshot


# ── Confirm handoff offer ─────────────────────────────────────────────────────

@router.post("/widget/conversation/{conversation_id}/confirm-handoff")
async def confirm_handoff(
    conversation_id: str,
    widget_session_id: str,
    body: ConfirmHandoffRequest | None = None,
    tenant_id: str = Depends(get_tenant_id),
    widget_user: CurrentUser = Depends(get_widget_or_chat_user),
):
    """Afiliado confirma handoff. Opcionalmente envía nombre + DNI para que el
    operador tenga la identificación al recibir la conversación.

    Si llegan datos en el body, se persisten en `conversaciones` antes de
    disparar el handoff (sin esto el operador ve "Afiliado anónimo").
    """
    # Anti-IDOR: la conversación debe pertenecer a este widget_session_id.
    # Anti-abuso: además exigimos que haya una oferta de derivación vigente
    # (is_handoff_offer=TRUE sin consumir). Sin esto, cualquiera con el
    # widget_session_id podía POSTear confirm-handoff sin que el bot ofreciera
    # nada y empujar la conversación a la cola, inundando a los operadores. El
    # front solo expone el botón desde el cartel de oferta, así que esto no
    # cambia el flujo legítimo — solo cierra la llamada cruda a la API.
    async with get_pg_session(tenant_id) as session:
        owner = await session.execute(
            text("""
                SELECT EXISTS (
                    SELECT 1 FROM mensajes
                    WHERE conversation_id = :cid AND is_handoff_offer = TRUE
                ) AS has_offer
                FROM conversaciones
                WHERE id = :cid AND widget_session_id = :sid
            """),
            {"cid": conversation_id, "sid": widget_session_id},
        )
        owner_row = owner.fetchone()
        if owner_row is None:
            raise HTTPException(status_code=404, detail="No encontramos la conversación. Iniciá una nueva.")
        if not owner_row[0]:
            raise HTTPException(status_code=409, detail="No hay una derivación pendiente para confirmar.")

    # Persistir datos de identificación + sector elegido si vinieron en el body
    if body and (body.afiliado_nombre or body.afiliado_dni or body.sector_id):
        updates = []
        params: dict[str, str] = {"cid": conversation_id}
        if body.afiliado_nombre:
            updates.append("afiliado_nombre = :nombre")
            params["nombre"] = body.afiliado_nombre.strip()
        if body.afiliado_dni:
            updates.append("afiliado_dni = :dni")
            params["dni"] = body.afiliado_dni.strip()
        # Re-etiquetado de sector al derivar. Mismo criterio de validación que en
        # start: UUID real + existe en este tenant + activo; si no, se ignora en
        # silencio y la conversación queda en su sector actual (default).
        sector_id = (body.sector_id or "").strip() or None
        if sector_id:
            try:
                uuid.UUID(sector_id)
            except ValueError:
                sector_id = None
        if sector_id:
            async with get_pg_session(tenant_id) as session:
                valid = await session.execute(
                    text("SELECT 1 FROM sectores WHERE id = :id AND is_active = TRUE"),
                    {"id": sector_id},
                )
                if valid.fetchone():
                    updates.append("sector_id = :sector_id")
                    params["sector_id"] = sector_id
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
    # Caso "afiliado confirmo la oferta del bot" — usa handoff_confirmed,
    # distinto del handoff_auto que se muestra cuando el sistema deriva sin
    # preguntar (regla 2 / boton "pedir humano").
    messages = config["transition_messages"]
    msg = (messages.get("handoff_confirmed")
           or messages.get("handoff_auto")
           or "Listo, tu solicitud fue recibida. Un operador te atenderá en breve.")
    await request_handoff(conversation_id, tenant_id, msg)
    return {"status": ConvStatus.HANDOFF_REQUESTED, "message": msg}


# ── Feedback al cierre (caritas 1-3) ─────────────────────────────────────────

# Chips de causa que ofrece el frontend con 😞/😐. Un reason desconocido se
# descarta en silencio (no debe romper el voto). Constante de módulo — dentro
# del BaseModel, pydantic v2 lo convertiría en private attr inaccesible.
VALID_FEEDBACK_REASONS = {"not_found", "wrong_info", "slow_service"}


class FeedbackRequest(BaseModel):
    """Calificación del afiliado al cierre. rating: 1=😞 2=😐 3=😊.
    reason: chip opcional, solo tiene sentido con rating 1-2."""
    rating: int = Field(..., ge=1, le=3)
    reason: str | None = Field(None, max_length=40)


@router.post("/widget/conversation/{conversation_id}/feedback")
async def submit_feedback(
    conversation_id: str,
    widget_session_id: str,
    body: FeedbackRequest,
    tenant_id: str = Depends(get_tenant_id),
    widget_user: CurrentUser = Depends(get_widget_or_chat_user),
):
    """Registra la calificación del afiliado. Reglas:
    - Anti-IDOR: la conversación debe pertenecer al widget_session_id.
    - Solo conversaciones CERRADAS (el feedback es "al cierre" por diseño).
    - Una sola vez (el primer voto queda; no se pisa).
    - rating 1-2 → entra a la cola de revisión del admin (pending).
    Fuera del camino de la consulta: no toca el pipeline del bot.
    """
    reason = body.reason if body.reason in VALID_FEEDBACK_REASONS else None
    review_status = "pending" if body.rating <= 2 else None

    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            UPDATE conversaciones
            SET feedback_rating = :rating,
                feedback_reason = :reason,
                feedback_at = NOW(),
                feedback_review_status = :review_status
            WHERE id = :cid
              AND widget_session_id = :sid
              AND status = 'closed'
              AND feedback_rating IS NULL
            RETURNING id
        """), {
            "rating": body.rating, "reason": reason,
            "review_status": review_status,
            "cid": conversation_id, "sid": widget_session_id,
        })
        if result.fetchone() is None:
            # Diagnóstico fino para el 4xx correcto (sin filtrar existencia ajena)
            check = await session.execute(text("""
                SELECT status, feedback_rating FROM conversaciones
                WHERE id = :cid AND widget_session_id = :sid
            """), {"cid": conversation_id, "sid": widget_session_id})
            row = check.mappings().fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="No encontramos la conversación.")
            if row["feedback_rating"] is not None:
                raise HTTPException(status_code=409, detail="Esta conversación ya fue calificada.")
            raise HTTPException(status_code=409, detail="La conversación todavía no está cerrada.")

    logger.info(
        "feedback_submitted conversation_id=%s tenant=%s rating=%d reason=%s",
        conversation_id, tenant_id, body.rating, reason,
    )
    return {"status": "ok", "rating": body.rating}


# ── Operators online count ────────────────────────────────────────────────────

@router.get("/widget/operators-online")
async def operators_online(
    sector_id: str | None = None,
    tenant_id: str = Depends(get_tenant_id),
    widget_user: CurrentUser = Depends(get_widget_or_chat_user),
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
