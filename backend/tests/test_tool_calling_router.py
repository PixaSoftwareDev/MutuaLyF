"""Tests del modo connector_routing_mode='tool_calling' (Fase 1).

El LLM elige la tool desde el catálogo; el resto (resolución por slug, ejecución,
FSM) es el mismo. Acá se mockea `select_tool` (sin red) y el DAO/executor (sin PG),
para validar: resolución por slug, filtrado de params alucinados, fail-closed ante
slug inexistente, y passthrough a RAG cuando el LLM no elige tool.
"""

import pytest

from services import connector_router
from services.connectors_dao import ToolBinding


def _binding_publico() -> ToolBinding:
    return ToolBinding(
        tenant_id="t1", intent_label="proyectos", min_confidence=0.0,
        tool_id="00000000-0000-0000-0000-0000000000aa", tool_slug="proyectos",
        http_method="GET", path_template="/proyectos",
        params_schema={"type": "object", "required": ["estado"],
                       "properties": {"estado": {"enum": ["activo", "entregado"], "type": "string"}}},
        response_map={}, identity_kind="publico", is_read_only=True,
        connector_id="c1", connector_slug="crm", base_url="https://crm.example",
        egress_allow=["crm.example"], auth_type="stub", auth_secret_ref="X",
        timeout_ms=4000, roles=set(),
    )


_CATALOG = [{"slug": "proyectos", "display_name": "Proyectos",
             "params_schema": _binding_publico().params_schema,
             "identity_kind": "publico", "is_read_only": True}]


@pytest.fixture
def wired_tc(monkeypatch):
    from core.config import settings
    monkeypatch.setattr(settings, "connectors_enabled", True)
    monkeypatch.setattr(settings, "connector_routing_mode", "tool_calling")

    async def _catalog(tenant_id):
        return _CATALOG
    monkeypatch.setattr(connector_router, "list_tools_for_tool_calling", _catalog)

    async def _by_slug(tenant_id, slug):
        return _binding_publico() if slug == "proyectos" else None
    monkeypatch.setattr(connector_router, "get_tool_by_slug", _by_slug)


@pytest.mark.asyncio
async def test_selecciona_tool_y_filtra_params(wired_tc, monkeypatch):
    # LLM elige 'proyectos' y agrega un param alucinado ('foo') que debe filtrarse.
    async def _select(messages, tools, tenant_id=None):
        return {"name": "proyectos", "arguments": {"estado": "activo", "foo": "bar"}}
    monkeypatch.setattr("services.groq_client.select_tool", _select)

    resolved = await connector_router._resolve_tool_via_llm("t1", "qué proyectos hay activos?")
    assert resolved is not None
    binding, params = resolved
    assert binding.tool_slug == "proyectos"
    assert params == {"estado": "activo"}  # 'foo' descartado (no está en el schema)


@pytest.mark.asyncio
async def test_sin_tool_va_a_rag(wired_tc, monkeypatch):
    # El LLM responde con texto (no llama tool) → None → RAG.
    async def _select(messages, tools, tenant_id=None):
        return None
    monkeypatch.setattr("services.groq_client.select_tool", _select)
    assert await connector_router._resolve_tool_via_llm("t1", "hola") is None


@pytest.mark.asyncio
async def test_slug_inexistente_fail_closed(wired_tc, monkeypatch):
    # El LLM alucina un slug fuera del catálogo → fail-closed → None → RAG.
    async def _select(messages, tools, tenant_id=None):
        return {"name": "tool_que_no_existe", "arguments": {}}
    monkeypatch.setattr("services.groq_client.select_tool", _select)
    assert await connector_router._resolve_tool_via_llm("t1", "cualquier cosa") is None


@pytest.mark.asyncio
async def test_unified_maybe_handle_no_selecciona(monkeypatch):
    # En modo unified, sin FSM activo, maybe_handle NO clasifica ni selecciona:
    # devuelve None y la decisión queda en la llamada RAG (handle_query+tools).
    from core.config import settings
    monkeypatch.setattr(settings, "connectors_enabled", True)
    monkeypatch.setattr(settings, "connector_routing_mode", "unified")

    class _NoFlowRedis:
        async def get(self, k):
            return None
    monkeypatch.setattr(connector_router, "get_redis_session", lambda: _NoFlowRedis())

    called = {"select": False, "cosine": False}
    async def _select(*a, **k):
        called["select"] = True
    monkeypatch.setattr("services.groq_client.select_tool", _select)

    r = await connector_router.maybe_handle("t1", "conv-u1", "qué proyectos hay?")
    assert r is None
    assert called["select"] is False  # la selección NO ocurre acá en unified


