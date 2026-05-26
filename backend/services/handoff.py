"""Handoff detection and conversation state management.

Handles the 4 derivation rules:
  Rule 1 — 2 consecutive insufficient responses
  Rule 2 — Repeated human request (2+)
  Rule 3 — Frustration signal on first occurrence
  Rule 4 — Operator inactivity alert (Celery task)

State machine:
  bot_active → handoff_requested → human_attending → closed

Signals are accumulated per conversation in Redis (lightweight, no DB write per turn).
DB is written only when state transitions occur.
"""

import json
import logging
import re
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)

_REDIS_PREFIX = "handoff:"
_SIGNAL_TTL = 3600 * 24  # 24h

# Cooldown anti-duplicado: si ya se ofrecio handoff (Regla 1 o 3) y todavia
# esta vigente, no volver a ofrecer en cada turno hasta que pase la ventana.
# El afiliado puede ignorar la primera oferta y seguir chateando — no queremos
# inundarlo con la misma tarjeta. Si confirma o si la situacion cambia
# (frustracion explicita), igual se evalua en _try_offer_again_after.
_OFFER_COOLDOWN_KEY = "handoff_offer_pending:"
_OFFER_COOLDOWN_TTL = 90  # seconds — match conversational rhythm


class ConvStatus(str, Enum):
    BOT_ACTIVE         = "bot_active"
    HANDOFF_REQUESTED  = "handoff_requested"
    HUMAN_ATTENDING    = "human_attending"
    CLOSED             = "closed"


class HandoffTrigger(str, Enum):
    NONE         = "none"
    INSUFFICIENT = "insufficient"  # bot no encontro respuesta N veces
    MANUAL       = "manual"        # afiliado clickeo "Pedir humano"


@dataclass
class HandoffSignal:
    trigger:      HandoffTrigger
    auto_activate: bool   # siempre False — el afiliado decide via cartel + DNI
    offer_message: str    # texto del cartel amarillo


_CHITCHAT_RE = re.compile(
    r"^\s*(hola|hi|hello|buenos?\s+d[ií]as?|buenas?\s+tardes?|buenas?\s+noches?|"
    r"todo\s+bien|ok|okay|gracias?|de\s+nada|si|sí|no|claro|dale|genial|"
    r"perfecto|entendido|listo|bueno|bien|excelente|muy\s+bien)\s*[!.?]?\s*$",
    re.IGNORECASE,
)

_MIN_WORDS_FOR_INSUFFICIENT = 4  # queries with fewer words are treated as chitchat

# Frases que el LLM emite (según el template anti-alucinación) cuando no pudo
# responder con el contexto disponible. Detectarlas es la señal autoritativa
# de insuficiencia: el propio modelo declara que no tiene la información.
_BOT_NO_INFO_PATTERNS = (
    "no encontré esa información",
    "no encontré información",
    "no tengo información sobre",
    "no tengo esa información",
    "no dispongo de información",
    "no cuento con información",
    "no puedo responder con la información disponible",
    "no figura en los documentos",
    "consultar directamente con el área",
    "te sugiero consultar",
)


def _bot_signaled_no_info(bot_answer: str) -> bool:
    if not bot_answer:
        return False
    lowered = bot_answer.lower()
    return any(p in lowered for p in _BOT_NO_INFO_PATTERNS)


def _is_response_insufficient(
    sources: list,
    intent_confidence: float | None,
    user_message: str,
    bot_answer: str,
) -> bool:
    """True solo si el bot realmente no pudo responder.

    Señal autoritativa: el propio LLM, siguiendo las reglas anti-alucinación,
    devolvió una frase del tipo "no encontré esa información". Esa decisión la
    toma el modelo viendo todo el contexto disponible (sources nuevas + historial
    conversacional) y por eso es más robusta que mirar solo `sources`.

    Saludos, respuestas cortas y chitchat no cuentan: el bot responde
    correctamente sin sources en esos casos.
    """
    msg = user_message.strip()

    if len(msg.split()) < _MIN_WORDS_FOR_INSUFFICIENT:
        return False
    if _CHITCHAT_RE.match(msg):
        return False

    # Señal fuerte: el bot explícitamente declaró que no encontró la información.
    if _bot_signaled_no_info(bot_answer):
        return True

    # Señal débil de respaldo: confianza muy baja Y sin sources. Ambas a la vez
    # — cualquiera sola puede ser un follow-up válido resuelto por historial.
    if (
        not sources
        and intent_confidence is not None
        and intent_confidence < 0.2
    ):
        return True

    return False


# ── Signal accumulation in Redis ──────────────────────────────────────────────

async def _get_signals(conversation_id: str) -> dict:
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        raw = await redis.get(f"{_REDIS_PREFIX}{conversation_id}")
        if raw:
            return json.loads(raw)
    except Exception as exc:
        logger.debug("handoff_redis_read_error error=%s", exc)
    return {"insufficient_count": 0}


async def _save_signals(conversation_id: str, signals: dict) -> None:
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        await redis.setex(f"{_REDIS_PREFIX}{conversation_id}", _SIGNAL_TTL, json.dumps(signals))
    except Exception as exc:
        logger.debug("handoff_redis_write_error error=%s", exc)


async def _is_offer_pending(conversation_id: str) -> bool:
    """True si ya hay una oferta de handoff vigente para esta conversacion."""
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        return bool(await redis.get(f"{_OFFER_COOLDOWN_KEY}{conversation_id}"))
    except Exception:
        return False


async def _mark_offer_pending(conversation_id: str) -> None:
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        await redis.setex(f"{_OFFER_COOLDOWN_KEY}{conversation_id}", _OFFER_COOLDOWN_TTL, "1")
    except Exception as exc:
        logger.debug("handoff_offer_mark_error error=%s", exc)


