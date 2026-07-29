"""OAuth2 client_credentials con refresh automático (connector_oauth).

Cubre el diseño de docs/DISENO_OAUTH2_CONECTORES.md: emisión + cache (un solo
POST para N usos), single-flight concurrente, TTL desde expires_in con margen,
invalidate, errores OAuth con mensaje del proveedor, egress del token endpoint,
y que el token nunca quede en claro en el cache.
"""

import asyncio
import json

import httpx
import pytest

from services import connector_oauth
from services.connector_oauth import OAuthTokenError, get_access_token, invalidate
from services.connector_secrets import resolve_auth


class FakeRedis:
    def __init__(self):
        self.store: dict = {}

    async def get(self, k):
        return self.store.get(k)

    async def setex(self, k, ttl, v):
        self.store[k] = v
        self.last_ttl = ttl

    async def delete(self, k):
        self.store.pop(k, None)


CTX = {"connector_id": "conn-1", "slug": "prov", "egress_allow": ["auth.prov.com"],
       "timeout_ms": 4000}
CFG = {"token_url": "http://auth.prov.com/oauth/token", "client_id": "cid"}


class OauthEnv:
    """Redis en memoria + token endpoint falso con responder intercambiable."""
    def __init__(self):
        self.redis = FakeRedis()
        self.calls: list[dict] = []
        self.responder = self._default_responder

    def _default_responder(self, request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": f"tok-{len(self.calls)}",
                                         "expires_in": 3600})

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.calls.append({"url": str(request.url), "body": request.content.decode()})
        return self.responder(request)


@pytest.fixture
def oauth_env(monkeypatch):
    env = OauthEnv()
    monkeypatch.setattr(connector_oauth, "get_redis_cache", lambda: env.redis)
    transport = httpx.MockTransport(env._handle)
    real_client = httpx.AsyncClient
    monkeypatch.setattr(connector_oauth.httpx, "AsyncClient",
                        lambda **kw: real_client(transport=transport, **kw))
    # egress: resolver DNS no aplica en tests → validador que solo mira la allowlist
    monkeypatch.setattr(connector_oauth, "assert_egress_allowed",
                        lambda url, allow, **kw: None if httpx.URL(url).host in allow
                        else (_ for _ in ()).throw(ValueError(f"egress bloqueado: {url}")))
    connector_oauth._locks.clear()
    return env


@pytest.mark.asyncio
async def test_emision_y_cache_un_solo_post(oauth_env):
    redis, calls = oauth_env.redis, oauth_env.calls
    t1 = await get_access_token(CTX, CFG, "secreto")
    t2 = await get_access_token(CTX, CFG, "secreto")
    assert t1 == t2 == "tok-1"
    assert len(calls) == 1                    # el segundo uso salió del cache
    assert redis.last_ttl == 3600 - 60        # margen aplicado
    # el token NUNCA en claro en el cache (va cifrado con Fernet)
    assert "tok-1" not in json.dumps({k: str(v) for k, v in redis.store.items()})


@pytest.mark.asyncio
async def test_single_flight_concurrente(oauth_env):
    calls = oauth_env.calls
    tokens = await asyncio.gather(*[get_access_token(CTX, CFG, "s") for _ in range(8)])
    assert set(tokens) == {"tok-1"}
    assert len(calls) == 1                    # 8 concurrentes → un solo POST


@pytest.mark.asyncio
async def test_invalidate_fuerza_reemision(oauth_env):
    calls = oauth_env.calls
    assert await get_access_token(CTX, CFG, "s") == "tok-1"
    await invalidate(CTX["connector_id"])
    assert await get_access_token(CTX, CFG, "s") == "tok-2"
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_credenciales_en_body_por_default(oauth_env):
    calls = oauth_env.calls
    await get_access_token(CTX, CFG, "s3cr3t")
    body = calls[0]["body"]
    assert "grant_type=client_credentials" in body
    assert "client_id=cid" in body and "client_secret=s3cr3t" in body


@pytest.mark.asyncio
async def test_error_oauth_con_mensaje_del_proveedor(oauth_env):
    oauth_env.responder = lambda r: httpx.Response(
        401, json={"error": "invalid_client",
                   "error_description": "Client authentication failed"})
    with pytest.raises(OAuthTokenError) as exc:
        await get_access_token(CTX, CFG, "s")
    assert "invalid_client" in str(exc.value) and "Client authentication failed" in str(exc.value)


@pytest.mark.asyncio
async def test_config_incompleta_fail_closed(oauth_env):
    with pytest.raises(OAuthTokenError):
        await get_access_token(CTX, {"token_url": "http://auth.prov.com/t"}, None)  # sin client_id/secret


@pytest.mark.asyncio
async def test_token_url_fuera_de_egress_bloqueado(oauth_env):
    cfg = {**CFG, "token_url": "http://interno.local/token"}
    with pytest.raises(ValueError):
        await get_access_token(CTX, cfg, "s")


@pytest.mark.asyncio
async def test_sin_expires_in_ttl_conservador(oauth_env):
    oauth_env.responder = lambda r: httpx.Response(200, json={"access_token": "tok-x"})
    await get_access_token(CTX, CFG, "s")
    assert oauth_env.redis.last_ttl == 300


@pytest.mark.asyncio
async def test_resolve_auth_entrega_bearer(oauth_env):
    out = await resolve_auth("oauth2", CFG, "s", oauth_ctx=CTX)
    assert out["headers"] == {"Authorization": "Bearer tok-1"}
    assert out["params"] == {} and out["auth"] is None


@pytest.mark.asyncio
async def test_resolve_auth_estaticos_intactos(oauth_env):
    out = await resolve_auth("api_key", {"in": "query"}, "k", oauth_ctx=CTX)
    assert out["params"] == {"api_key": "k"}   # delega en build_auth, sin red
