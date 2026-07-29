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
SUPPORTED_AUTH_TYPES = {"none", "stub", "api_key", "bearer", "basic", "oauth2"}


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

    Devuelve {'headers': {...}, 'auth': httpx.Auth | None, 'params': {...}} para
    mergear en la request. 'params' cubre a los proveedores que piden la clave por
    query string (TMDB api_key=, OpenWeather appid=, etc.) — se configura con
    auth_config: {"in": "query", "param": "api_key"}. La URL que se loguea o se
    muestra al admin nunca debe incluir estos params: pasarlos siempre como
    `params=` de httpx, jamás concatenados a la URL.
    Fail-closed: un auth_type que requiere secreto y no lo tiene → levanta ValueError
    (mejor no llamar al tercero que llamarlo sin credencial y filtrar el error después).
    """
    cfg = auth_config or {}
    at = (auth_type or "none").lower()

    if at in ("none", "stub"):
        return {"headers": {}, "auth": None, "params": {}}

    if at == "api_key":
        if not secret:
            raise ValueError("api_key sin secreto configurado")
        prefix = cfg.get("prefix", "")  # ej. "Token " si el proveedor lo pide
        if (cfg.get("in") or "header") == "query":
            param = cfg.get("param") or "api_key"
            return {"headers": {}, "auth": None, "params": {param: f"{prefix}{secret}"}}
        header = cfg.get("header") or "X-API-Key"
        return {"headers": {header: f"{prefix}{secret}"}, "auth": None, "params": {}}

    if at == "bearer":
        if not secret:
            raise ValueError("bearer sin token configurado")
        return {"headers": {"Authorization": f"Bearer {secret}"}, "auth": None, "params": {}}

    if at == "basic":
        # El usuario va en auth_config (no es secreto); la contraseña es el secreto.
        user = cfg.get("username")
        if not user or not secret:
            raise ValueError("basic requiere username (auth_config) y password (secreto)")
        return {"headers": {}, "auth": httpx.BasicAuth(user, secret), "params": {}}

    if at == "oauth2":
        # oauth2 es async (emisión/refresh de token): usar resolve_auth.
        raise ValueError("oauth2 requiere resolve_auth (async), no build_auth")

    raise ValueError(f"auth_type no soportado en Fase 1: {auth_type}")


async def resolve_auth(auth_type: str, auth_config: dict | None, secret: str | None,
                       oauth_ctx: dict | None = None) -> dict:
    """Punto único de resolución de credenciales, estáticas o dinámicas.

    Para oauth2 obtiene/renueva el access_token (connector_oauth: cache Redis
    cifrado + single-flight) y lo entrega como bearer; `secret` es el
    client_secret ya descifrado. Para el resto delega en build_auth (sync,
    intacto). oauth_ctx: {connector_id, slug, egress_allow, timeout_ms}.
    Las capas de arriba no distinguen un conector oauth2 de uno con bearer fijo.
    """
    if (auth_type or "").lower() == "oauth2":
        from services.connector_oauth import get_access_token
        token = await get_access_token(oauth_ctx or {}, auth_config or {}, secret)
        return {"headers": {"Authorization": f"Bearer {token}"}, "auth": None, "params": {}}
    return build_auth(auth_type, auth_config, secret)
