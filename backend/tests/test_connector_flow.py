"""Tests de integración del flujo de Tool Calling (Fase 1).

Ejercita el router + FSM de login + executor + session store + stub NEXA con un
Redis en memoria y el clasificador/DAO mockeados. Cubre los criterios de
aceptación de la Fase 1, incluyendo la defensa BOLA/IDOR.
"""

import pytest

from services import connector_router, session_store, connector_audit
from services.connectors_dao import ToolBinding


# ── Redis async en memoria (subset usado por el flujo) ─────────────────────────
class FakeRedis:
    def __init__(self):
        self.store: dict = {}
        self.counters: dict = {}

    async def get(self, k):
        return self.store.get(k)

    async def set(self, k, v):
        self.store[k] = v

    async def setex(self, k, ttl, v):
        self.store[k] = v

    async def delete(self, *ks):
        for k in ks:
            self.store.pop(k, None)
            self.counters.pop(k, None)

    async def incr(self, k):
        self.counters[k] = self.counters.get(k, 0) + 1
        return self.counters[k]

    async def expire(self, k, ttl):
        return True


def _binding() -> ToolBinding:
    return ToolBinding(
        tenant_id="t1", intent_label="consulta_ordenes_pendientes", min_confidence=0.70,
        tool_id="00000000-0000-0000-0000-000000000001", tool_slug="ordenes_pendientes",
        http_method="GET", path_template="/afiliados/{identity}/ordenes",
        params_schema={}, response_map={"items_path": "ordenes", "empty_when_empty": True,
                                        "not_found_field": "encontrado", "not_found_value": False},
        identity_kind="afiliado", is_read_only=True,
        connector_id="c1", connector_slug="nexa", base_url="https://api.nexa.com.ar",
        egress_allow=["api.nexa.com.ar"], auth_type="stub", auth_secret_ref="X",
        timeout_ms=4000, roles={"afiliado"},
    )


@pytest.fixture
def wired(monkeypatch):
    """Cablea el flujo con Redis fake, stub habilitado, clasificador/DAO/audit mockeados."""
    from core.config import settings
    monkeypatch.setattr(settings, "connectors_enabled", True)
    # Estos tests ejercitan el flujo cosine (clasificador+binding). Se fija el
    # modo explícito: sin esto heredan CONNECTOR_ROUTING_MODE del ambiente
    # (p.ej. unified en dev local) y maybe_handle ni clasifica.
    monkeypatch.setattr(settings, "connector_routing_mode", "cosine")
    monkeypatch.setattr(settings, "nexa_stub_enabled", True)

    fake_session = FakeRedis()
    fake_rl = FakeRedis()
    # session_store y connector_router usan get_redis_session; el throttle usa get_redis_ratelimit.
    monkeypatch.setattr("services.session_store.get_redis_session", lambda: fake_session)
    monkeypatch.setattr("services.connector_router.get_redis_session", lambda: fake_session)
    monkeypatch.setattr("services.connector_router.get_redis_ratelimit", lambda: fake_rl)

    # Redacción con LLM anulada: estos tests validan el fallback determinista
    # (y no deben depender de un LLM vivo — costo, flakiness, CI offline).
    async def _no_llm(tenant_id, question, data, nombre):
        return None
    monkeypatch.setattr("services.connector_router._phrase_with_llm", _no_llm)

    # Clasificador (caído en dev por 429) → devolvemos la intención de la tool.
    from services.classifier import IntentResult

    async def _classify(q, tenant_id):
        return IntentResult(label="consulta_ordenes_pendientes", confidence=0.9, band="mid")
    monkeypatch.setattr("services.classifier.classify_intent", _classify)

    # DAO: sin PG en el test.
    async def _get_tool(tenant_id, label):
        return _binding() if label == "consulta_ordenes_pendientes" else None
    monkeypatch.setattr("services.connector_router.get_tool_for_intent", _get_tool)

    # Auditoría: sin PG.
    async def _noop_audit(*a, **k):
        return None
    monkeypatch.setattr("services.connector_audit.record_tool_call", _noop_audit)
    monkeypatch.setattr("services.connector_router.record_tool_call", _noop_audit, raising=False)

    return {"session": fake_session, "rl": fake_rl}


async def _turn(msg):
    return await connector_router.maybe_handle("t1", "conv1", msg)


