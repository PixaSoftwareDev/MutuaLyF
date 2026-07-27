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
    KEYWORD      = "keyword"       # Regla 5: el mensaje menciona un tema derivable (config del tenant)


@dataclass
class HandoffSignal:
    trigger:      HandoffTrigger
    auto_activate: bool   # siempre False — el afiliado decide via cartel + DNI
    offer_message: str    # texto del cartel amarillo
    # Regla 5 (responder-y-ofrecer): la respuesta del bot SE MUESTRA igual y el
    # cartel va debajo. En las reglas por fallo (insuficiente) la respuesta
    # genérica es redundante con la oferta y se suprime — acá NO: el afiliado
    # pudo preguntar info que el bot sí tiene ("¿qué llevo al turno?").
    keep_answer:  bool = False


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

_NO_INFO_PATTERNS = [
    "No encontré esa información",
    "fuera de mi área de conocimiento",  # respuesta de bot con bot_scope configurado
]

def _is_response_insufficient(
    sources: list,
    user_message: str,
    bot_answer: str = "",
) -> bool:
    """True si el turno cuenta como "el bot no pudo responder".

    Dos señales (cualquiera basta):
    1. El bot_answer contiene una frase de "no sé" — cubre respuestas cacheadas
       y casos donde el LLM rechaza la query por bot_scope aunque el RAG haya
       devuelto sources con low_confidence=None.
    2. El RAG no devolvió ninguna source de alta confianza — señal original.

    Filtros para evitar falsos positivos:
    - Saludos y respuestas cortas (chitchat) no cuentan.
    """
    msg = user_message.strip()

    if len(msg.split()) < _MIN_WORDS_FOR_INSUFFICIENT:
        return False
    if _CHITCHAT_RE.match(msg):
        return False

    # Señal 1: el bot explícitamente dijo que no puede responder.
    if any(p in (bot_answer or "") for p in _NO_INFO_PATTERNS):
        return True

    # Señal 2: sources con low_confidence=True son el fallback del orquestador.
    has_high_confidence = any(not s.get("low_confidence") for s in sources)
    return not has_high_confidence


def _is_chitchat(user_message: str) -> bool:
    """True si el mensaje es solo saludo/cortesía/confirmación, no una consulta real.

    Se usa para tratar la charla como NEUTRAL en evaluate_handoff: un "gracias"/"ok"
    entre dos fallos no debe resetear el contador de insuficiencia ni cancelar una
    derivación ya ofrecida.
    """
    return bool(_CHITCHAT_RE.match(user_message.strip()))


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


# ── Regla 5: derivación proactiva por palabras clave ──────────────────────────

# Una vez mostrada la oferta por keyword, no re-ofrecer por la misma vía durante
# esta ventana aunque el afiliado siga mencionando el tema en cada mensaje.
# (El cooldown corto de 90s es para el ritmo conversacional de las reglas por
# fallo; acá el tema no desaparece de la charla y 90s spamearía.)
_KEYWORD_OFFERED_KEY = "handoff_kw_offered:"
_KEYWORD_OFFERED_TTL = 3600  # 1h por conversación


def _norm_kw(s: str) -> str:
    """lower + sin tildes + solo alfanuméricos separados por espacios simples.
    Da bordes de palabra reales: 'turno' NO matchea dentro de 'saturno'."""
    import unicodedata
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"[^a-z0-9ñ]+", " ", s)
    return f" {s.strip()} "


def match_keyword_trigger(user_message: str, groups: list) -> dict | None:
    """Primer grupo cuyo words matchea el mensaje como palabra/frase completa,
    insensible a tildes y mayúsculas. None si ninguno."""
    if not groups or not user_message:
        return None
    haystack = _norm_kw(user_message)
    for group in groups:
        for word in (group.get("words") or []):
            needle = _norm_kw(str(word))
            if needle.strip() and needle in haystack:
                return group
    return None


async def _is_keyword_offered(conversation_id: str) -> bool:
    from core.database import get_redis_cache
    try:
        redis = await get_redis_cache()
        return await redis.exists(f"{_KEYWORD_OFFERED_KEY}{conversation_id}") > 0
    except Exception:
        return False


