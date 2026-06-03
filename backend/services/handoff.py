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

from core.audit import fire_and_log

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

_MIN_WORDS_FOR_INSUFFICIENT = 1  # Solo descarta mensajes vacíos. Una consulta de
# 1 palabra es legítima ("cardiología", "amparo", "autorizaciones") y debe contar
# si el RAG no la pudo responder. Los saludos/confirmaciones de 1 palabra los
# filtra _CHITCHAT_RE; la señal autoritativa de insuficiencia la da el RAG.

def _is_response_insufficient(
    sources: list,
    user_message: str,
) -> bool:
    """True si el turno cuenta como "el bot no pudo responder".

    Senial autoritativa: ¿el RAG devolvio fuentes de confianza normal?

    El orquestador tiene un "low_confidence_fallback": si ningun chunk supero
    el threshold de relevancia, igual mete los top-N chunks "menos malos" en
    sources con flag low_confidence=true para que el LLM intente una respuesta
    cautelosa. Para handoff esos chunks NO valen — son ruido. Solo contamos
    el turno como suficiente si hubo al menos una source de confianza normal.

    Inmune a paráfrasis del LLM: la senial viene del RAG, no del texto.

    Filtros para evitar falsos positivos:
    - Saludos y respuestas cortas (chitchat) no cuentan.
    """
    msg = user_message.strip()

    if len(msg.split()) < _MIN_WORDS_FOR_INSUFFICIENT:
        return False
    if _CHITCHAT_RE.match(msg):
        return False

    # sources con low_confidence=True son el fallback del orquestador para
    # que el LLM no responda "no se" en seco. No cuentan como respuesta valida.
    has_high_confidence = any(not s.get("low_confidence") for s in sources)
    return not has_high_confidence


# ── Signal accumulation in Redis ──────────────────────────────────────────────
#
# Antes: get → json.loads → setex. Race condition: dos turnos concurrentes leen
# count=2, ambos suben a 3 con setex, ambos disparan handoff offer.
# Ahora: INCR atomico (Redis garantiza atomicidad por comando). El TTL se renueva
# con EXPIRE en el mismo round-trip via pipeline para no perder la ventana.

async def _incr_insufficient(conversation_id: str) -> int:
    """Incremento atomico del contador. Devuelve el valor nuevo."""
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        key = f"{_REDIS_PREFIX}{conversation_id}"
        pipe = redis.pipeline()
        pipe.incr(key)
        pipe.expire(key, _SIGNAL_TTL)
        results = await pipe.execute()
        return int(results[0])
    except Exception as exc:
        logger.debug("handoff_redis_incr_error error=%s", exc)
        return 0


async def _reset_insufficient(conversation_id: str) -> None:
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        await redis.delete(f"{_REDIS_PREFIX}{conversation_id}")
    except Exception as exc:
        logger.debug("handoff_redis_reset_error error=%s", exc)


async def _get_insufficient(conversation_id: str) -> int:
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        raw = await redis.get(f"{_REDIS_PREFIX}{conversation_id}")
        return int(raw) if raw else 0
    except Exception as exc:
        logger.debug("handoff_redis_read_error error=%s", exc)
        return 0


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


async def reset_handoff_signals(conversation_id: str, tenant_id: str) -> None:
    """Resetea TODO el estado de handoff de una conversación.

    DEBE llamarse en cada transición que cambia la fase (accept, return_to_bot,
    release, transfer, close). Sin esto, el contador de respuestas insuficientes
    (TTL 24h) y el cooldown de oferta (90s) sobreviven a la fase humana, y al
    volver a bot_active el bot NO vuelve a ofrecer operador en el siguiente ciclo.

    Además marca las ofertas previas como consumidas (is_handoff_offer=FALSE):
    así ese flag pasa a significar "oferta vigente del ciclo de bot actual" y el
    frontend deja de resucitar la tarjeta amarilla del ciclo anterior.
    """
    await _reset_insufficient(conversation_id)
    await clear_offer_pending(conversation_id)
    try:
        from core.database import get_pg_session
        from sqlalchemy import text
        async with get_pg_session(tenant_id) as session:
            await session.execute(text("""
                UPDATE mensajes SET is_handoff_offer = FALSE
                WHERE conversation_id = :cid AND is_handoff_offer = TRUE
            """), {"cid": conversation_id})
    except Exception as exc:
        logger.debug("handoff_clear_old_offers_error error=%s", exc)


