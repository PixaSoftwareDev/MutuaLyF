"""Tests del loop agéntico acotado de conectores.

Ejercitan _run_tool_and_format con LLM y executor mockeados (sin red, sin PG):
encadenado lista→detalle, procedencia de ids (anti-BOLA de recursos), dedupe,
tope de llamadas, memoria conversacional entre turnos y el caso simple de una
sola llamada (sin regresión de comportamiento).
"""

import pytest

from services import connector_router
from services.connectors_dao import ToolBinding
from services.connector_executor import EMPTY, OK, ExecResult


class FakeRedis:
    def __init__(self):
        self.store: dict = {}

    async def get(self, k):
        return self.store.get(k)

    async def setex(self, k, ttl, v):
        self.store[k] = v

    async def delete(self, *ks):
        for k in ks:
            self.store.pop(k, None)


def _mk_binding(slug: str, path: str, params_schema: dict) -> ToolBinding:
    return ToolBinding(
        tenant_id="t1", intent_label=slug, min_confidence=0.0,
        tool_id=f"00000000-0000-0000-0000-00000000000{len(slug) % 10}", tool_slug=slug,
        http_method="GET", path_template=path,
        params_schema=params_schema, response_map={},
        identity_kind="afiliado", is_read_only=True,
        connector_id="c1", connector_slug="demo", base_url="https://api.ejemplo.com.ar",
        egress_allow=["api.ejemplo.com.ar"], auth_type="stub", auth_secret_ref="X",
        timeout_ms=4000, roles={"afiliado"},
    )


LISTA = _mk_binding("lista_proyectos", "/projects", {})
DETALLE = _mk_binding("detalle_proyecto", "/projects/{id}", {
    "type": "object",
    "properties": {"id": {"type": "string", "x-resource-id": True}},
    "required": ["id"],
})
CONTACTOS = _mk_binding("lista_contactos", "/contacts", {
    "type": "object", "properties": {"search": {"type": "string"}},
})

PROYECTOS = [{"id": "7", "name": "Alfa"}, {"id": "9", "name": "Beta"}]
DETALLE_7 = {"id": "7", "name": "Alfa", "estado": "activo", "avance": "80%"}


@pytest.fixture
def loop_wired(monkeypatch):
    """Cablea el loop: catálogo, executor, memoria y auditoría fakes."""
    calls: list = []       # (slug, params) ejecutados realmente
    llm_script: list = []  # respuestas (answer, pick) de _loop_llm, en orden

    catalog = [
        {"slug": "lista_proyectos", "display_name": "Lista de proyectos",
         "description": "Lista los proyectos (id, nombre).", "params_schema": {},
         "identity_kind": "afiliado", "is_read_only": True},
        {"slug": "detalle_proyecto", "display_name": "Detalle de proyecto",
         "description": "Detalle por id (sale de lista_proyectos).",
         "params_schema": DETALLE.params_schema,
         "identity_kind": "afiliado", "is_read_only": True},
    ]

    async def _catalog(tenant_id):
        return catalog

    async def _by_slug(tenant_id, slug):
        return {"lista_proyectos": LISTA, "detalle_proyecto": DETALLE,
                "lista_contactos": CONTACTOS}.get(slug)

    async def _execute(binding, identity="", params=None):
        calls.append((binding.tool_slug, dict(params or {})))
        if binding.tool_slug == "lista_proyectos":
            return ExecResult(outcome=OK, data=PROYECTOS, tool_slug=binding.tool_slug)
        if binding.tool_slug == "lista_contactos":
            # Búsqueda sin match (ej. search=intellix, que no es un cliente).
            return ExecResult(outcome=EMPTY, data=[], tool_slug=binding.tool_slug)
        if binding.tool_slug == "detalle_proyecto" and (params or {}).get("id") == "7":
            return ExecResult(outcome=OK, data=DETALLE_7, tool_slug=binding.tool_slug)
        return ExecResult(outcome="upstream_error", tool_slug=binding.tool_slug)

    async def _llm(tenant_id, question, nombre, mem_note, steps, tools, note=None):
        if llm_script:
            return llm_script.pop(0)
        return (None, None)

    async def _noop(*a, **k):
        return None

    monkeypatch.setattr("services.connector_router.list_tools_for_tool_calling", _catalog)
    monkeypatch.setattr("services.connector_router.get_tool_by_slug", _by_slug)
    monkeypatch.setattr("services.connector_router.execute_tool", _execute)
    monkeypatch.setattr("services.connector_router._loop_llm", _llm)
    monkeypatch.setattr("services.connector_router._phrase_with_llm", _noop)
    monkeypatch.setattr("services.connector_audit.record_tool_call", _noop)

    # Espía del flywheel: qué (tool_id, query) se capturó como candidato.
    flywheel: list = []

    async def _capture(tid, tool_id, query):
        flywheel.append((tool_id, query))
    import services.connectors_dao as _dao
    monkeypatch.setattr(_dao, "record_example_candidate", _capture)
    monkeypatch.setattr("services.connector_audit.mask_pii", lambda s: s)

    fake = FakeRedis()
    monkeypatch.setattr("services.connector_memory.get_redis_session", lambda: fake)
    monkeypatch.setattr("services.connector_memory.encrypt_secret", lambda s: s)
    monkeypatch.setattr("services.connector_memory.decrypt_secret", lambda s: s)

    return {"calls": calls, "llm": llm_script, "redis": fake, "flywheel": flywheel}


