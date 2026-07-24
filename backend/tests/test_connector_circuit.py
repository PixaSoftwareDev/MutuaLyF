"""Circuit breaker del executor: POR CONECTOR, no global.

Regresión del incidente 2026-07-22: un conector con el upstream roto (SSL
inválido) abría el circuito global y tiraba las tools de TODOS los conectores
del worker. El breaker ahora se clava por (tenant, connector_id).
"""

import pytest

from services import connector_executor as ex
from services.connectors_dao import ToolBinding


def _binding(connector_id: str, slug: str) -> ToolBinding:
    return ToolBinding(
        tenant_id="t1", intent_label=slug, min_confidence=0.0,
        tool_id=f"00000000-0000-0000-0000-0000000000{connector_id[-2:]}", tool_slug=slug,
        http_method="GET", path_template=f"/{slug}",
        params_schema={}, response_map={},
        identity_kind="publico", is_read_only=True,
        connector_id=connector_id, connector_slug=f"conn-{connector_id}",
        base_url="https://api.ejemplo.com.ar", egress_allow=["api.ejemplo.com.ar"],
        auth_type="bearer", auth_secret_ref=None, timeout_ms=2000, roles=set(),
    )


@pytest.fixture(autouse=True)
def _clean_circuits():
    ex._circuits.clear()
    yield
    ex._circuits.clear()


def test_estado_por_clave_aislado():
    # 3 fallos abren el circuito de A; B queda intacto.
    for _ in range(ex._CIRCUIT_THRESHOLD):
        ex._record_failure("t1:conn-a")
    assert ex._circuit_is_open("t1:conn-a") is True
    assert ex._circuit_is_open("t1:conn-b") is False

    # Reset de A no toca el estado (inexistente) de B ni revive fallos viejos.
    ex._reset_circuit("t1:conn-a")
    assert ex._circuit_is_open("t1:conn-a") is False


def test_half_open_deja_pasar_una_prueba():
    for _ in range(ex._CIRCUIT_THRESHOLD):
        ex._record_failure("t1:conn-a")
    assert ex._circuit_is_open("t1:conn-a") is True
    # Simular que pasó el TTL: el próximo chequeo habilita UNA prueba.
    ex._circuits["t1:conn-a"]["opened_at"] -= ex._CIRCUIT_HALF_OPEN_TTL + 1
    assert ex._circuit_is_open("t1:conn-a") is False   # half-open: probe permitido
    # Si la prueba falla, re-abre en el acto (threshold-1 + 1 fallo).
    ex._record_failure("t1:conn-a")
    assert ex._circuit_is_open("t1:conn-a") is True


@pytest.mark.asyncio
async def test_conector_roto_no_tira_al_sano(monkeypatch):
    """Integración: A falla 3 veces y abre SU circuito; B sigue ejecutando."""
    roto, sano = _binding("conn-a", "tarifas"), _binding("conn-b", "horarios")

    async def _invoke(binding, path, query):
        if binding.connector_id == "conn-a":
            raise RuntimeError("SSL: CERTIFICATE_VERIFY_FAILED")
        return {"data": [1, 2]}
    monkeypatch.setattr(ex, "_invoke_http", _invoke)

    for _ in range(ex._CIRCUIT_THRESHOLD):
        r = await ex.execute_tool(roto, identity="")
        assert r.outcome == ex.UPSTREAM_ERROR

    # 4ª llamada a A: circuito abierto, ni intenta invocar.
    r = await ex.execute_tool(roto, identity="")
    assert r.detail.get("error") == "circuit_open"

    # B no se entera: ejecuta normal.
    r = await ex.execute_tool(sano, identity="")
    assert r.outcome == ex.OK
    assert r.detail.get("error") is None
