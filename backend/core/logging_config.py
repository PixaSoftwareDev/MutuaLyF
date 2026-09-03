"""Centralized logging configuration.

Single entry point: call configure_logging() once at startup.

Dev:  colored key=value output with full tracebacks
Prod: JSON per line (stdout) — ingestable by Loki / CloudWatch / Datadog

Third-party loggers that are silenced to WARNING:
  - sqlalchemy.engine / pool / dialects  (per-query noise)
  - httpx / httpcore                     (every Groq/Qdrant call)
  - sentence_transformers / transformers (model loading chatter)
  - groq._base_client                    (internal retry noise)
  - uvicorn.access /health y /metrics    (healthcheck + scrape de Prometheus)

uvicorn y Celery se enrutan por el MISMO handler raíz (JSON en prod), así
Loki recibe todo con el mismo formato y etiquetas (level, request_id,
tenant_id). Ver bind_log_context().
"""

import logging
import sys
from typing import Any

import structlog


# Rutas que NO van al access log: el healthcheck de Docker cada 30 s y el
# scrape de Prometheus cada 15 s eran 11.000 líneas cada dos días, el 99% del
# log del backend (auditoría 2026-09-03).
_ACCESS_LOG_SILENCED = ("GET /health", "GET /metrics")


class _AccessLogFilter(logging.Filter):
    """Drop access log lines of health checks and metrics scrapes."""

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return not any(path in msg for path in _ACCESS_LOG_SILENCED)


_HealthCheckFilter = _AccessLogFilter  # nombre histórico


def bind_log_context(**fields: Any) -> None:
    """Agrega campos al contexto de structlog del hilo/tarea actual (request o
    tarea Celery): toda línea posterior los lleva. Ignora valores None."""
    structlog.contextvars.bind_contextvars(**{k: v for k, v in fields.items() if v is not None})


def clear_log_context() -> None:
    structlog.contextvars.clear_contextvars()


def configure_logging(log_level: str, is_production: bool) -> None:
    level = getattr(logging, log_level.upper(), logging.INFO)

    # Processors shared by structlog native loggers AND stdlib-intercepted loggers
    shared_processors: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.ExceptionRenderer(),
    ]

    renderer: Any = (
        structlog.processors.JSONRenderer()
        if is_production
        else structlog.dev.ConsoleRenderer(colors=True)
    )

    # Route structlog through stdlib so there is ONE handler chain
    structlog.configure(
        processors=shared_processors
        + [structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.make_filtering_bound_logger(level),
        cache_logger_on_first_use=True,
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        processor=renderer,
        foreign_pre_chain=shared_processors,
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)

    # ── Silence third-party noise ──────────────────────────────────────────────
    # propagate=False prevents records from reaching root (and any stale handler
    # uvicorn may have added before our configure_logging ran).
    _noisy = [
        "sqlalchemy.engine",
        "sqlalchemy.engine.Engine",
        "sqlalchemy.pool",
        "sqlalchemy.dialects",
        "httpx",
        "httpcore",
        "sentence_transformers",
        "sentence_transformers.SentenceTransformer",
        "transformers",
        "torch",
        "groq._base_client",
    ]
    for name in _noisy:
        lg = logging.getLogger(name)
        lg.setLevel(logging.WARNING)
        lg.propagate = False  # stop records from surfacing to any stale root handler

    # ── uvicorn: TODO por el handler raíz (JSON en prod) ──────────────────────
    # uvicorn instala sus propios handlers de texto plano en "uvicorn",
    # "uvicorn.error" y "uvicorn.access" con propagate=False: hasta 2026-09-03
    # el 99,7% del log del backend salía en texto plano y Promtail lo
    # descartaba. Se le quitan los handlers y se propaga al raíz.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers.clear()
        lg.propagate = True

    # Drop /health y /metrics del access log (healthcheck + scrape)
    logging.getLogger("uvicorn.access").addFilter(_AccessLogFilter())
