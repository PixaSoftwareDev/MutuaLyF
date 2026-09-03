"""Observabilidad (2026-09-03): lo que el bot le cuenta a Prometheus y a Loki.

Sin red ni bases: métricas en el registry por defecto, logging en memoria.
"""

import logging
from unittest.mock import AsyncMock, patch

import pytest
import structlog
from prometheus_client import REGISTRY

from core.logging_config import (
    _AccessLogFilter,
    bind_log_context,
    clear_log_context,
    configure_logging,
)
from services import handoff, trust_gate


def _valor(nombre: str, **labels) -> float:
    return REGISTRY.get_sample_value(nombre, labels) or 0.0


# ── Métricas ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_trust_gate_cuenta_el_veredicto_por_etapa():
    """Cada consulta suma 1 en ia_trust_gate_total con la etapa que decidió."""
    antes = _valor("ia_trust_gate_total", tenant_id="t1", action="answer", stage="smalltalk")
    r = await trust_gate.evaluate_coverage("gracias", ["cualquier cosa"], "t1")
    assert r["reason"] == "smalltalk_skip"
    assert _valor("ia_trust_gate_total", tenant_id="t1", action="answer", stage="smalltalk") == antes + 1


@pytest.mark.asyncio
async def test_trust_gate_juez_caido_se_registra_como_judge_failed():
    with patch.object(trust_gate, "_judge", AsyncMock(return_value=None)), \
         patch.object(trust_gate.settings, "trust_gate_judge", True), \
         patch.object(trust_gate.settings, "trust_gate_lex_strong", 0.99):
        antes = _valor("ia_trust_gate_total", tenant_id="t1", action="answer", stage="judge_failed")
        r = await trust_gate.evaluate_coverage(
            "cómo saco turno para una resonancia de hombro", ["texto sin relación"], "t1"
        )
    assert r["reason"] == "judge_failed_open"
    assert _valor("ia_trust_gate_total", tenant_id="t1", action="answer", stage="judge_failed") == antes + 1


def test_handoff_cuenta_por_tenant_y_regla():
    antes = _valor("ia_handoff_total", tenant_id="t1", trigger="keyword")
    handoff._count_handoff("t1", handoff.HandoffTrigger.KEYWORD)
    assert _valor("ia_handoff_total", tenant_id="t1", trigger="keyword") == antes + 1


def test_metricas_de_ingesta_y_gate_viven_en_el_mismo_registry():
    """Las series que piden los tableros de Grafana existen con ese nombre."""
    from core import metrics

    nombres = {m.name for m in REGISTRY.collect()}
    for esperado in (
        "ia_queries", "ia_query_duration_ms", "ia_cache_hits", "ia_groq_requests",
        "ia_ingest", "ia_pipeline_duration_ms", "ia_quality_gate",
        "ia_trust_gate", "ia_handoff",
    ):
        assert esperado in nombres, esperado
    assert metrics.ACTIVE_TENANTS._multiprocess_mode == "max"


def test_celery_metrics_server_no_arranca_sin_directorio_multiproceso(monkeypatch):
    """Sin PROMETHEUS_MULTIPROC_DIR el server solo vería al proceso padre, que
    no ejecuta tareas: mejor no exponer nada que exponer ceros."""
    from core import metrics

    monkeypatch.delenv("PROMETHEUS_MULTIPROC_DIR", raising=False)
    with patch("prometheus_client.start_http_server") as srv:
        metrics.celery_metrics_server()
    srv.assert_not_called()


# ── Logs ─────────────────────────────────────────────────────────────────────

def _record(msg: str) -> logging.LogRecord:
    return logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, msg, None, None)


def test_access_log_silencia_health_y_metrics():
    f = _AccessLogFilter()
    assert not f.filter(_record('172.18.0.1:1 - "GET /health HTTP/1.1" 200 OK'))
    assert not f.filter(_record('172.18.0.1:1 - "GET /metrics HTTP/1.1" 200 OK'))
    assert f.filter(_record('1.2.3.4:1 - "POST /api/v1/widget/query HTTP/1.1" 200 OK'))


def test_uvicorn_propaga_al_handler_raiz():
    """uvicorn instala handlers propios de texto plano con propagate=False; el
    backend los desarma para que TODO salga en el mismo formato."""
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.addHandler(logging.StreamHandler())
        lg.propagate = False
    configure_logging("INFO", is_production=True)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        assert lg.handlers == [] and lg.propagate is True


def test_bind_log_context_agrega_tenant_y_omite_none():
    clear_log_context()
    bind_log_context(request_id="r1", tenant_id="mutualyf", document_id=None)
    ctx = structlog.contextvars.get_contextvars()
    assert ctx == {"request_id": "r1", "tenant_id": "mutualyf"}
    clear_log_context()
    assert structlog.contextvars.get_contextvars() == {}
