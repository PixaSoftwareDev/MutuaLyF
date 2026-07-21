"""Tests del modo platform_registry: identidad validada de NUESTRO lado.

Para conectores cuyo sistema externo no modela usuarios (ej. un CRM con solo token
de servicio): la lista blanca vive en connector_users, el login busca por documento
y manda OTP al email registrado. Ver migración 033 + connector_router.

Cubre: login OK, documento no autorizado (neutro + no envía OTP + no autentica),
y que la sesión no re-pide identidad. La defensa BOLA queda de nuestro lado: solo
autentica quien está en la lista Y controla el email registrado.
"""

import pytest

from services import connector_router
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


def _registry_binding() -> ToolBinding:
    """Conector CRM: auth por token de servicio (bearer), identidad de nuestro lado."""
    return ToolBinding(
        tenant_id="t1", intent_label="consulta_crm", min_confidence=0.70,
        tool_id="00000000-0000-0000-0000-000000000009", tool_slug="oportunidades_abiertas",
        http_method="GET", path_template="/opportunities",
        params_schema={}, response_map={},
        identity_kind="afiliado", is_read_only=True,
        connector_id="c-crm", connector_slug="pixs", base_url="https://api.pixs.local",
        egress_allow=["api.pixs.local"], auth_type="bearer", auth_secret_ref="X",
        timeout_ms=4000,
        auth_config={"identity_validation": "platform_registry"},
        roles={"afiliado"},
    )


# Lista blanca simulada (connector_users): un único usuario autorizado.
_REGISTRY = {"30111222": {"id": "u1", "documento": "30111222",
                          "email": "guille@intellix.com", "nombre": "Guille"}}


@pytest.fixture
def wired(monkeypatch):
    from core.config import settings
    monkeypatch.setattr(settings, "connectors_enabled", True)
    # Estos tests ejercitan el flujo cosine (clasificador+binding). Se fija el
    # modo explícito: sin esto heredan CONNECTOR_ROUTING_MODE del ambiente
    # (p.ej. unified en dev local) y maybe_handle ni clasifica.
    monkeypatch.setattr(settings, "connector_routing_mode", "cosine")

    fake_session = FakeRedis()
    fake_rl = FakeRedis()
    monkeypatch.setattr("services.session_store.get_redis_session", lambda: fake_session)
    monkeypatch.setattr("services.connector_router.get_redis_session", lambda: fake_session)
    monkeypatch.setattr("services.connector_router.get_redis_ratelimit", lambda: fake_rl)

    async def _no_llm(tenant_id, question, data, nombre):
        return None
    monkeypatch.setattr("services.connector_router._phrase_with_llm", _no_llm)

    from services.classifier import IntentResult

    async def _classify(q, tenant_id):
        return IntentResult(label="consulta_crm", confidence=0.9, band="mid")
    monkeypatch.setattr("services.classifier.classify_intent", _classify)

    async def _get_tool(tenant_id, label):
        return _registry_binding() if label == "consulta_crm" else None
    monkeypatch.setattr("services.connector_router.get_tool_for_intent", _get_tool)

    async def _noop_audit(*a, **k):
        return None
    monkeypatch.setattr("services.connector_audit.record_tool_call", _noop_audit)
    monkeypatch.setattr("services.connector_router.record_tool_call", _noop_audit, raising=False)

    # Lista blanca (connector_users) — patch en el módulo de origen (import tardío).
    async def _lookup(tenant_id, connector_id, documento):
        return _REGISTRY.get(documento)
    monkeypatch.setattr("services.connectors_dao.get_connector_user_by_documento", _lookup)

    # OTP propio STATEFUL: solo valida un código que fue generado para esa identidad.
    # Así un documento fuera de la lista (para el que nunca se generó código) no
    # puede autenticar ni con el código correcto de otro.
    otp_store: dict = {}
    sent: dict = {}

    async def _can_send(t, c):
        return True

    async def _generate(t, c, identity):
        otp_store[(c, identity)] = "654321"
        return "654321"

    async def _send(code, email=None):
        sent["email"] = email
        sent["code"] = code

    def _mask(email):
        return "g***@intellix.com"

    async def _validate(t, c, identity, code):
        return otp_store.get((c, identity)) == code

    monkeypatch.setattr("services.otp.can_send", _can_send)
    monkeypatch.setattr("services.otp.generate_and_store", _generate)
    monkeypatch.setattr("services.otp.send_code", _send)
    monkeypatch.setattr("services.otp.mask_email", _mask)
    monkeypatch.setattr("services.otp.validate", _validate)

    # Ejecutor mockeado: la tool del CRM devuelve un dato (no HTTP real).
    from services.connector_executor import ExecResult, OK

    async def _exec(binding, identity, params=None):
        return ExecResult(outcome=OK, data={"abiertas": 3}, tool_slug=binding.tool_slug)
    monkeypatch.setattr("services.connector_router.execute_tool", _exec)

    return {"sent": sent}


async def _turn(msg):
    return await connector_router.maybe_handle("t1", "conv1", msg)


@pytest.mark.asyncio
async def test_registry_login_ok(wired):
    # 1) Pregunta personal → pide identificarse (documento).
    r = await _turn("¿cuántas oportunidades abiertas tenemos?")
    assert "identificarte" in r["answer"].lower()

    # 2) Documento EN la lista → manda OTP a SU email registrado, pide código.
    r = await _turn("30111222")
    assert "código" in r["answer"].lower()
    assert wired["sent"]["email"] == "guille@intellix.com"

    # 3) Código correcto → la tool del CRM ejecuta.
    r = await _turn("654321")
    assert r["connector_outcome"] == "ok"


@pytest.mark.asyncio
async def test_registry_documento_no_autorizado_avisa_claro(wired):
    await _turn("¿cuántas oportunidades abiertas tenemos?")

    # Documento que NO está en la lista blanca → aviso CLARO (es un equipo interno
    # cargado por el admin, la enumeración no regala nada) y NO se envía código.
    # Decisión 2026-07-21: antes el mensaje era neutro y dejaba al usuario
    # esperando un código imposible. platform_otp/provider siguen neutros.
    r = await _turn("99999999")
    assert wired["sent"] == {}
    assert "no figura" in r["answer"].lower()

    # El FSM volvió a pedir el identificador: un documento VÁLIDO ahora sí avanza.
    r = await _turn("30111222")
    assert "código" in r["answer"].lower()
    assert wired["sent"]["email"] == "guille@intellix.com"


@pytest.mark.asyncio
async def test_registry_sesion_no_repide_identidad(wired):
    await _turn("¿cuántas oportunidades abiertas tenemos?")
    await _turn("30111222")
    r = await _turn("654321")
    assert r["connector_outcome"] == "ok"

    # Segunda consulta: sesión activa → responde directo, sin re-pedir documento.
    r = await _turn("¿y cuántas oportunidades abiertas tenemos ahora?")
    assert "identificarte" not in r["answer"].lower()
    assert r["connector_outcome"] == "ok"