async def _run(binding, params, question="dame el detalle del proyecto Alfa", conv="conv1"):
    return await connector_router._run_tool_and_format(
        binding, tenant_id="t1", conv_id=conv, question=question,
        identity="30111222", nombre="Guille", params=params)


@pytest.mark.asyncio
async def test_encadena_lista_detalle(loop_wired):
    """El caso estrella: piden un detalle sin id → el loop llama la lista, saca el
    id real del resultado y llama el detalle. La respuesta final la redacta el LLM."""
    loop_wired["llm"].extend([
        (None, {"name": "lista_proyectos", "arguments": {}}),        # corrige: primero la lista
        (None, {"name": "detalle_proyecto", "arguments": {"id": "7"}}),  # encadena con id real
        ("El proyecto Alfa está activo, con un avance del 80%.", None),  # respuesta final
    ])
    r = await _run(DETALLE, {})
    assert loop_wired["calls"] == [("lista_proyectos", {}), ("detalle_proyecto", {"id": "7"})]
    assert "Alfa" in r["answer"]
    assert r["connector_outcome"] == "ok"


@pytest.mark.asyncio
async def test_procedencia_bloquea_id_inventado(loop_wired):
    """Anti-BOLA de recursos: un id que no salió de ningún resultado de la
    conversación NUNCA se ejecuta, aunque el LLM insista."""
    loop_wired["llm"].extend([
        (None, {"name": "detalle_proyecto", "arguments": {"id": "999"}}),
        (None, {"name": "detalle_proyecto", "arguments": {"id": "999"}}),
        (None, {"name": "detalle_proyecto", "arguments": {"id": "999"}}),
        (None, {"name": "detalle_proyecto", "arguments": {"id": "999"}}),
    ])
    r = await _run(DETALLE, {"id": "999"})
    assert loop_wired["calls"] == []          # jamás se ejecutó con el id inventado
    assert "lista" in r["answer"].lower()     # guía al usuario al listado


@pytest.mark.asyncio
async def test_dedupe_corta_repeticion(loop_wired):
    """Si el LLM repite exactamente la misma llamada, el loop corta y responde
    con el último resultado (fallback determinista)."""
    loop_wired["llm"].extend([
        (None, {"name": "lista_proyectos", "arguments": {}}),  # repetida
    ])
    r = await _run(LISTA, {}, question="mostrame los proyectos")
    assert loop_wired["calls"] == [("lista_proyectos", {})]    # una sola ejecución
    assert "Alfa" in r["answer"]                                # fallback con el dato


@pytest.mark.asyncio
async def test_single_hop_sin_regresion(loop_wired):
    """Una lista simple: 1 ejecución y la respuesta la redacta el loop (una sola
    llamada LLM, igual que el _phrase_with_llm de antes)."""
    loop_wired["llm"].extend([
        ("Tenés 2 proyectos: • Alfa • Beta", None),
    ])
    r = await _run(LISTA, {}, question="mostrame los proyectos")
    assert loop_wired["calls"] == [("lista_proyectos", {})]
    assert r["answer"].startswith("Tenés 2 proyectos")


@pytest.mark.asyncio
async def test_memoria_entre_turnos_habilita_detalle_directo(loop_wired):
    """Turno 1 lista → turno 2 'detalle del 7' pasa procedencia por memoria y va
    directo al detalle, sin repetir la lista."""
    loop_wired["llm"].extend([("Tus proyectos: Alfa y Beta.", None)])
    await _run(LISTA, {}, question="mostrame los proyectos")

    loop_wired["llm"].extend([("Alfa está activo, avance 80%.", None)])
    r = await _run(DETALLE, {"id": "7"}, question="dame el detalle del proyecto 7")
    assert loop_wired["calls"] == [("lista_proyectos", {}), ("detalle_proyecto", {"id": "7"})]
    assert "80" in r["answer"]


@pytest.mark.asyncio
async def test_vacio_reinterpreta_con_otra_tool(loop_wired):
    """Caso 'detalles de Intellix': la búsqueda en contactos viene vacía, el loop
    NO corta — el LLM reinterpreta y prueba en proyectos, que sí tiene el dato."""
    loop_wired["llm"].extend([
        (None, {"name": "lista_proyectos", "arguments": {}}),   # vacío → reinterpreta
        ("Intellix es un proyecto activo de MutuaLyF.", None),  # respuesta con el dato
    ])
    r = await _run(CONTACTOS, {"search": "intellix"}, question="dame detalles de intellix")
    assert loop_wired["calls"] == [("lista_contactos", {"search": "intellix"}),
                                   ("lista_proyectos", {})]
    assert "Intellix" in r["answer"]
    assert r["connector_outcome"] == "ok"