async def mark_keyword_offered(conversation_id: str) -> None:
    """La marca el CALLER y solo si el cartel efectivamente se mostró."""
    from core.database import get_redis_cache
    try:
        redis = await get_redis_cache()
        await redis.set(f"{_KEYWORD_OFFERED_KEY}{conversation_id}", "1", ex=_KEYWORD_OFFERED_TTL)
    except Exception as exc:
        logger.warning("handoff_kw_mark_failed conversation_id=%s error=%s", conversation_id, exc)


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


async def _consume_pending_offers(conversation_id: str, tenant_id: str) -> None:
    """Marca las ofertas de handoff vigentes como consumidas (is_handoff_offer=FALSE)
    para que el frontend deje de renderizar el cartel amarillo. El flag pasa a
    significar 'oferta vigente del momento actual', no 'hubo una oferta alguna vez'."""
    try:
        from core.database import get_pg_session
        from sqlalchemy import text
        async with get_pg_session(tenant_id) as session:
            await session.execute(text("""
                UPDATE mensajes SET is_handoff_offer = FALSE
                WHERE conversation_id = :cid AND is_handoff_offer = TRUE
            """), {"cid": conversation_id})
    except Exception as exc:
        logger.debug("handoff_consume_offers_error error=%s", exc)


async def reset_handoff_signals(conversation_id: str, tenant_id: str) -> None:
    """Resetea TODO el estado de handoff de una conversación.

    DEBE llamarse en cada transición que cambia la fase (accept, return_to_bot,
    release, transfer, close). Sin esto, el contador de respuestas insuficientes
    (TTL 24h) y el cooldown de oferta (90s) sobreviven a la fase humana, y al
    volver a bot_active el bot NO vuelve a ofrecer operador en el siguiente ciclo.
    También consume las ofertas previas para que el cartel no quede colgado.
    """
    await _reset_insufficient(conversation_id)
    await clear_offer_pending(conversation_id)
    await _consume_pending_offers(conversation_id, tenant_id)


# ── Main evaluation ───────────────────────────────────────────────────────────