async def clear_offer_pending(conversation_id: str) -> None:
    """Llamar al confirmar/aceptar/declinar la oferta para liberar el cooldown."""
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        await redis.delete(f"{_OFFER_COOLDOWN_KEY}{conversation_id}")
    except Exception:
        pass


# ── Main evaluation ───────────────────────────────────────────────────────────

async def evaluate_handoff(
    conversation_id: str,
    tenant_id: str,
    user_message: str,
    sources: list,
    intent_confidence: float | None,
    bot_answer: str = "",
) -> HandoffSignal:
    """Decide si ofrecer derivacion despues del turno actual del bot.

    Hay una sola regla: si el bot respondio 'no encontre la informacion'
    N veces seguidas (N = consecutive_insufficient_count del tenant, default 3),
    se ofrece un cartel amarillo. El afiliado decide aceptar via DNI.

    El cooldown de 90s evita que se apilen carteles si el afiliado ignora
    el primero y el bot sigue sin poder responder.
    """
    config = await _get_handoff_config(tenant_id)
    signals = await _get_signals(conversation_id)
    offer_pending = await _is_offer_pending(conversation_id)

    if _is_response_insufficient(sources, intent_confidence, user_message, bot_answer):
        signals["insufficient_count"] = signals.get("insufficient_count", 0) + 1
        await _save_signals(conversation_id, signals)
        threshold = config["consecutive_insufficient_count"]
        if signals["insufficient_count"] >= threshold:
            logger.info(
                "handoff_insufficient conversation_id=%s count=%d threshold=%d",
                conversation_id, signals["insufficient_count"], threshold,
            )
            if offer_pending:
                return HandoffSignal(trigger=HandoffTrigger.NONE, auto_activate=False, offer_message="")
            # Disparar oferta: reset counter + cooldown 90s
            signals["insufficient_count"] = 0
            await _save_signals(conversation_id, signals)
            await _mark_offer_pending(conversation_id)
            return HandoffSignal(
                trigger=HandoffTrigger.INSUFFICIENT,
                auto_activate=False,
                offer_message=config["transition_messages"]["handoff_offer"],
            )
    elif signals.get("insufficient_count", 0) > 0:
        # Respuesta exitosa, chitchat o follow-up resuelto -> reset contador.
        signals["insufficient_count"] = 0
        await _save_signals(conversation_id, signals)

    return HandoffSignal(trigger=HandoffTrigger.NONE, auto_activate=False, offer_message="")


# ── State transitions in DB ───────────────────────────────────────────────────

async def request_handoff(conversation_id: str, tenant_id: str, message: str) -> None:
    """Transition conversation to handoff_requested and persist system message."""
    from core.database import get_pg_session
    from sqlalchemy import text

    async with get_pg_session(tenant_id) as session:
        await session.execute(text("""
            UPDATE conversaciones
            SET status = 'handoff_requested', updated_at = NOW()
            WHERE id = :id AND status = 'bot_active'
        """), {"id": conversation_id})
        await session.execute(text("""
            INSERT INTO mensajes (conversation_id, sender_type, content)
            VALUES (:cid, 'system', :msg)
        """), {"cid": conversation_id, "msg": message})

    logger.info("handoff_requested conversation_id=%s tenant=%s", conversation_id, tenant_id)

    # La oferta dejo de estar vigente: o el usuario confirmo, o el sistema
    # activo auto-handoff. En cualquier caso, liberamos el cooldown.
    await clear_offer_pending(conversation_id)

    # Notify all connected operators in real time
    import asyncio
    from services.events import publish
    asyncio.ensure_future(publish(tenant_id, "handoff_requested", {
        "conversation_id": conversation_id,
    }))


async def get_default_sector_id(tenant_id: str) -> str | None:
    """Return the sector marked as default, falling back to 'Consultas Generales'."""
    from core.database import get_pg_session
    from sqlalchemy import text

    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            SELECT id FROM sectores
            WHERE is_active = TRUE
            ORDER BY is_default DESC, (nombre = 'Consultas Generales') DESC, created_at ASC
            LIMIT 1
        """))
        row = result.fetchone()
        return str(row[0]) if row else None


# ── Config loader ─────────────────────────────────────────────────────────────

_config_cache: dict[str, dict] = {}


async def _get_handoff_config(tenant_id: str) -> dict:
    """Load handoff config from DB (cached in memory for 60s)."""
    import time
    cached = _config_cache.get(tenant_id)
    if cached and time.monotonic() - cached["_ts"] < 60:
        return cached

    try:
        from core.database import get_pg_session
        from sqlalchemy import text

        async with get_pg_session(tenant_id) as session:
            result = await session.execute(text("""
                SELECT consecutive_insufficient_count, transition_messages
                FROM handoff_config LIMIT 1
            """))
            row = result.mappings().fetchone()

        config = {
            "consecutive_insufficient_count": row["consecutive_insufficient_count"] if row else 3,
            "transition_messages":            dict(row["transition_messages"]) if row else {},
            "_ts": time.monotonic(),
        }
    except Exception as exc:
        logger.warning("handoff_config_load_failed tenant=%s error=%s", tenant_id, exc)
        config = {
            "consecutive_insufficient_count": 3,
            "transition_messages": {
                "handoff_offer": "¿Querés que te conecte con un operador?",
                "handoff_confirmed": "Listo, tu solicitud fue recibida. Un operador te atenderá en breve.",
                "operator_inactive_alert": "Seguís en cola. Lamentamos la demora.",
            },
            "_ts": time.monotonic(),
        }

    _config_cache[tenant_id] = config
    return config


def invalidate_config_cache(tenant_id: str) -> None:
    """Call after admin updates handoff config."""
    _config_cache.pop(tenant_id, None)
