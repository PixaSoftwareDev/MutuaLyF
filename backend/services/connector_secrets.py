"""Secretos de auth de conectores + construcción de la autenticación HTTP.

Decisión D1 (docs/PANTALLA_CONECTORES_PLAN.md): el secreto se guarda cifrado con
Fernet en la columna tenant_connectors.auth_secret_enc, reusando core.crypto (el
mismo mecanismo de las sesiones de conectores). La clave Fernet vive fuera de la DB.

Todo pasa por acá para que migrar a un secrets-manager externo sea cambiar esta
implementación, no el schema ni la pantalla.
"""

from __future__ import annotations

import logging

import httpx

from core.crypto import decrypt_secret, encrypt_secret

logger = logging.getLogger(__name__)

# auth_type soportados en Fase 1. oauth2_client_credentials → Fase 2.
SUPPORTED_AUTH_TYPES = {"none", "stub", "api_key", "bearer", "basic"}


def seal_secret(plaintext: str) -> str:
    """Cifra un secreto para guardarlo en auth_secret_enc. Nunca se guarda en claro."""
    return encrypt_secret(plaintext)


def open_secret(ciphertext: str | None) -> str | None:
    """Descifra auth_secret_enc. None si no hay secreto o si falla (fail-closed silencioso)."""
    if not ciphertext:
        return None
    try:
        return decrypt_secret(ciphertext)
    except Exception as exc:  # clave rotada, dato corrupto → tratamos como sin secreto
        logger.warning("connector_secret_decrypt_failed error=%s", exc)
        return None


def build_auth(auth_type: str, auth_config: dict | None, secret: str | None) -> dict:
    """Traduce (auth_type, auth_config, secreto) a kwargs para httpx.

    Devuelve {'headers': {...}, 'auth': httpx.Auth | None} para mergear en la request.
    Fail-closed: un auth_type que requiere secreto y no lo tiene → levanta ValueError
    (mejor no llamar al tercero que llamarlo sin credencial y filtrar el error después).
    """
    cfg = auth_config or {}
    at = (auth_type or "none").lower()

    if at in ("none", "stub"):
        return {"headers": {}, "auth": None}

    if at == "api_key":
        if not secret:
            raise ValueError("api_key sin secreto configurado")
        header = cfg.get("header") or "X-API-Key"
        prefix = cfg.get("prefix", "")  # ej. "Token " si el proveedor lo pide
        return {"headers": {header: f"{prefix}{secret}"}, "auth": None}

    if at == "bearer":
        if not secret:
            raise ValueError("bearer sin token configurado")
        return {"headers": {"Authorization": f"Bearer {secret}"}, "auth": None}

    if at == "basic":
        # El usuario va en auth_config (no es secreto); la contraseña es el secreto.
        user = cfg.get("username")
        if not user or not secret:
            raise ValueError("basic requiere username (auth_config) y password (secreto)")
        return {"headers": {}, "auth": httpx.BasicAuth(user, secret)}

    raise ValueError(f"auth_type no soportado en Fase 1: {auth_type}")
