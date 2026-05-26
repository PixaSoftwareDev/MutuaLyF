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
    INSUFFICIENT = "insufficient"    # Rule 1
    HUMAN_REQUEST = "human_request"  # Rule 2
    FRUSTRATION  = "frustration"     # Rule 3


@dataclass
class HandoffSignal:
    trigger:      HandoffTrigger
    auto_activate: bool   # True = no confirmation needed (Rule 2)
    offer_message: str    # message to show the afiliado


# ── Human request detection ───────────────────────────────────────────────────

_HUMAN_REQUEST_PATTERNS = [
    r"\boperador\b", r"\bpersona\b", r"\bhumano\b", r"\bagente\b",
    r"\bhablar\s+con\b", r"\batención\s+personal\b", r"\bme\s+comuniques?\b",
    r"\btransferir\b", r"\bderivá\b", r"\bderiva\b",
]
_HUMAN_RE = re.compile("|".join(_HUMAN_REQUEST_PATTERNS), re.IGNORECASE)


def _is_human_request(text: str) -> bool:
    return bool(_HUMAN_RE.search(text))


def _is_frustrated(text: str, frustration_phrases: list[str]) -> bool:
    text_lower = text.lower()
    return any(phrase.lower() in text_lower for phrase in frustration_phrases)


async def is_explicit_handoff_intent(user_message: str, tenant_id: str) -> bool:
    """Fast path para decidir si saltar el RAG.

    Cuando el usuario explicitamente pide humano o expresa frustracion, no
    tiene sentido invocar al LLM con la pregunta — el bot termina respondiendo
    algo de los documentos y abajo aparece la oferta de operador, textos
    contradictorios. Esta funcion solo mira las Reglas 2 y 3 (las que
    dependen del mensaje del usuario, no de la respuesta del bot).
    """
    if _is_human_request(user_message):
        return True
    config = await _get_handoff_config(tenant_id)
    return _is_frustrated(user_message, config["frustration_phrases"])


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
    """Evaluate handoff rules after each bot turn. Returns a HandoffSignal."""
    config = await _get_handoff_config(tenant_id)
    signals = await _get_signals(conversation_id)
    offer_pending = await _is_offer_pending(conversation_id)

    async def _reset_insufficient_if_needed() -> None:
        if signals.get("insufficient_count", 0) > 0:
            signals["insufficient_count"] = 0
            await _save_signals(conversation_id, signals)

    async def _fire_offer(trigger: HandoffTrigger) -> HandoffSignal:
        """Emite una oferta (no auto-activate), reseteando el contador para
        no re-disparar en el siguiente turno y marcando cooldown."""
        signals["insufficient_count"] = 0
        await _save_signals(conversation_id, signals)
        await _mark_offer_pending(conversation_id)
        return HandoffSignal(
            trigger=trigger,
            auto_activate=False,
            offer_message=config["transition_messages"]["handoff_offer"],
        )

    # ── Rule 3: Frustration signal ─────────────────────────────────────────────
    if _is_frustrated(user_message, config["frustration_phrases"]):
        logger.info("handoff_rule3_frustration conversation_id=%s", conversation_id)
        await _reset_insufficient_if_needed()
        if offer_pending:
            # Ya hay una oferta vigente — no apilar otra.
            return HandoffSignal(trigger=HandoffTrigger.NONE, auto_activate=False, offer_message="")
        return await _fire_offer(HandoffTrigger.FRUSTRATION)

    # ── Rule 2: Human request ─────────────────────────────────────────────────
    # Siempre ofrece, nunca auto-activa. La decision la toma el afiliado
    # clickeando el cartel. Si menciona "operador" varias veces, el cooldown
    # de 90s evita que se apilen tarjetas en cada turno.
    if _is_human_request(user_message):
        logger.info("handoff_rule2_human_request conversation_id=%s", conversation_id)
        if offer_pending:
            return HandoffSignal(trigger=HandoffTrigger.NONE, auto_activate=False, offer_message="")
        return await _fire_offer(HandoffTrigger.HUMAN_REQUEST)

    # ── Rule 1: Insufficient responses ────────────────────────────────────────
    if _is_response_insufficient(sources, intent_confidence, user_message, bot_answer):
        signals["insufficient_count"] = signals.get("insufficient_count", 0) + 1
        await _save_signals(conversation_id, signals)
        threshold = config["consecutive_insufficient_count"]
        if signals["insufficient_count"] >= threshold:
            logger.info(
                "handoff_rule1_insufficient conversation_id=%s count=%d threshold=%d",
                conversation_id, signals["insufficient_count"], threshold,
            )
            if offer_pending:
                return HandoffSignal(trigger=HandoffTrigger.NONE, auto_activate=False, offer_message="")
            return await _fire_offer(HandoffTrigger.INSUFFICIENT)
    else:
        # Cualquier turno no-insuficiente (respuesta exitosa, chitchat, follow-up
        # resuelto por historial) resetea el contador. Sin esto, una respuesta
        # buena entre dos turnos sin sources dispara el cartel amarillo.
        await _reset_insufficient_if_needed()

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
                SELECT consecutive_insufficient_count, frustration_phrases, transition_messages
                FROM handoff_config LIMIT 1
            """))
            row = result.mappings().fetchone()

        config = {
            "consecutive_insufficient_count": row["consecutive_insufficient_count"] if row else 2,
            "frustration_phrases":            list(row["frustration_phrases"]) if row else [],
            "transition_messages":            dict(row["transition_messages"]) if row else {},
            "_ts": time.monotonic(),
        }
    except Exception as exc:
        logger.warning("handoff_config_load_failed tenant=%s error=%s", tenant_id, exc)
        config = {
            "consecutive_insufficient_count": 3,
            "frustration_phrases": ["no me ayuda", "quiero hablar con alguien"],
            "transition_messages": {
                "handoff_offer": "¿Querés que te conecte con un operador?",
                "handoff_auto":  "Te conecto con un operador ahora.",
                "human_assigned": "Un operador se unió a la conversación.",
                "sector_transferred": "Tu consulta fue derivada al área correspondiente.",
                "operator_inactive_alert": "Seguís en cola. Lamentamos la demora.",
                "conversation_closed": "Conversación cerrada. ¡Gracias!",
            },
            "_ts": time.monotonic(),
        }

    _config_cache[tenant_id] = config
    return config


def invalidate_config_cache(tenant_id: str) -> None:
    """Call after admin updates handoff config."""
    _config_cache.pop(tenant_id, None)
