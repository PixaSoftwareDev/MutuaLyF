"""OTP propio de la plataforma — segundo factor cuando el proveedor no valida.

Estrategia (docs/PANTALLA_CONECTORES_PLAN.md, análisis de integración): al cliente
solo le pedimos que su base tenga los datos de contacto del afiliado. La plataforma
lee el contacto vía el conector, GENERA el código, lo ENVÍA (email; SMS/WhatsApp a
futuro) y lo VALIDA. El proveedor no necesita construir nada.

Seguridad:
- Código de 6 dígitos con `secrets` (CSPRNG), nunca se guarda en claro: SHA-256
  en Redis (DB de sesiones), TTL 5 min, un solo uso.
- Atado a (tenant, conversación, identity): cambiar el DNI a mitad de flujo
  invalida el código.
- Rate limit de envío: máx 3 códigos por conversación cada 10 min (además del
  throttle de intentos de código que ya aplica el FSM).
- Sin SMTP configurado (dev local): el código se loguea con nivel WARNING para
  poder probarlo; en producción SMTP es obligatorio para este flujo.
"""

from __future__ import annotations

import hashlib
import json
import logging
import secrets

from core.config import settings
from core.database import get_redis_ratelimit, get_redis_session

logger = logging.getLogger(__name__)

OTP_TTL_S = 300          # 5 min de vida del código
OTP_MAX_SENDS = 3        # máx envíos por conversación…
OTP_SEND_WINDOW_S = 600  # …en esta ventana


def _key(tenant_id: str, conv_id: str) -> str:
    return f"otp:{tenant_id}:{conv_id}"


def _hash(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def mask_email(email: str | None) -> str | None:
    """g***@ejemplo.com.ar — suficiente para que el usuario reconozca su cuenta."""
    if not email or "@" not in email:
        return None
    user, dom = email.split("@", 1)
    return f"{user[0]}***@{dom}"


def mask_phone(phone: str | None) -> str | None:
    """***0101 — últimos 4 dígitos."""
    if not phone:
        return None
    digits = "".join(ch for ch in phone if ch.isdigit())
    return f"***{digits[-4:]}" if len(digits) >= 4 else None


async def can_send(tenant_id: str, conv_id: str) -> bool:
    """Rate limit de generación/envío de códigos.

    Fail-CLOSED: si el contador no está disponible no se manda nada. El
    argumento viejo era que el throttle de intentos del FSM seguía protegiendo,
    pero ese throttle vive en el MISMO Redis — con Redis caído no quedaba
    ninguna barrera y la organización quedaba expuesta a bombardeo de emails
    contra la casilla de una persona.
    """
    try:
        redis = get_redis_ratelimit()
        key = f"otpsend:{tenant_id}:{conv_id}"
        n = await redis.incr(key)
        if n == 1:
            await redis.expire(key, OTP_SEND_WINDOW_S)
        return int(n) <= OTP_MAX_SENDS
    except Exception as exc:  # noqa: BLE001
        logger.error("otp_throttle_no_disponible tenant=%s error=%s — no se envía",
                     tenant_id, type(exc).__name__)
        return False


def _dev_fixed_code() -> str | None:
    """Código OTP fijo para pruebas locales (OTP_DEV_FIXED_CODE en .env.local).

    DOBLE gate: además de estar seteado, el environment NO puede ser production —
    aunque la variable se filtre a un deploy, en prod se ignora y el flujo sigue
    siendo CSPRNG + email. Con código fijo activo tampoco se envía email (ver
    send_code): las corridas de QA no queman la cuota de Resend ni spamean.
    """
    code = (settings.otp_dev_fixed_code or "").strip()
    if code and settings.environment.lower() != "production" and len(code) == 6 and code.isdigit():
        return code
    return None


async def generate_and_store(tenant_id: str, conv_id: str, identity: str) -> str | None:
    """Genera un código nuevo (invalida el anterior) y lo persiste hasheado.
    None si no se pudo persistir (fail-closed: sin registro no hay validación)."""
    code = _dev_fixed_code() or f"{secrets.randbelow(1_000_000):06d}"
    blob = json.dumps({"identity": identity, "hash": _hash(code)})
    try:
        await get_redis_session().setex(_key(tenant_id, conv_id), OTP_TTL_S, blob)
        return code
    except Exception as exc:
        logger.warning("otp_store_failed tenant=%s error=%s", tenant_id, exc)
        return None


async def validate(tenant_id: str, conv_id: str, identity: str, code: str) -> bool:
    """Compara hash + identity. Un solo uso: el código se borra al validar OK."""
    try:
        redis = get_redis_session()
        raw = await redis.get(_key(tenant_id, conv_id))
        if not raw:
            return False
        blob = json.loads(raw)
        ok = blob.get("identity") == identity and blob.get("hash") == _hash(code or "")
        if ok:
            await redis.delete(_key(tenant_id, conv_id))
        return ok
    except Exception as exc:
        logger.warning("otp_validate_failed tenant=%s error=%s", tenant_id, exc)
        return False  # fail-closed


async def send_code(code: str, *, email: str | None, tenant_name: str | None = None) -> str:
    """Envía el código. Devuelve el canal usado: 'email' | 'log'.

    Dev local (sin SMTP): loguea el código para poder completar el flujo.
    SMS/WhatsApp: canal futuro — el contrato de esta función no cambia.
    """
    org = tenant_name or "tu organización"
    if _dev_fixed_code():
        # Código fijo de dev activo: no hay nada que enviar (el tester ya lo conoce).
        logger.info("otp_dev_fixed_code activo — email NO enviado (email=%s)", email)
        return "fixed"
    if email and settings.smtp_host:
        from core.email import send_email
        sent = await send_email(
            email,
            f"Tu código de verificación — {org}",
            f"<p>Tu código de verificación es <b style='font-size:1.4em'>{code}</b>.</p>"
            f"<p>Vence en 5 minutos. Si no lo pediste, ignorá este mensaje.</p>",
            f"Tu código de verificación es {code}. Vence en 5 minutos.",
        )
        if sent:
            return "email"
    # Sin SMTP o fallo de envío → dev: visible en logs del backend.
    logger.warning("otp_code_dev email=%s code=%s (SMTP no configurado o falló el envío)", email, code)
    return "log"