@pytest.mark.asyncio
async def test_handle_tool_signal_despacha_y_filtra(wired_tc, monkeypatch):
    # handle_tool_signal: resuelve slug → filtra params → despacha (tool pública).
    from services.connector_executor import OK

    class _Res:
        outcome = OK
        data = {"proyectos": ["Beta"]}
    seen = {}
    async def _exec(binding, identity="", params=None):
        seen["params"] = params
        return _Res()
    monkeypatch.setattr(connector_router, "execute_tool", _exec)
    async def _noop_audit(*a, **k):
        return None
    monkeypatch.setattr(connector_router, "record_tool_call", _noop_audit, raising=False)
    async def _phrase(tenant_id, question, data, nombre):
        return "Proyecto: Beta"
    monkeypatch.setattr(connector_router, "_phrase_with_llm", _phrase)

    r = await connector_router.handle_tool_signal(
        "t1", "conv-u2", "mostrame los proyectos activos",
        "proyectos", {"estado": "activo", "hack": "x"},
    )
    assert r is not None and "Beta" in r["answer"]
    assert seen["params"] == {"estado": "activo"}  # 'hack' filtrado por schema


@pytest.mark.asyncio
async def test_handle_tool_signal_slug_desconocido(wired_tc):
    # Slug alucinado → None (el caller reintenta RAG). Fail-closed.
    r = await connector_router.handle_tool_signal(
        "t1", "conv-u3", "lo que sea", "tool_inexistente", {})
    assert r is None


@pytest.mark.asyncio
async def test_dispatch_merge_params_lexico_llm(wired_tc, monkeypatch):
    # El extractor léxico rellena params que el LLM omitió: acá el LLM manda {} pero
    # el mensaje dice "activos" → el enum-match provee estado=activo (no re-pregunta).
    from services.connector_executor import OK

    class _Res:
        outcome = OK
        data = {"proyectos": []}
    seen = {}
    async def _exec(binding, identity="", params=None):
        seen["params"] = params
        return _Res()
    monkeypatch.setattr(connector_router, "execute_tool", _exec)
    async def _noop_audit(*a, **k):
        return None
    monkeypatch.setattr(connector_router, "record_tool_call", _noop_audit, raising=False)
    async def _phrase(tenant_id, question, data, nombre):
        return "ok"
    monkeypatch.setattr(connector_router, "_phrase_with_llm", _phrase)

    r = await connector_router.handle_tool_signal(
        "t1", "conv-u4", "mostrame los proyectos activos", "proyectos", {})
    assert r is not None
    assert seen["params"] == {"estado": "activo"}  # rellenado por extract_params


@pytest.mark.asyncio
async def test_maybe_handle_ejecuta_tool_publica(wired_tc, monkeypatch):
    # Integración: tool_calling → tool pública → execute_tool → respuesta.
    async def _select(messages, tools, tenant_id=None):
        return {"name": "proyectos", "arguments": {"estado": "activo"}}
    monkeypatch.setattr("services.groq_client.select_tool", _select)

    from services.connector_executor import OK

    class _Res:
        outcome = OK
        data = {"proyectos": ["Alpha"]}
    async def _exec(binding, identity="", params=None):
        assert params == {"estado": "activo"}  # los params del LLM llegan al executor
        return _Res()
    monkeypatch.setattr(connector_router, "execute_tool", _exec)
    async def _noop_audit(*a, **k):
        return None
    monkeypatch.setattr(connector_router, "record_tool_call", _noop_audit, raising=False)
    async def _phrase(tenant_id, question, data, nombre):
        return "Proyecto activo: Alpha"
    monkeypatch.setattr(connector_router, "_phrase_with_llm", _phrase)

    r = await connector_router.maybe_handle("t1", "conv-tc-1", "qué proyectos hay activos?")
    assert r is not None
    assert "Alpha" in r["answer"]
    assert r["connector_handled"] is True
