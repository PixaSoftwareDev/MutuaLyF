"""Router de conectores + FSM de login conversacional.

Es el punto de decisión que se inserta ANTES del camino RAG (en la capa de
conversación del widget, que tiene conversation_id y estado — el orquestador es
stateless y el cache RAG es compartido por tenant, así que los datos personales
NO deben pasar por ahí).

Flujo (ver docs/FSM_LOGIN_DISENO.md):
  maybe_handle(...) devuelve:
    - None  → el mensaje NO es de datos personales; el caller sigue con RAG normal.
    - dict con {answer, ...} → el router manejó el turno (paso del FSM, o respuesta
      de la tool ya autenticada).

Estado del flujo por conversación en Redis (DB de sesiones), key flow:{tenant}:{conv}:
  {stage, identity_kind, identity, pending_intent}
Throttle del 2º factor en Redis de rate-limiting.

Seguridad: {identity} sale SIEMPRE de la sesión (server-side); el nombre no
autentica; fail-closed ante cualquier fallo.
"""

from __future__ import annotations

import json
import logging
import re

from core.config import settings
from core.database import get_redis_ratelimit, get_redis_session
from services import session_store
from services.connectors_dao import get_tool_for_intent
from services.connector_executor import (
    AUTH_REQUIRED, EMPTY, FORBIDDEN, OK, UPSTREAM_ERROR,
    execute_tool, validate_second_factor,
)

logger = logging.getLogger(__name__)

_FLOW_TTL_S = 600  # el login no debe quedar colgado más de 10 min

# Stages del FSM.
_ANON = "anon"
_PIDIENDO_ID = "pidiendo_id"
_PIDIENDO_CODIGO = "pidiendo_codigo"

# Frases gatillo.
_CANCEL_RE = re.compile(r"\b(cancelar|salir|dej[aá]|olvidalo|nada)\b", re.I)
_LOGOUT_RE = re.compile(r"\b(cerrar sesi[oó]n|desconectarme|logout|salir de mi cuenta)\b", re.I)
_RESEND_RE = re.compile(r"\b(reenviar|no me lleg[oó]|mand[aá] otro|otro c[oó]digo)\b", re.I)


# ── Mensajes exactos (docs/FSM_LOGIN_DISENO.md) ────────────────────────────────
def _msg_pide_dni() -> str:
    return "Para darte esa información necesito identificarte primero. ¿Me pasás tu *DNI* (sin puntos)?"

def _msg_pide_cuit() -> str:
    return "Para eso necesito identificarte. ¿Me pasás tu *CUIT* (11 números, sin guiones)?"

def _msg_dni_invalido() -> str:
    return "Ese DNI no parece válido. Debería tener 7 u 8 números, sin puntos. ¿Lo intentás de nuevo?"

def _msg_cuit_invalido() -> str:
    return "El CUIT debe tener 11 números, sin guiones (ej. 20304050607). ¿Me lo repetís?"

def _msg_pide_codigo_totp() -> str:
    return "Gracias. Ahora ingresá el *código de 6 dígitos* de tu app de autenticación."

def _msg_pide_codigo_otp() -> str:
    return "Listo. Te envié un *código a tu email/SMS registrado*. ¿Cuál es?"

def _msg_codigo_incorrecto(restantes: int) -> str:
    return f"Ese código no coincide. Te quedan *{restantes} intentos*. Revisá y volvé a ingresarlo."

def _msg_reenviado() -> str:
    return "Te reenvié un código nuevo. Revisá tu app/email/SMS e ingresalo acá."

def _msg_bloqueado() -> str:
    return ("Por seguridad bloqueé los intentos por *15 minutos*. Si no reconocés esta "
            "actividad, comunicate con la Mutual. Podés reintentar más tarde.")

def _msg_upstream() -> str:
    return ("No puedo verificar tu identidad en este momento por un problema técnico. "
            "Probá de nuevo en unos minutos. Mientras tanto puedo ayudarte con información "
            "general (coberturas, requisitos, horarios).")

def _msg_no_existe() -> str:
    # Neutro: no confirmamos ni negamos existencia del DNI (anti-enumeración).
    return ("No pude validar esos datos. Verificá el DNI y el código, o comunicate con "
            "la Mutual si el problema persiste.")

