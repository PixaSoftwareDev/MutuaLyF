"""Soporte genérico de proveedores heterogéneos — sin hardcodear ninguno.

Tres mecanismos config-driven que cubren "cualquier API" en vez de arreglar de a
una: (1) API key por header O por query param (TMDB api_key=, OpenWeather appid=,
NewsAPI X-Api-Key — todos con la misma config), (2) extracción del mensaje de
error del proveedor sin asumir el formato del cuerpo, (3) encadenado lista→detalle
cuando la lista no es exactamente el path padre (/movie/{id} sin /movie pero con
/movie/popular).
"""

import pytest

from api.v1.connectors import _autofill_resource_ids, _upstream_message
from services.connector_executor import join_url
from services.connector_secrets import build_auth


# ── 1. API key: header o query param, por configuración ────────────────────────

def test_api_key_header_default():
    out = build_auth("api_key", {}, "s3cret")
    assert out["headers"] == {"X-API-Key": "s3cret"}
    assert out["params"] == {}


def test_api_key_query_param_configurable():
    out = build_auth("api_key", {"in": "query", "param": "api_key"}, "s3cret")
    assert out["headers"] == {}
    assert out["params"] == {"api_key": "s3cret"}


def test_api_key_query_param_default_name():
    out = build_auth("api_key", {"in": "query"}, "s3cret")
    assert out["params"] == {"api_key": "s3cret"}


def test_todos_los_auth_types_devuelven_params():
    # Los call-sites mergean auth_kwargs["params"] sin chequear: la clave tiene
    # que existir en todas las variantes.
    for auth_type, cfg, secret in [
        ("none", {}, None),
        ("api_key", {}, "x"),
        ("bearer", {}, "x"),
        ("basic", {"username": "u"}, "x"),
    ]:
        assert "params" in build_auth(auth_type, cfg, secret)


# ── 2. Mensaje de error del proveedor, sin asumir formato ──────────────────────

@pytest.mark.parametrize("raw, esperado", [
    ({"status_code": 7, "status_message": "Invalid API key"}, "Invalid API key"),   # TMDB
    ({"message": "q is required"}, "q is required"),                                # NewsAPI
    ({"error": "Falta el token (Authorization: Bearer)"}, "Falta el token (Authorization: Bearer)"),
    ({"error": {"message": "anidado"}}, "anidado"),
    ({"errors": [{"message": "el primero de la lista"}]}, "el primero de la lista"),
    ({"detail": "detalle FastAPI"}, "detalle FastAPI"),
    ("texto plano del proveedor", "texto plano del proveedor"),
    ({"data": [1, 2, 3]}, None),          # sin clave de mensaje → nada inventado
    ({"error": True, "code": 500}, None),  # mensaje no-string → nada inventado
    (None, None),
])
def test_upstream_message_formatos(raw, esperado):
    assert _upstream_message(raw) == esperado


# ── 3. URL: prefijo de versión duplicado entre base y ruta ─────────────────────

@pytest.mark.parametrize("base, path, esperado", [
    # la doc del proveedor trae las rutas CON el prefijo que ya está en la base
    ("https://api.themoviedb.org/3", "/3/movie/popular", "https://api.themoviedb.org/3/movie/popular"),
    ("https://newsapi.org/v2", "/v2/everything", "https://newsapi.org/v2/everything"),
    # sin duplicado → intacto
    ("https://newsapi.org/v2", "/top-headlines", "https://newsapi.org/v2/top-headlines"),
    ("https://api.openweathermap.org/data/2.5", "/weather", "https://api.openweathermap.org/data/2.5/weather"),
    # base sin path: el host NUNCA se dedupe contra la ruta
    ("http://149.50.152.218", "/crmpixs/api/contacts", "http://149.50.152.218/crmpixs/api/contacts"),
    # coincidencia parcial de segmento no cuenta (/3 vs /30)
    ("https://x.com/3", "/30/items", "https://x.com/3/30/items"),
    # prefijo de VARIOS segmentos (CRM Pixs: base /crmpixs/api + rutas con el
    # mismo prefijo). Sin esto la URL sale duplicada y el proveedor da 404.
    ("http://149.50.152.218/crmpixs/api", "/crmpixs/api/contacts/{id}",
     "http://149.50.152.218/crmpixs/api/contacts/{id}"),
    ("http://149.50.152.218/crmpixs/api", "/contacts", "http://149.50.152.218/crmpixs/api/contacts"),
    # solapamiento parcial: solo /api coincide, /crmpixs no se pierde
    ("http://h/api", "/api/crmpixs/x", "http://h/api/crmpixs/x"),
    # ruta ABSOLUTA: proveedor repartido en subdominios (Open-Meteo) — se usa
    # tal cual; el egress_guard sigue exigiendo que el host esté aprobado.
    ("https://api.open-meteo.com", "https://geocoding-api.open-meteo.com/v1/search",
     "https://geocoding-api.open-meteo.com/v1/search"),
])
def test_join_url(base, path, esperado):
    assert join_url(base, path) == esperado


# ── 4. Lista hermana por prefijo cuando el path padre no existe ────────────────

def _tool(id_, path, schema=None, method="GET"):
    return {"id": id_, "slug": id_, "display_name": id_, "http_method": method,
            "path_template": path, "params_schema": schema or {}, "response_map": {}}


@pytest.mark.asyncio
async def test_autofill_usa_lista_bajo_el_mismo_prefijo(monkeypatch):
    detalle = _tool("ficha", "/3/movie/{movie_id}", {
        "type": "object", "required": ["movie_id"],
        "properties": {"movie_id": {"type": "string", "x-resource-id": True}},
    })
    populares = _tool("populares", "/3/movie/popular")
    otra = _tool("generos", "/3/genre/movie/list")

    async def fake_dry_run(conn, tool, tenant_id, connector_id, identity, params):
        assert tool["slug"] == "populares"  # eligió la variante bajo /3/movie
        return {"ok": True, "raw": [{"id": 550, "title": "Fight Club"}]}

    monkeypatch.setattr("api.v1.connectors._dry_run_tool", fake_dry_run)
    filled, autos, err = await _autofill_resource_ids(
        {}, detalle, [detalle, populares, otra], "t", "c", "", {})
    assert err is None
    assert filled["movie_id"] == "550"  # summarize_result normaliza ids a string
    assert autos[0]["from"] == "populares"


@pytest.mark.asyncio
async def test_autofill_sin_ninguna_lista_da_error_descriptivo():
    detalle = _tool("ficha", "/3/movie/{movie_id}", {
        "type": "object", "required": ["movie_id"],
        "properties": {"movie_id": {"type": "string", "x-resource-id": True}},
    })
    filled, autos, err = await _autofill_resource_ids({}, detalle, [detalle], "t", "c", "", {})
    assert filled is None
    assert "movie_id" in err and "/3/movie" in err
