"""Session store cifrado para conectores autenticados.

Guarda en Redis (DB 3) un blob **cifrado con Fernet** por conversación, con la
identidad ya verificada por el segundo factor. El "doble token": nuestra sesión
(cifrada, efímera) envuelve el JWT de NEXA — el usuario nunca ve el JWT de NEXA,
nosotros lo usamos server-side para invocar tools.

Clave de sesión = conversation_id (Fase 1: una sesión por conversación). El
executor resuelve `{identity}` leyendo de acá, NUNCA del texto del usuario ni de
parámetros del LLM (defensa BOLA/IDOR).

Fail-closed: si Redis falla o el blob no descifra, get_session devuelve None →
el usuario re-autentica. Nunca se "asume" identidad ante un error.
"""

from __future__ import annotations

import json
import logging
import time

from core.config import settings
from core.crypto import decrypt_secret, encrypt_secret
from core.database import get_redis_session

logger = logging.getLogger(__name__)


def _key(tenant_id: str, conversation_id: str) -> str:
    return f"session:{tenant_id}:{conversation_id}"


async def create_session(
    tenant_id: str,
    conversation_id: str,
    *,
    identity: str,
    rol: str,
    nombre: str | None = None,
    jwt_externo: str | None = None,
    ttl_seconds: int | None = None,
) -> bool:
    """Crea/reemplaza la sesión autenticada. Devuelve True si persistió."""
    ttl = ttl_seconds or settings.session_ttl_seconds
    blob = {
        "identity": identity,
        "rol": rol,
        "nombre": nombre,
        "jwt_externo": jwt_externo,
        "created_at": int(time.time()),
    }
    try:
        token = encrypt_secret(json.dumps(blob))
        await get_redis_session().setex(_key(tenant_id, conversation_id), ttl, token)
        return True
    except Exception as exc:
        # No persistió → el próximo pedido personal re-autentica (fail-closed).
        logger.warning("session_create_failed tenant=%s error=%s", tenant_id, exc)
        return False


async def get_session(tenant_id: str, conversation_id: str) -> dict | None:
    """Devuelve el blob descifrado de la sesión, o None si no hay/expiró/corrupto.

    Renueva el TTL con la actividad (sliding window) para no cortar a un usuario
    activo a mitad de conversación.
    """
    try:
        redis = get_redis_session()
        token = await redis.get(_key(tenant_id, conversation_id))
        if not token:
            return None
        blob = json.loads(decrypt_secret(token))
        # Sliding TTL: cada acceso renueva la ventana.
        await redis.expire(_key(tenant_id, conversation_id), settings.session_ttl_seconds)
        return blob
    except Exception as exc:
        # Blob ilegible o Redis caído → tratamos como no autenticado (fail-closed).
        logger.warning("session_get_failed tenant=%s error=%s", tenant_id, exc)
        return None


async def delete_session(tenant_id: str, conversation_id: str) -> None:
    """Cierra sesión (logout / expiración forzada)."""
    try:
        await get_redis_session().delete(_key(tenant_id, conversation_id))
    except Exception as exc:
        logger.debug("session_delete_failed tenant=%s error=%s", tenant_id, exc)
