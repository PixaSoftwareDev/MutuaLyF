"""Prometheus metrics: HTTP instrumentation + custom business counters.

Custom metrics exposed at /metrics:
  ia_queries_total          — queries by tenant and complexity
  ia_cache_hits_total       — Redis cache hits
  ia_ingest_total           — documents ingested by tenant
  ia_groq_requests_total    — LLM API calls by model and status (nombre histórico)
  ia_quality_gate_total     — quality gate de INGESTA (chunks) by status
  ia_pipeline_duration_ms   — ingest pipeline duration histogram
  ia_trust_gate_total       — trust gate de CONSULTA: answer/refuse por etapa
  ia_handoff_total          — derivaciones ofrecidas por tenant y regla

Multiproceso (2026-09-03): uvicorn corre 4 workers y cada uno tenía sus
contadores en memoria — Prometheus veía UN worker al azar por scrape (1/4 de
la verdad). Con PROMETHEUS_MULTIPROC_DIR seteado (compose + entrypoint.sh),
prometheus_client escribe los valores en archivos mmap por proceso y el
instrumentator los agrega en /metrics. Sin la variable, modo single-process
(dev/tests). Las métricas de ingesta viven en el worker de Celery, que expone
su propio /metrics (ver celery_metrics_server) — antes no las veía nadie.
"""

import os

from prometheus_client import Counter, Histogram, Gauge
from prometheus_fastapi_instrumentator import Instrumentator

# ── HTTP layer (auto-instrumented) ────────────────────────────────────────────
# Exposes: http_requests_total, http_request_duration_seconds

# ── Business counters ─────────────────────────────────────────────────────────

QUERIES_TOTAL = Counter(
    "ia_queries_total",
    "Total queries processed",
    ["tenant_id", "complexity", "from_cache"],
)

CACHE_HITS_TOTAL = Counter(
    "ia_cache_hits_total",
    "Redis cache hits",
    ["tenant_id"],
)

INGEST_TOTAL = Counter(
    "ia_ingest_total",
    "Documents ingested",
    ["tenant_id", "status"],
)

GROQ_REQUESTS_TOTAL = Counter(
    "ia_groq_requests_total",
    "Groq API requests",
    ["model", "status"],  # status: success | timeout | rate_limit | error
)

QUALITY_GATE_TOTAL = Counter(
    "ia_quality_gate_total",
    "Quality gate results per chunk",
    ["status"],  # passed | pending | skipped
)

PIPELINE_DURATION = Histogram(
    "ia_pipeline_duration_ms",
    "Ingest pipeline duration in milliseconds",
    ["tenant_id"],
    buckets=[1000, 5000, 10000, 20000, 30000, 60000, 120000],
)

TRUST_GATE_TOTAL = Counter(
    "ia_trust_gate_total",
    "Trust gate (anti-alucinación) verdicts per query",
    ["tenant_id", "action", "stage"],  # action: answer|refuse · stage: smalltalk|lexical|judge|judge_failed
)

HANDOFF_TOTAL = Counter(
    "ia_handoff_total",
    "Handoff offers triggered",
    ["tenant_id", "trigger"],  # trigger: insufficient|keyword
)

QUERY_DURATION = Histogram(
    "ia_query_duration_ms",
    "End-to-end query duration in milliseconds",
    ["tenant_id", "complexity"],
    buckets=[500, 1000, 2000, 4000, 8000, 15000, 30000],
)

ACTIVE_TENANTS = Gauge(
    "ia_active_tenants",
    "Number of tenants with at least one query in the last hour",
    multiprocess_mode="max",
)


def setup_metrics(app):
    """Attach Prometheus instrumentator to the FastAPI app.

    Si PROMETHEUS_MULTIPROC_DIR está seteado, `expose` arma un registry con
    MultiProcessCollector (agrega los 4 workers); si no, usa el default.
    """
    Instrumentator(
        should_group_status_codes=True,
        should_ignore_untemplated=True,
        excluded_handlers=["/health", "/metrics"],
    ).instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)


def celery_metrics_server(port: int = 9808) -> None:
    """Expone /metrics del worker de Celery (llamar UNA vez, en worker_init,
    antes del fork del pool). Con PROMETHEUS_MULTIPROC_DIR agrega los
    contadores de los procesos hijos (prefork); sin la variable solo vería el
    proceso principal, que no ejecuta tareas — por eso se exige."""
    from prometheus_client import CollectorRegistry, start_http_server
    from prometheus_client import multiprocess

    if not os.environ.get("PROMETHEUS_MULTIPROC_DIR"):
        return
    registry = CollectorRegistry()
    multiprocess.MultiProcessCollector(registry)
    start_http_server(port, registry=registry)