# ── Main evaluation ───────────────────────────────────────────────────────────

async def evaluate_handoff(
    conversation_id: str,
    tenant_id: str,
    user_message: str,
    sources: list,
) -> HandoffSignal:
    """Decide si ofrecer derivacion despues del turno actual del bot.

    Una sola regla: si el RAG devolvio sources vacios N veces seguidas
    (N = consecutive_insufficient_count del tenant, default 3), se ofrece
    el cartel amarillo. El afiliado decide aceptar via DNI.

    Cooldown 90s evita que se apilen carteles si el afiliado ignora el
    primero y el bot sigue sin poder responder.
    """
    config = await _get_handoff_config(tenant_id)
    offer_pending = await _is_offer_pending(conversation_id)

    if _is_response_insufficient(sources, user_message):
        count = await _incr_insufficient(conversation_id)
        threshold = config["consecutive_insufficient_count"]
        if count >= threshold:
            logger.info(
                "handoff_insufficient conversation_id=%s count=%d threshold=%d",
                conversation_id, count, threshold,
            )
            if offer_pending:
                return HandoffSignal(trigger=HandoffTrigger.NONE, auto_activate=False, offer_message="")
            # Disparar oferta: reset counter + cooldown 90s
            await _reset_insufficient(conversation_id)
            await _mark_offer_pending(conversation_id)
            return HandoffSignal(
                trigger=HandoffTrigger.INSUFFICIENT,
                auto_activate=False,
                offer_message=config["transition_messages"]["handoff_offer"],
            )
    else:
        # Respuesta exitosa, chitchat o follow-up resuelto -> reset contador.
        # Solo borrar si esta presente (evita round-trip innecesario).
        if await _get_insufficient(conversation_id) > 0:
            await _reset_insufficient(conversation_id)

    return HandoffSignal(trigger=HandoffTrigger.NONE, auto_activate=False, offer_message="")


# ── State transitions in DB ───────────────────────────────────────────────────

async def request_handoff(conversation_id: str, tenant_id: str, message: str) -> None:
    """Transition conversation to handoff_requested and persist system message."""
    from core.database import get_pg_session
    from sqlalchemy import text

    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            UPDATE conversaciones
            SET status = 'handoff_requested', updated_at = NOW()
            WHERE id = :id AND status = 'bot_active'
            RETURNING id
        """), {"id": conversation_id})
        if result.fetchone() is None:
            # La conversación no estaba en bot_active (ya en cola, atendida o
            # cerrada). No insertar el mensaje system ni publicar el evento:
            # evita el "estado mentido" (cliente recibía handoff_requested y un
            # mensaje fantasma para una conv que no transicionó).
            await clear_offer_pending(conversation_id)
            logger.info("handoff_request_noop conversation_id=%s tenant=%s (no estaba bot_active)", conversation_id, tenant_id)
            return
        await session.execute(text("""
            INSERT INTO mensajes (conversation_id, sender_type, content)
            VALUES (:cid, 'system', :msg)
        """), {"cid": conversation_id, "msg": message})

    logger.info("handoff_requested conversation_id=%s tenant=%s", conversation_id, tenant_id)

    # La oferta dejo de estar vigente: o el usuario confirmo, o el sistema
    # activo auto-handoff. En cualquier caso, liberamos el cooldown.
    await clear_offer_pending(conversation_id)

    # Notify all connected operators in real time
    from services.events import publish
    fire_and_log(publish(tenant_id, "handoff_requested", {
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