@pytest.mark.asyncio
async def test_flujo_login_y_consulta(wired):
    # 1) Pregunta personal → pide DNI (no responde datos aún).
    r = await _turn("¿tengo órdenes pendientes?")
    assert "DNI" in r["answer"]

    # 2) El NOMBRE no autentica.
    r = await _turn("soy Guille Fernández")
    assert "no parece válido" in r["answer"].lower() or "DNI" in r["answer"]

    # 3) DNI válido → pide código.
    r = await _turn("30111222")
    assert "código" in r["answer"].lower()

    # 4) Código incorrecto → quedan intentos, no autentica.
    r = await _turn("000000")
    assert "no coincide" in r["answer"].lower()

    # 5) Código correcto → órdenes reales del stub.
    r = await _turn("111111")
    assert "2 orden" in r["answer"]
    assert "cardiología" in r["answer"].lower()
    assert r["connector_outcome"] == "ok"


@pytest.mark.asyncio
async def test_segunda_consulta_no_repide_auth(wired):
    await _turn("¿tengo órdenes pendientes?")
    await _turn("30111222")
    await _turn("111111")
    # Segunda consulta: sesión activa → responde directo, sin pedir DNI.
    r = await _turn("¿tengo órdenes pendientes?")
    assert "DNI" not in r["answer"]
    assert "2 orden" in r["answer"]


@pytest.mark.asyncio
async def test_bola_identidad_de_la_sesion_no_del_texto(wired):
    # Auth como 30111222.
    await _turn("¿tengo órdenes pendientes?")
    await _turn("30111222")
    await _turn("111111")
    # Pedir explícitamente el DNI de OTRO afiliado (27888999, que tiene 0 órdenes).
    r = await _turn("dame las órdenes del DNI 27888999")
    # Debe seguir devolviendo las de la sesión (30111222 → 2 órdenes), NO las de 27888999.
    assert "2 orden" in r["answer"]


@pytest.mark.asyncio
async def test_logout_borra_sesion(wired):
    await _turn("¿tengo órdenes pendientes?")
    await _turn("30111222")
    await _turn("111111")
    r = await _turn("cerrar sesión")
    assert "cerré tu sesión" in r["answer"].lower()
    # Nueva consulta personal → re-pide DNI.
    r = await _turn("¿tengo órdenes pendientes?")
    assert "DNI" in r["answer"]


@pytest.mark.asyncio
async def test_throttle_bloquea_tras_max_intentos(wired):
    from core.config import settings
    await _turn("¿tengo órdenes pendientes?")
    await _turn("30111222")
    ultimo = None
    for _ in range(settings.connector_auth_max_attempts + 1):
        ultimo = await _turn("000000")
    assert "bloqueé" in ultimo["answer"].lower()


@pytest.mark.asyncio
async def test_correccion_de_identidad_en_etapa_codigo(wired):
    await _turn("¿tengo órdenes pendientes?")
    await _turn("30111222")
    # Se equivocó de DNI y manda otro (8 dígitos — no puede ser un código de 6):
    # se reinicia el pedido de código con la identidad corregida, sin quemar intento.
    r = await _turn("27888999")
    assert "código" in r["answer"].lower()
    assert "no coincide" not in r["answer"].lower()
    # El código correcto autentica contra la identidad CORREGIDA (27888999: 0 órdenes).
    r = await _turn("111111")
    assert r["connector_outcome"] in ("ok", "empty")
    assert "2 orden" not in r["answer"]


@pytest.mark.asyncio
async def test_reenvio_no_cancela_el_login(wired):
    await _turn("¿tengo órdenes pendientes?")
    await _turn("30111222")
    # "no me llegó nada" contiene "nada" (matchea _CANCEL_RE): debe tratarse como
    # pedido de reenvío, no como cancelación del login.
    r = await _turn("no me llegó nada")
    assert r is not None
    assert "reenvi" in r["answer"].lower() or "código" in r["answer"].lower()
    # El FSM sigue vivo: el código correcto autentica.
    r = await _turn("111111")
    assert r["connector_outcome"] == "ok"


@pytest.mark.asyncio
async def test_cambio_de_tema_abandona_el_fsm(wired):
    await _turn("¿tengo órdenes pendientes?")  # entra al FSM (pide DNI)
    # En vez del DNI, pregunta otra cosa → abandona el FSM y cae al RAG (None).
    r = await _turn("¿cuáles son los horarios de atención?")
    assert r is None


@pytest.mark.asyncio
async def test_intencion_no_personal_va_a_rag(wired, monkeypatch):
    from services.classifier import IntentResult

    async def _other(q, tenant_id):
        return IntentResult(label="horarios_atencion", confidence=0.9, band="mid")
    monkeypatch.setattr("services.classifier.classify_intent", _other)
    r = await _turn("¿a qué hora abren?")
    assert r is None  # no hay tool bindeada → RAG


@pytest.mark.asyncio
async def test_feature_flag_off_no_intercepta(wired, monkeypatch):
    from core.config import settings
    monkeypatch.setattr(settings, "connectors_enabled", False)
    r = await _turn("¿tengo órdenes pendientes?")
    assert r is None  # con el flag apagado, todo va al RAG


