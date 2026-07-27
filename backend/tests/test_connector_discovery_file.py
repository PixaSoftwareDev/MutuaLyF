"""Tests de la extracción de rutas desde documentación subida (discover-file).

Cubre routes_from_document (LLM mockeado): normalización, filtrado de métodos
de escritura y parseo defensivo del output del modelo.
"""

import json

import pytest

from services.connector_discovery import (
    _parse_llm_json_array, parse_openapi, routes_from_document,
)


def _mock_complete(response_text: str):
    # **kwargs: la firma real de complete() suma params (ej. timeout_s) y el mock
    # no debe romperse con cada uno nuevo.
    async def _complete(messages, complexity=None, temperature=0.0, max_tokens=1024,
                        tenant_id=None, **kwargs):
        return response_text
    return _complete


# ── _parse_llm_json_array ──────────────────────────────────────────────────────

def test_parse_array_con_fence_markdown():
    raw = '```json\n[{"path": "/x", "method": "GET"}]\n```'
    assert _parse_llm_json_array(raw) == [{"path": "/x", "method": "GET"}]


def test_parse_array_sin_array_levanta():
    with pytest.raises(ValueError):
        _parse_llm_json_array("no hay json acá")


# ── routes_from_document ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_extrae_y_normaliza_rutas(monkeypatch):
    llm_out = json.dumps([
        {"path": "/socios/{dni}", "method": "GET", "summary": "Perfil del socio",
         "params": [{"name": "dni", "in": "path", "required": True, "type": "string"}]},
        # POST se descarta (Fase 1 es read-only)
        {"path": "/socios", "method": "POST", "summary": "Alta de socio", "params": []},
        # path que no empieza con / se descarta (alucinación del LLM)
        {"path": "https://api.x.com/otros", "method": "GET", "params": []},
        # param sin nombre se ignora, el resto se normaliza con defaults
        {"path": "/proyectos", "method": "get", "summary": "",
         "params": [{"in": "query"}, {"name": "estado", "enum": ["activo", "entregado"]}]},
    ])
    monkeypatch.setattr("services.groq_client.complete", _mock_complete(llm_out))

    routes = await routes_from_document("doc del proveedor", "tenant_test")

    assert [r["path"] for r in routes] == ["/socios/{dni}", "/proyectos"]
    assert routes[0]["method"] == "GET"
    assert routes[0]["params"] == [
        {"name": "dni", "in": "path", "required": True, "type": "string", "enum": None},
    ]
    # defaults: in=query, required=False, type=string; enum se preserva
    assert routes[1]["params"] == [
        {"name": "estado", "in": "query", "required": False, "type": "string",
         "enum": ["activo", "entregado"]},
    ]


@pytest.mark.asyncio
async def test_doc_sin_rutas_devuelve_vacio(monkeypatch):
    monkeypatch.setattr("services.groq_client.complete", _mock_complete("[]"))
    assert await routes_from_document("un manual sin endpoints", "tenant_test") == []


@pytest.mark.asyncio
async def test_output_invalido_del_llm_levanta(monkeypatch):
    monkeypatch.setattr("services.groq_client.complete", _mock_complete("perdón, no entendí"))
    with pytest.raises(ValueError):
        await routes_from_document("doc", "tenant_test")


# ── JSON subido que ya es OpenAPI → parse directo (sin LLM) ────────────────────

def test_openapi_subido_parsea_directo():
    spec = {
        "openapi": "3.1.0",
        "paths": {
            "/servicios": {"get": {"summary": "Servicios", "parameters": []}},
            "/socios/{dni}": {
                "get": {"summary": "Perfil", "parameters": [
                    {"name": "dni", "in": "path", "required": True, "schema": {"type": "string"}},
                ]},
                "delete": {"summary": "no debería aparecer"},
            },
        },
    }
    routes = parse_openapi(spec)
    assert {r["path"] for r in routes} == {"/servicios", "/socios/{dni}"}
    assert all(r["method"] == "GET" for r in routes)