def _msg_sesion_cerrada() -> str:
    return "Cerré tu sesión. Tus datos personales quedan protegidos. ¿Algo más?"


# ── Validadores de formato ─────────────────────────────────────────────────────
def _only_digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")

def valid_dni(s: str) -> bool:
    return len(_only_digits(s)) in (7, 8)

def valid_cuit(s: str) -> bool:
    return len(_only_digits(s)) == 11

def looks_like_topic_change(s: str) -> bool:
    """Heurística: en medio del login, un texto sin dígitos que parece pregunta →
    el usuario cambió de tema, abandonamos el FSM (no lo dejamos trabado)."""
    s = (s or "").strip()
    if any(ch.isdigit() for ch in s):
        return False
    return s.endswith("?") or len(s.split()) >= 4


# ── Estado del flujo en Redis ──────────────────────────────────────────────────
def _flow_key(tenant_id: str, conv_id: str) -> str:
    return f"flow:{tenant_id}:{conv_id}"

async def _get_flow(tenant_id: str, conv_id: str) -> dict | None:
    try:
        raw = await get_redis_session().get(_flow_key(tenant_id, conv_id))
        return json.loads(raw) if raw else None
    except Exception:
        return None

async def _set_flow(tenant_id: str, conv_id: str, flow: dict) -> None:
    try:
        await get_redis_session().setex(_flow_key(tenant_id, conv_id), _FLOW_TTL_S, json.dumps(flow))
    except Exception as exc:
        logger.warning("flow_set_failed tenant=%s error=%s", tenant_id, exc)

async def _clear_flow(tenant_id: str, conv_id: str) -> None:
    try:
        await get_redis_session().delete(_flow_key(tenant_id, conv_id))
    except Exception:
        pass


# ── Throttle del segundo factor ────────────────────────────────────────────────
async def _register_attempt(tenant_id: str, conv_id: str) -> int:
    """Incrementa y devuelve el nº de intentos en la ventana. Fail-open a 1."""
    try:
        redis = get_redis_ratelimit()
        key = f"authlock:{tenant_id}:{conv_id}"
        n = await redis.incr(key)
        if n == 1:
            await redis.expire(key, settings.connector_auth_lockout_window_s)
        return int(n)
    except Exception:
        return 1

async def _is_locked(tenant_id: str, conv_id: str) -> bool:
    try:
        n = await get_redis_ratelimit().get(f"authlock:{tenant_id}:{conv_id}")
        return n is not None and int(n) >= settings.connector_auth_max_attempts
    except Exception:
        return False


# ── Formateo de la respuesta de la tool (determinista, sin LLM en F1) ──────────
def _fmt_horarios(horarios: list) -> str:
    return "; ".join(f"{h.get('dia')} {h.get('desde')}-{h.get('hasta')}" for h in horarios) or "sin horarios cargados"


def _format_tool_answer(tool_slug: str, result, nombre: str | None) -> str:
    saludo = f"{nombre}, " if nombre else ""
    if result.outcome == EMPTY:
        if tool_slug == "profesionales_por_especialidad":
            return "No encontré profesionales para esa especialidad."
        return f"{saludo}no encontré resultados. ✅"
    if result.outcome == FORBIDDEN:
        return ("No puedo mostrar esa información con los datos de tu sesión. "
                "Si creés que es un error, comunicate con la Mutual.")
    if result.outcome in (UPSTREAM_ERROR, AUTH_REQUIRED):
        return _msg_upstream()

    data = result.data
    # ── Tools personales ──────────────────────────────────────────────────────
    if tool_slug == "ordenes_pendientes" and isinstance(data, list):
        lineas = [f"• {o.get('tipo','(sin detalle)')} — {o.get('prestador','')} (vence {o.get('vence','?')})"
                  for o in data]
        return f"{saludo}tenés {len(data)} orden(es) pendiente(s):\n" + "\n".join(lineas)

    if tool_slug == "cuenta_afiliado" and isinstance(data, dict):
        if data.get("al_dia"):
            return f"{saludo}tu cuenta está al día. ✅ {data.get('detalle','')}".strip()
        return f"{saludo}tenés un saldo pendiente de ${data.get('saldo','?')}. {data.get('detalle','')}".strip()

    # ── Tools públicas ────────────────────────────────────────────────────────
    if tool_slug == "profesionales_por_especialidad" and isinstance(data, list):
        lineas = [f"• {p.get('nombre')} ({p.get('consultorio')}) — {_fmt_horarios(p.get('horarios', []))}"
                  for p in data]
        return f"Profesionales disponibles:\n" + "\n".join(lineas)

    if tool_slug == "horarios_profesional" and isinstance(data, dict):
        if not data.get("encontrado", True):
            return "No encontré un profesional con esa matrícula."
        return (f"{data.get('nombre')} — {data.get('especialidad')} ({data.get('consultorio')}).\n"
                f"Horarios: {_fmt_horarios(data.get('horarios', []))}")

    return f"{saludo}esto es lo que encontré: {json.dumps(data, ensure_ascii=False)}"