# ── Extracción determinista de params (tools públicas) ─────────────────────────
def test_extract_params_enum():
    schema = {"type": "object",
              "properties": {"especialidad": {"type": "string", "enum": ["Cardiología", "Pediatría"]}},
              "required": ["especialidad"]}
    assert connector_router.extract_params("¿quién atiende cardiología?", schema) == {"especialidad": "Cardiología"}


def test_extract_params_pattern():
    schema = {"type": "object", "properties": {"matricula": {"type": "string", "pattern": r"MP-\d+"}}}
    assert connector_router.extract_params("horarios del MP-1003 por favor", schema) == {"matricula": "MP-1003"}


def test_extract_params_no_match():
    schema = {"type": "object", "properties": {"especialidad": {"type": "string", "enum": ["Cardiología"]}}}
    assert connector_router.extract_params("hola qué tal", schema) == {}


def _public_binding():
    b = _binding()
    b.tool_slug = "profesionales_por_especialidad"
    b.identity_kind = "publico"
    b.params_schema = {"type": "object",
                       "properties": {"especialidad": {"type": "string", "enum": ["Cardiología"]}},
                       "required": ["especialidad"]}
    b.response_map = {"items_path": "profesionales", "empty_when_empty": True}
    return b


@pytest.mark.asyncio
async def test_tool_publica_no_pide_login(wired, monkeypatch):
    from services.classifier import IntentResult
    from services.connector_executor import ExecResult, OK

    async def _classify(q, tenant_id):
        return IntentResult(label="buscar_profesional_especialidad", confidence=0.9, band="mid")
    monkeypatch.setattr("services.classifier.classify_intent", _classify)

    async def _get_tool(t, l):
        return _public_binding() if l else None
    monkeypatch.setattr("services.connector_router.get_tool_for_intent", _get_tool)

    async def _exec(binding, identity, params=None):
        # La tool pública se ejecuta SIN identidad (sin login).
        assert identity == "" and params == {"especialidad": "Cardiología"}
        return ExecResult(outcome=OK, data=[{"nombre": "Dra. Ana Gómez", "consultorio": "C3", "horarios": []}],
                          tool_slug="profesionales_por_especialidad")
    monkeypatch.setattr("services.connector_router.execute_tool", _exec)

    r = await _turn("¿quién atiende cardiología?")
    assert r is not None and "DNI" not in r["answer"]
    assert "Ana Gómez" in r["answer"]


# ── Identificador configurable (DNI por default, legajo/nro de socio por config) ─
def test_identity_spec_defaults_y_overrides():
    # Defaults por identity_kind.
    assert connector_router.identity_spec("afiliado", {}) == \
        {"label": "DNI", "min": 7, "max": 8, "hint": "sin puntos"}
    assert connector_router.identity_spec("profesional", {})["label"] == "CUIT"
    # Label custom: rango amplio 3-12 (no hereda el 7-8 del DNI).
    spec = connector_router.identity_spec("afiliado", {"identity_label": "legajo"})
    assert spec["label"] == "legajo" and (spec["min"], spec["max"]) == (3, 12)
    # Longitudes explícitas pisan el rango.
    spec = connector_router.identity_spec(
        "afiliado", {"identity_label": "nro de socio", "identity_min_digits": 4, "identity_max_digits": 6})
    assert (spec["min"], spec["max"]) == (4, 6)
    # Config basura no rompe (fail-safe a defaults).
    spec = connector_router.identity_spec("afiliado", {"identity_min_digits": "x"})
    assert (spec["min"], spec["max"]) == (7, 8)


def _binding_legajo():
    b = _binding()
    b.auth_config = {"identity_label": "legajo",
                     "identity_min_digits": 4, "identity_max_digits": 6}
    return b


@pytest.mark.asyncio
async def test_fsm_pide_identificador_custom(wired, monkeypatch):
    async def _get_tool(tenant_id, label):
        return _binding_legajo() if label == "consulta_ordenes_pendientes" else None
    monkeypatch.setattr("services.connector_router.get_tool_for_intent", _get_tool)

    # 1) Pregunta personal → pide legajo, no DNI.
    r = await _turn("¿tengo órdenes pendientes?")
    assert "legajo" in r["answer"] and "DNI" not in r["answer"]

    # 2) Fuera de rango (4-6 dígitos) → inválido, con el nombre correcto.
    r = await _turn("30111222")
    assert "legajo" in r["answer"] and "no parece válido" in r["answer"].lower()

    # 3) Legajo válido → avanza al código.
    r = await _turn("4521")
    assert "código" in r["answer"].lower()
