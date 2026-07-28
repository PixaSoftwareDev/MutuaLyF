"""OAuth2 client_credentials con refresh automático — diseño en
docs/DISENO_OAUTH2_CONECTORES.md.

Lo que se guarda es la credencial de EMISIÓN (client_id en auth_config,
client_secret cifrado en auth_secret_enc). El access_token es derivado y
efímero: vive solo en Redis cache (DB 1), cifrado con Fernet, con TTL
expires_in − margen. Nunca toca Postgres, logs ni mensajes de error.

Single-flight por proceso: N requests concurrentes → un solo POST al token
endpoint. Carrera entre workers distintos: inocua (ambos tokens válidos, el
último pisa el cache).
"""

from __future__ import annotations

import asyncio
import logging
import time

import httpx

from core.config import settings
from core.crypto import decrypt_secret, encrypt_secret
from core.database import get_redis_cache
from core.egress_guard import assert_egress_allowed

logger = logging.getLogger(__name__)

# Sin expires_in en la respuesta → TTL conservador. Margen para nunca viajar con
# un token al borde del vencimiento.
_DEFAULT_TTL_S = 300
_TTL_MARGIN_S = 60
_TTL_FLOOR_S = 30

_locks: dict[str, asyncio.Lock] = {}


class OAuthTokenError(ValueError):
    """No se pudo obtener un access_token (config incompleta, credencial
    rechazada o token endpoint inaccesible). El mensaje es apto para el admin.
    Subclase de ValueError a propósito: todos los call-sites ya tratan el
    ValueError de build_auth como 'credencial mal configurada' (fail-closed)."""


def _cache_key(connector_id: str) -> str:
    # Clave por connector_id (UUID, único global) y no por tenant: discovery
    # no siempre conoce el tenant y un UUID no puede colisionar entre tenants.
    return f"connector_oauth:{connector_id}"


def _lock_for(key: str) -> asyncio.Lock:
    lock = _locks.get(key)
    if lock is None:
        lock = _locks[key] = asyncio.Lock()
    return lock


async def invalidate(connector_id: str) -> None:
    """Borra el token cacheado (401 del proveedor, o cambio de credencial)."""
    try:
        await get_redis_cache().delete(_cache_key(connector_id))
    except Exception as exc:  # noqa: BLE001 — sin cache igual se re-emite
        logger.warning("oauth_cache_invalidate_failed connector=%s error=%s",
                       connector_id, exc)


async def get_access_token(ctx: dict, auth_config: dict, client_secret: str | None) -> str:
    """Token vigente para el conector: cache-first, emisión con single-flight.

    ctx: {connector_id, slug, egress_allow, timeout_ms} — lo arma resolve_auth
    desde el binding (executor) o el dict del conector (discovery/panel).
    """
    cfg = auth_config or {}
    token_url = (cfg.get("token_url") or "").strip()
    client_id = (cfg.get("client_id") or "").strip()
    if not token_url or not client_id or not client_secret:
        raise OAuthTokenError(
            "oauth2 requiere URL del token y Client ID (configuración) y "
            "Client Secret (credencial). Completalos en la pantalla del conector.")

    key = _cache_key(ctx["connector_id"])
    redis = get_redis_cache()

    async def _cached() -> str | None:
        try:
            enc = await redis.get(key)
        except Exception as exc:  # noqa: BLE001 — cache caído → emitir directo
            logger.warning("oauth_cache_read_failed connector=%s error=%s",
                           ctx.get("slug"), exc)
            return None
        if not enc:
            return None
        return decrypt_secret(enc.decode() if isinstance(enc, bytes) else enc)

    if (token := await _cached()) is not None:
        return token

    async with _lock_for(key):
        # Double-check: otro request del mismo proceso pudo emitir mientras
        # esperábamos el lock.
        if (token := await _cached()) is not None:
            return token
        token, ttl = await _fetch_token(ctx, cfg, token_url, client_id, client_secret)
        try:
            await redis.setex(key, ttl, encrypt_secret(token))
        except Exception as exc:  # noqa: BLE001 — sin cache funciona (más lento)
            logger.warning("oauth_cache_write_failed connector=%s error=%s",
                           ctx.get("slug"), exc)
        return token


async def _fetch_token(ctx: dict, cfg: dict, token_url: str,
                       client_id: str, client_secret: str) -> tuple[str, int]:
    # El token endpoint suele vivir en OTRO host que la API (auth.x.com vs
    # api.x.com): pasa por el mismo egress guard que cualquier upstream.
    assert_egress_allowed(
        token_url, ctx.get("egress_allow") or [],
        allow_http=settings.environment == "development",
        trusted_internal_hosts=settings.trusted_internal_hosts_set,
    )

    data: dict = {"grant_type": "client_credentials"}
    if cfg.get("scopes"):
        data["scope"] = cfg["scopes"]
    if cfg.get("audience"):
        data["audience"] = cfg["audience"]
    auth = None
    if (cfg.get("token_auth_style") or "body") == "basic_header":
        auth = httpx.BasicAuth(client_id, client_secret)
    else:
        data["client_id"] = client_id
        data["client_secret"] = client_secret

    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=(ctx.get("timeout_ms") or 4000) / 1000) as client:
            resp = await client.post(token_url, data=data, auth=auth)
    except httpx.HTTPError as exc:
        logger.warning("oauth_token_failed connector=%s error=%s", ctx.get("slug"), exc)
        raise OAuthTokenError(f"token endpoint inaccesible: {str(exc)[:150]}") from exc
    latency_ms = int((time.monotonic() - start) * 1000)

    try:
        body = resp.json()
    except ValueError:
        body = {}
    if resp.status_code >= 400:
        # Formato de error estándar de OAuth2: {"error", "error_description"}.
        err = str(body.get("error") or f"HTTP {resp.status_code}")
        desc = str(body.get("error_description") or "").strip()
        logger.warning("oauth_token_failed connector=%s status=%s error=%s",
                       ctx.get("slug"), resp.status_code, err)
        raise OAuthTokenError(f"{err}{' — ' + desc if desc else ''}"[:300])

    token = body.get("access_token")
    if not token or not isinstance(token, str):
        raise OAuthTokenError("el token endpoint respondió sin access_token")
    if body.get("refresh_token"):
        # Fase 2 (delegado por usuario). En client_credentials se re-emite con
        # las mismas credenciales; se loguea para dimensionar la demanda real.
        logger.debug("oauth_refresh_token_ignorado connector=%s", ctx.get("slug"))

    expires_in = body.get("expires_in")
    ttl = (max(int(expires_in) - _TTL_MARGIN_S, _TTL_FLOOR_S)
           if isinstance(expires_in, (int, float)) and not isinstance(expires_in, bool)
           else _DEFAULT_TTL_S)
    logger.info("oauth_token_refreshed connector=%s latency_ms=%s ttl_s=%s",
                ctx.get("slug"), latency_ms, ttl)
    return token, ttl
