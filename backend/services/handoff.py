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


def _is_response_insufficient(sources: list, intent_confidence: float | None) -> bool:
    """Insufficient = no sources found OR very low intent confidence."""
    if not sources:
        return True
    if intent_confidence is not None and intent_confidence < 0.3:
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
    return {"insufficient_count": 0, "human_request_count": 0}


async def _save_signals(conversation_id: str, signals: dict) -> None:
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        await redis.setex(f"{_REDIS_PREFIX}{conversation_id}", _SIGNAL_TTL, json.dumps(signals))
    except Exception as exc:
        logger.debug("handoff_redis_write_error error=%s", exc)


# ── Main evaluation ───────────────────────────────────────────────────────────

async def evaluate_handoff(
    conversation_id: str,
    tenant_id: str,
    user_message: str,
    sources: list,
    intent_confidence: float | None,
) -> HandoffSignal:
    """Evaluate handoff rules after each bot turn. Returns a HandoffSignal."""
    config = await _get_handoff_config(tenant_id)
    signals = await _get_signals(conversation_id)

    # ── Rule 3: Frustration signal ─────────────────────────────────────────────
    if _is_frustrated(user_message, config["frustration_phrases"]):
        logger.info("handoff_rule3_frustration conversation_id=%s", conversation_id)
        return HandoffSignal(
            trigger=HandoffTrigger.FRUSTRATION,
            auto_activate=False,
            offer_message=config["transition_messages"]["handoff_offer"],
        )

    # ── Rule 2: Human request tracking ────────────────────────────────────────
    if _is_human_request(user_message):
        signals["human_request_count"] = signals.get("human_request_count", 0) + 1
        await _save_signals(conversation_id, signals)
        if signals["human_request_count"] >= 2:
            logger.info("handoff_rule2_repeated conversation_id=%s count=%d", conversation_id, signals["human_request_count"])
            return HandoffSignal(
                trigger=HandoffTrigger.HUMAN_REQUEST,
                auto_activate=True,
                offer_message=config["transition_messages"]["handoff_auto"],
            )
        # First request — offer but don't auto-activate
        return HandoffSignal(
            trigger=HandoffTrigger.HUMAN_REQUEST,
            auto_activate=False,
            offer_message=config["transition_messages"]["handoff_offer"],
        )

    # ── Rule 1: Insufficient responses ────────────────────────────────────────
    if _is_response_insufficient(sources, intent_confidence):
        signals["insufficient_count"] = signals.get("insufficient_count", 0) + 1
        await _save_signals(conversation_id, signals)
        threshold = config["consecutive_insufficient_count"]
        if signals["insufficient_count"] >= threshold:
            logger.info(
                "handoff_rule1_insufficient conversation_id=%s count=%d threshold=%d",
                conversation_id, signals["insufficient_count"], threshold,
            )
            return HandoffSignal(
                trigger=HandoffTrigger.INSUFFICIENT,
                auto_activate=False,
                offer_message=config["transition_messages"]["handoff_offer"],
            )
    else:
        # Reset insufficient count on successful response
        if signals.get("insufficient_count", 0) > 0:
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


async def get_default_sector_id(tenant_id: str) -> str | None:
    """Return the 'Consultas Generales' sector id."""
    from core.database import get_pg_session
    from sqlalchemy import text

    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text("SELECT id FROM sectores WHERE nombre = 'Consultas Generales' LIMIT 1")
        )
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
            "consecutive_insufficient_count": 2,
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
