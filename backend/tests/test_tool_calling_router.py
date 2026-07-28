"""Tests del ruteo unificado de conectores.

La DECISIÓN de tool ocurre dentro de la llamada RAG; su resultado se despacha por
`handle_tool_signal(slug, params)`. Acá se mockea el DAO/executor (sin PG/red) para
validar: resolución por slug, filtrado de params alucinados, fail-closed ante slug
inexistente, y que `maybe_handle` (sin FSM activo) NO selecciona ninguna tool.
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

    async def _catalog(tenant_id):
        return _CATALOG
    monkeypatch.setattr(connector_router, "list_tools_for_tool_calling", _catalog)

    async def _by_slug(tenant_id, slug):
        return _binding_publico() if slug == "proyectos" else None
    monkeypatch.setattr(connector_router, "get_tool_by_slug", _by_slug)


@pytest.mark.asyncio
async def test_maybe_handle_sin_fsm_no_selecciona(monkeypatch):
    # Sin FSM activo, maybe_handle NO decide tools: devuelve None y la selección
    # queda en la única llamada RAG (handle_query + tool_schemas). El ruteo previo
    # con una llamada LLM separada (select_tool pre-RAG) se eliminó.
    from core.config import settings
    monkeypatch.setattr(settings, "connectors_enabled", True)

    class _NoFlowRedis:
        async def get(self, k):
            return None
    monkeypatch.setattr(connector_router, "get_redis_session", lambda: _NoFlowRedis())

    r = await connector_router.maybe_handle("t1", "conv-u1", "qué proyectos hay?")
    assert r is None


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
    async def _phrase(tenant_id, question, data, nombre, **kwargs):
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
    async def _phrase(tenant_id, question, data, nombre, **kwargs):
        return "ok"
    monkeypatch.setattr(connector_router, "_phrase_with_llm", _phrase)

    r = await connector_router.handle_tool_signal(
        "t1", "conv-u4", "mostrame los proyectos activos", "proyectos", {})
    assert r is not None
    assert seen["params"] == {"estado": "activo"}  # rellenado por extract_params


@pytest.mark.asyncio
async def test_tool_signal_ejecuta_tool_publica(wired_tc, monkeypatch):
    # Integración: la decisión RAG entrega (slug, params) → handle_tool_signal →
    # tool pública → execute_tool → respuesta redactada.
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
    async def _phrase(tenant_id, question, data, nombre, **kwargs):
        return "Proyecto activo: Alpha"
    monkeypatch.setattr(connector_router, "_phrase_with_llm", _phrase)

    r = await connector_router.handle_tool_signal(
        "t1", "conv-tc-1", "qué proyectos hay activos?",
        "proyectos", {"estado": "activo"})
    assert r is not None
    assert "Alpha" in r["answer"]
    assert r["connector_handled"] is True