def _resp(answer: str, *, handled: bool = True, outcome: str | None = None) -> dict:
    """Forma de respuesta compatible con lo que espera la capa de conversación."""
    return {
        "answer": answer,
        "sources": [],
        "intent_label": "consulta_datos_personales",
        "intent_confidence": None,
        "from_cache": False,
        "low_confidence": False,
        "connector_handled": True,
        "connector_outcome": outcome,
    }


def extract_params(message: str, params_schema: dict) -> dict:
    """Extracción determinista de params desde el mensaje (sin LLM, que está caído).

    Genérica según params_schema:
      - propiedad con "enum"    → si algún valor del enum aparece en el mensaje, lo usa.
      - propiedad con "pattern" → regex-search en el mensaje.
    Lo que no se puede extraer así, no se pasa (el executor validará required).
    """
    out: dict = {}
    props = (params_schema or {}).get("properties", {})
    low = (message or "").lower()
    for key, spec in props.items():
        if "enum" in spec:
            for val in spec["enum"]:
                if str(val).lower() in low:
                    out[key] = val
                    break
        elif "pattern" in spec:
            m = re.search(spec["pattern"], message or "", re.I)
            if m:
                out[key] = m.group(0)
    return out


async def _run_tool_and_format(binding, *, identity: str | None,
                               nombre: str | None, params: dict | None = None) -> dict:
    """Ejecuta la tool y arma la respuesta natural. identity=None en tools públicas."""
    from services.connector_audit import record_tool_call  # import tardío (evita ciclo)
    result = await execute_tool(binding, identity=identity or "", params=params or {})
    await record_tool_call(binding, actor_ref=(identity or "publico"), result=result)
    answer = _format_tool_answer(binding.tool_slug, result, nombre)
    return _resp(answer, outcome=result.outcome)


# ── Entrada principal ──────────────────────────────────────────────────────────
async def maybe_handle(
    tenant_id: str,
    conversation_id: str,
    message: str,
) -> dict | None:
    """Decide si este turno es de datos personales y lo maneja. None → seguir RAG.

    Clasifica la intención internamente, pero SOLO cuando no hay un FSM de login en
    curso (mientras el usuario tipea su DNI/código no tiene sentido clasificar).
    """
    if not settings.connectors_enabled:
        return None

    conv_id = str(conversation_id)
    text = (message or "").strip()
    flow = await _get_flow(tenant_id, conv_id)

    # Logout explícito en cualquier momento.
    if _LOGOUT_RE.search(text):
        await session_store.delete_session(tenant_id, conv_id)
        await _clear_flow(tenant_id, conv_id)
        return _resp(_msg_sesion_cerrada())

    # ── ¿Estamos en medio del FSM? (no clasificar) ────────────────────────────
    if flow and flow.get("stage") in (_PIDIENDO_ID, _PIDIENDO_CODIGO):
        # Escape: cancelar o cambiar de tema abandona el login (no quedar trabado).
        if _CANCEL_RE.search(text) or looks_like_topic_change(text):
            await _clear_flow(tenant_id, conv_id)
            return None  # que responda el RAG lo que sea que preguntó

        if flow["stage"] == _PIDIENDO_ID:
            return await _handle_id_input(tenant_id, conv_id, text, flow)
        if flow["stage"] == _PIDIENDO_CODIGO:
            return await _handle_code_input(tenant_id, conv_id, text, flow)

    # ── No hay FSM activo: clasificar y ver si la intención dispara una tool ───
    from services.classifier import classify_intent
    intent = await classify_intent(text, tenant_id)
    binding = await get_tool_for_intent(tenant_id, intent.label or "")
    if binding is None:
        return None  # no es datos personales → RAG
    if intent.confidence is not None and intent.confidence < binding.min_confidence:
        return None  # confianza insuficiente para ir a la tool → RAG (fail-safe)

    # ── Tool PÚBLICA (sin login): ejecutar directo con params del mensaje ──────
    if binding.identity_kind == "publico":
        params = extract_params(text, binding.params_schema)
        required = (binding.params_schema or {}).get("required", [])
        if any(r not in params for r in required):
            return None  # falta un dato clave → que el RAG responda genérico
        return await _run_tool_and_format(binding, identity=None, nombre=None, params=params)

    # ── Tool PERSONAL: ¿ya hay sesión válida? → ejecutar sin re-pedir auth ─────
    session = await session_store.get_session(tenant_id, conv_id)
    if session and session.get("rol") in binding.roles:
        return await _run_tool_and_format(
            binding, identity=session["identity"], nombre=session.get("nombre"))

    # Sin sesión → arrancar FSM para el identity_kind de la tool.
    new_flow = {
        "stage": _PIDIENDO_ID,
        "identity_kind": binding.identity_kind,
        "pending_intent": binding.intent_label,
    }
    await _set_flow(tenant_id, conv_id, new_flow)
    msg = _msg_pide_cuit() if binding.identity_kind == "profesional" else _msg_pide_dni()
    return _resp(msg)