@pytest.mark.asyncio
async def test_vacio_sin_alternativa_responde_honesto(loop_wired):
    """Vacío y el LLM no ve otra tool aplicable → respuesta honesta del LLM (o el
    fallback determinista de vacío), nunca un invento."""
    loop_wired["llm"].extend([
        ("No encontré ningún contacto con ese nombre.", None),
    ])
    r = await _run(CONTACTOS, {"search": "zzz"}, question="buscá el contacto zzz")
    assert loop_wired["calls"] == [("lista_contactos", {"search": "zzz"})]
    assert "no encontré" in r["answer"].lower()


@pytest.mark.asyncio
async def test_no_filtra_eco_del_andamiaje(loop_wired):
    """Regresión del leak: si el LLM devuelve como texto el eco del andamiaje
    ('[Llamé a lista_proyectos con {}]') en vez de una tool call o respuesta real,
    NO se le muestra al usuario — se cae al fallback determinista con el dato."""
    loop_wired["llm"].extend([
        ("[Llamé a lista_proyectos con {}]", None),  # eco del scaffolding, no respuesta
    ])
    r = await _run(LISTA, {}, question="mostrame los proyectos")
    assert not r["answer"].strip().startswith("[Llamé a")
    assert "Alfa" in r["answer"]  # fallback determinista con el resultado real


def test_logout_reconoce_voseo_y_variantes():
    """El logout matcheaba solo 'cerrar sesión'; 'cerrá mi sesión' (voseo, como lo
    escribe un argentino) caía al RAG que respondía 'no puedo cerrar sesiones'."""
    r = connector_router._LOGOUT_RE
    assert r.search("cerrá mi sesión")
    assert r.search("cerra mi sesion")
    assert r.search("cerrar sesión")
    assert r.search("quiero desconectarme")
    assert not r.search("cuánto tengo en mi cuenta")


def test_looks_like_scaffold_detecta_variantes():
    f = connector_router._looks_like_scaffold
    assert f("[Llamé a lista_proyectos con {}]")
    assert f("  [Llamé a detalle_proyecto con {'id': '7'}]")
    assert f("[llame a lista_tareas con {}]")  # sin tilde, minúscula
    assert not f("Tenés 2 proyectos: Alfa y Beta.")
    assert not f("")
    assert not f(None)


@pytest.mark.asyncio
async def test_flywheel_captura_binding_inicial_en_caso_comun(loop_wired):
    """Regresión del bug del return temprano: en el caso común (1 llamada, el LLM
    redacta en el loop) la captura del candidato IGUAL ocurre, y con el binding
    que el router eligió (no las encadenadas)."""
    loop_wired["llm"].extend([("Tenés 2 proyectos.", None)])  # redacta y retorna temprano
    await _run(LISTA, {}, question="mostrame los proyectos")
    assert loop_wired["flywheel"] == [(LISTA.tool_id, "mostrame los proyectos")]


@pytest.mark.asyncio
async def test_flywheel_captura_solo_el_binding_del_router(loop_wired):
    """Encadenado lista→detalle: se captura para la tool que el router eligió
    (DETALLE), una sola vez — no para lista_proyectos (encadenada)."""
    loop_wired["llm"].extend([
        (None, {"name": "lista_proyectos", "arguments": {}}),
        (None, {"name": "detalle_proyecto", "arguments": {"id": "7"}}),
        ("El proyecto Alfa está activo.", None),
    ])
    await _run(DETALLE, {}, question="detalle del proyecto Alfa")
    assert loop_wired["flywheel"] == [(DETALLE.tool_id, "detalle del proyecto Alfa")]


@pytest.mark.asyncio
async def test_flywheel_no_captura_si_vacio(loop_wired):
    """Un resultado EMPTY no genera candidato (no fue una consulta 'resuelta')."""
    loop_wired["llm"].extend([("No encontré contactos.", None)])
    await _run(CONTACTOS, {"search": "zzz"}, question="buscá el contacto zzz")
    assert loop_wired["flywheel"] == []


@pytest.mark.asyncio
async def test_tope_de_llamadas(loop_wired, monkeypatch):
    """El LLM 'quiere' seguir llamando cosas distintas: el loop respeta el tope."""
    from core.config import settings
    monkeypatch.setattr(settings, "connector_loop_max_calls", 2)
    loop_wired["llm"].extend([
        (None, {"name": "detalle_proyecto", "arguments": {"id": "7"}}),
        (None, {"name": "detalle_proyecto", "arguments": {"id": "9"}}),   # no debería ejecutarse
        (None, {"name": "detalle_proyecto", "arguments": {"id": "9"}}),
    ])
    await _run(LISTA, {}, question="mostrame los proyectos")
    assert len(loop_wired["calls"]) <= 2
