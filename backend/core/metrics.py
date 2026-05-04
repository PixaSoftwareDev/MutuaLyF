"""Prometheus metrics: HTTP instrumentation + custom business counters.

Custom metrics exposed at /metrics:
  ia_queries_total          — queries by tenant and complexity
  ia_cache_hits_total       — Redis cache hits
  ia_ingest_total           — documents ingested by tenant
  ia_groq_requests_total    — Groq API calls by model and status
  ia_quality_gate_total     — quality gate results by status
  ia_pipeline_duration_ms   — ingest pipeline duration histogram
"""

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

QUERY_DURATION = Histogram(
    "ia_query_duration_ms",
    "End-to-end query duration in milliseconds",
    ["tenant_id", "complexity"],
    buckets=[500, 1000, 2000, 4000, 8000, 15000, 30000],
)

ACTIVE_TENANTS = Gauge(
    "ia_active_tenants",
    "Number of tenants with at least one query in the last hour",
)


def setup_metrics(app):
    """Attach Prometheus instrumentator to the FastAPI app."""
    Instrumentator(
        should_group_status_codes=True,
        should_ignore_untemplated=True,
        excluded_handlers=["/health", "/metrics"],
    ).instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)