async def _handle_id_input(tenant_id: str, conv_id: str, text: str, flow: dict) -> dict:
    kind = flow.get("identity_kind", "afiliado")
    is_prof = kind == "profesional"
    ok = valid_cuit(text) if is_prof else valid_dni(text)
    if not ok:
        return _resp(_msg_cuit_invalido() if is_prof else _msg_dni_invalido())
    flow["identity"] = _only_digits(text)
    flow["stage"] = _PIDIENDO_CODIGO
    await _set_flow(tenant_id, conv_id, flow)
    return _resp(_msg_pide_codigo_otp() if is_prof else _msg_pide_codigo_totp())


async def _handle_code_input(tenant_id: str, conv_id: str, text: str, flow: dict) -> dict:
    if _RESEND_RE.search(text):
        return _resp(_msg_reenviado())

    if await _is_locked(tenant_id, conv_id):
        return _resp(_msg_bloqueado())

    identity = flow.get("identity", "")
    code = _only_digits(text)

    # Validación del 2º factor. Resolvemos el binding (necesitamos el conector para
    # validar por HTTP real, o el stub si el conector es stub).
    pending = flow.get("pending_intent")
    binding = await get_tool_for_intent(tenant_id, pending or "")
    if binding is None:
        await _clear_flow(tenant_id, conv_id)
        return _resp(_msg_upstream())
    verdict = await validate_second_factor(binding, identity, code)

    if verdict.get("ok"):
        rol = flow.get("identity_kind", "afiliado")
        await session_store.create_session(
            tenant_id, conv_id,
            identity=identity, rol=rol, nombre=verdict.get("nombre"),
        )
        await _clear_flow(tenant_id, conv_id)
        session = await session_store.get_session(tenant_id, conv_id)
        prefijo = f"✅ Listo, {verdict.get('nombre')}. Ya estás identificado por unos minutos.\n\n"
        if session:
            resp = await _run_tool_and_format(
                binding, identity=session["identity"], nombre=session.get("nombre"))
            resp["answer"] = prefijo + resp["answer"]
            return resp
        return _resp(prefijo + "¿En qué te ayudo?")

    reason = verdict.get("reason")
    if reason == "upstream":
        # No pudimos validar (conector caído) → fail-closed, no consumir intento.
        return _resp(_msg_upstream())
    if reason == "not_found":
        # DNI/afiliado inexistente: mensaje neutro, igual consume un intento.
        n = await _register_attempt(tenant_id, conv_id)
        if n >= settings.connector_auth_max_attempts:
            return _resp(_msg_bloqueado())
        return _resp(_msg_no_existe())

    # Código incorrecto.
    n = await _register_attempt(tenant_id, conv_id)
    if n >= settings.connector_auth_max_attempts:
        return _resp(_msg_bloqueado())
    restantes = settings.connector_auth_max_attempts - n
    return _resp(_msg_codigo_incorrecto(restantes))