async def evaluate_handoff(
    conversation_id: str,
    tenant_id: str,
    user_message: str,
    sources: list,
    bot_answer: str = "",
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

    # ── Regla 5 (primera): tema derivable por palabras clave del tenant ───────
    # Responder-y-ofrecer: keep_answer=True → el caller muestra la respuesta del
    # bot Y el cartel. No toca el contador de insuficientes (son señales
    # independientes) y tiene su propia supresión de 1h por conversación.
    group = match_keyword_trigger(user_message, config.get("keyword_triggers") or [])
    if group is not None and not offer_pending and not await _is_keyword_offered(conversation_id):
        logger.info(
            "handoff_keyword conversation_id=%s words=%s",
            conversation_id, (group.get("words") or [])[:5],
        )
        return HandoffSignal(
            trigger=HandoffTrigger.KEYWORD,
            auto_activate=False,
            offer_message=(group.get("message") or "").strip()
                or config["transition_messages"].get(
                    "handoff_offer", "¿Querés que te conecte con un operador?"
                ),
            keep_answer=True,
        )

    if _is_response_insufficient(sources, user_message, bot_answer):
        count = await _incr_insufficient(conversation_id)
        threshold = config["consecutive_insufficient_count"]
        if count >= threshold:
            logger.info(
                "handoff_insufficient conversation_id=%s count=%d threshold=%d",
                conversation_id, count, threshold,
            )
            if offer_pending:
                return HandoffSignal(trigger=HandoffTrigger.NONE, auto_activate=False, offer_message="")
            # Disparar oferta: reset counter. El cooldown (_mark_offer_pending) NO
            # se setea acá — lo setea el CALLER y SOLO si efectivamente muestra el
            # cartel (hay operadores online). Marcarlo acá ponía el cooldown de 90s
            # aunque luego no hubiera operadores y el cartel nunca se mostrara,
            # bloqueando re-ofrecer incluso si aparece un operador en esos 90s.
            await _reset_insufficient(conversation_id)
            return HandoffSignal(
                trigger=HandoffTrigger.INSUFFICIENT,
                auto_activate=False,
                offer_message=config["transition_messages"]["handoff_offer"],
            )
    elif _is_chitchat(user_message):
        # Charla/cortesía ("gracias", "ok", "listo"): turno NEUTRAL. No incrementa ni
        # resetea el contador, ni consume ofertas. Un saludo en el medio de fallos no
        # debe borrar la frustración acumulada ni cancelar una derivación ya ofrecida.
        pass
    else:
        # Respuesta exitosa o follow-up resuelto -> reset contador.
        # Solo borrar si esta presente (evita round-trip innecesario).
        if await _get_insufficient(conversation_id) > 0:
            await _reset_insufficient(conversation_id)
        # Respuesta buena → solo levantar el cooldown de 90s. NO consumir las
        # ofertas (incidente 2026-07-27): apagar is_handoff_offer de carteles ya
        # mostrados les quitaba el botón RETROACTIVAMENTE — el afiliado veía la
        # oferta, preguntaba otra cosa, y al volver el cartel era texto muerto
        # (y confirm-handoff daba 409). Política fail-soft: la puerta de la
        # derivación queda SIEMPRE abierta; un cartel viejo clickeable no daña.
        if any(not s.get("low_confidence") for s in sources):
            await clear_offer_pending(conversation_id)

    return HandoffSignal(trigger=HandoffTrigger.NONE, auto_activate=False, offer_message="")


# ── State transitions in DB ───────────────────────────────────────────────────

async def release_operator_conversations(session, operator_id: str) -> int:
    """Devuelve a la cola las conversaciones que el operador estaba atendiendo.

    Se llama al desactivar o quitar un operador para que sus conversaciones
    'human_attending' no queden huérfanas (asignadas a alguien que ya no atiende):
    otro operador del sector las puede tomar. Corre en la session/transacción del
    caller — la atomicidad la garantiza el caller. Devuelve cuántas liberó.
    """
    from sqlalchemy import text
    result = await session.execute(text("""
        UPDATE conversaciones
        SET status = 'handoff_requested',
            assigned_operator_id = NULL,
            handoff_requested_at = NOW(),
            updated_at = NOW()
        WHERE assigned_operator_id = :uid AND status = 'human_attending'
        RETURNING id
    """), {"uid": operator_id})
    return len(result.fetchall())


async def request_handoff(conversation_id: str, tenant_id: str, message: str) -> None:
    """Transition conversation to handoff_requested and persist system message."""
    from core.database import get_pg_session
    from sqlalchemy import text

    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            UPDATE conversaciones
            SET status = 'handoff_requested', handoff_requested_at = NOW(), updated_at = NOW()
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
                SELECT consecutive_insufficient_count, attention_hours, contact_info,
                       transition_messages, keyword_triggers
                FROM handoff_config LIMIT 1
            """))
            row = result.mappings().fetchone()

        config = {
            "consecutive_insufficient_count": row["consecutive_insufficient_count"] if row else 3,
            "attention_hours":                row["attention_hours"] if row else None,
            "contact_info":                   row["contact_info"] if row else None,
            "transition_messages":            dict(row["transition_messages"]) if row else {},
            "keyword_triggers":               list(row["keyword_triggers"] or []) if row else [],
            "_ts": time.monotonic(),
        }
    except Exception as exc:
        logger.warning("handoff_config_load_failed tenant=%s error=%s", tenant_id, exc)
        config = {
            "consecutive_insufficient_count": 3,
            "attention_hours": None,
            "contact_info": None,
            "transition_messages": {
                "handoff_offer": "¿Querés que te conecte con un operador?",
                "handoff_confirmed": "Listo, tu solicitud fue recibida. Un operador te atenderá en breve.",
                "operator_inactive_alert": "Seguís en cola. Lamentamos la demora.",
            },
            "keyword_triggers": [],
            "_ts": time.monotonic(),
        }

    _config_cache[tenant_id] = config
    return config


def invalidate_config_cache(tenant_id: str) -> None:
    """Call after admin updates handoff config."""
    _config_cache.pop(tenant_id, None)


# ── Operator availability ──────────────────────────────────────────────────────

async def has_online_operators(tenant_id: str, sector_id: str | None) -> bool:
    """True si hay al menos un operador online que pueda atender este sector.

    Es la señal AUTORITATIVA para decidir si tiene sentido ofrecer derivación:
    sin operadores conectados, derivar mandaría al afiliado a una cola vacía.
    Sin sector_id, cualquier operador online cuenta.
    """
    from services.events import get_online_operators
    online = await get_online_operators(tenant_id)
    if not online:
        return False
    if not sector_id:
        return True
    online_ids = [o["user_id"] for o in online]
    from core.database import get_pg_session
    from sqlalchemy import text
    placeholders = ", ".join(f":uid_{i}" for i in range(len(online_ids)))
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text(f"""
            SELECT 1 FROM operador_sectores
            WHERE sector_id = :sector_id AND operador_id::text IN ({placeholders})
            LIMIT 1
        """), {"sector_id": sector_id, **{f"uid_{i}": uid for i, uid in enumerate(online_ids)}})
        return result.fetchone() is not None


def build_no_operators_message(config: dict) -> str:
    """Mensaje cuando el afiliado necesitaría un operador pero no hay ninguno online.
    Incluye el horario de atención y el contacto del tenant si están configurados."""
    parts = ["En este momento no hay operadores disponibles para atenderte."]
    hours = (config.get("attention_hours") or "").strip()
    if hours:
        parts.append(f"Nuestro horario de atención es: {hours}.")
    contact = (config.get("contact_info") or "").strip()
    if contact:
        parts.append(f"También podés comunicarte: {contact}.")
    return " ".join(parts)


# ── Pedido de humano por TEXTO (widget) — determinístico, sin LLM ────────────
# Incidente 2026-07-27: tras la invitación de la regla 13 ("¿querés que te
# derive?"), el afiliado escribió "si" y el LLM PROMETIÓ derivar sin hacerlo.
# El pedido de humano y la afirmación post-invitación se capturan ANTES del
# LLM: respuesta determinística + cartel fresco. El LLM jamás gestiona.

_HUMAN_REQUEST_RE = re.compile(
    r"(quiero|necesito|puedo|dame|pasame|comunicame|conectame)?\s*"
    r"(hablar|chatear|comunicarme|que me atienda|atenderme)?\s*"
    r"(con\s+)?(un[ao]?\s+)?(operador[a]?|humano|persona\s+real|una\s+persona|asesor[a]?|agente)\b"
    r"|^\s*operador[a]?\s*[.!]*\s*$",
    re.IGNORECASE,
)
_BARE_AFFIRM_RE = re.compile(r"^\s*(si|sí|dale|ok|okey|bueno|obvio|claro|quiero)\s*[.!]*\s*$", re.IGNORECASE)


def is_explicit_human_request(message: str) -> bool:
    """El mensaje pide hablar con una persona (formas explícitas)."""
    if not message:
        return False
    m = message.strip()
    # Evitar falsos positivos de preguntas informativas ("¿el operador atiende
    # los sábados?"): exigir intención en primera persona o la palabra sola.
    if re.match(r"^\s*operador[a]?\s*[.!?]*\s*$", m, re.IGNORECASE):
        return True
    return bool(re.search(
        r"(quiero|necesito|me\s+gustar[ií]a|pod[ée]s|puedo|prefiero)\b[^.?!]{0,40}"
        r"\b(operador[a]?|humano|persona|asesor[a]?|agente)\b",
        m, re.IGNORECASE,
    ))


def is_bare_affirmation(message: str) -> bool:
    """'sí' / 'dale' / 'ok' a secas — solo cuenta como pedido de derivación si
    lo último que dijo el sistema/bot invitaba a derivar (lo decide el caller)."""
    return bool(message and _BARE_AFFIRM_RE.match(message.strip()))


def offer_expectation_suffix(config: dict) -> str:
    """Sufijo para la OFERTA de derivación cuando no se detectan operadores
    conectados. Política fail-soft (2026-07-27): la presencia no bloquea la
    derivación — solo ajusta la expectativa. Si la presencia mintió (pestaña
    en background, socket caído), el afiliado igual entra a la fila."""
    parts = [
        "\n\nEn este momento no vemos operadores conectados — tu consulta "
        "queda en la fila y te responden a la brevedad."
    ]
    hours = (config.get("attention_hours") or "").strip()
    if hours:
        parts.append(f" Horario de atención: {hours}.")
    return "".join(parts)


def build_no_info_message(config: dict) -> str:
    """Mensaje determinístico cuando el RAG no encontró información confiable.

    Se devuelve SIN llamar al LLM → cero posibilidad de alucinación. Reutiliza el
    contact_info del tenant (mismo campo que el mensaje de no-operadores)."""
    base = "No encontré esa información en los documentos disponibles."
    contact = (config.get("contact_info") or "").strip()
    if contact:
        return f"{base} Para más ayuda podés comunicarte: {contact}."
    return f"{base} Te recomiendo consultar directamente con la organización."
