"""Centralized logging configuration.

Single entry point: call configure_logging() once at startup.

Dev:  colored key=value output with full tracebacks
Prod: JSON per line (stdout) — ingestable by Loki / CloudWatch / Datadog

Third-party loggers that are silenced to WARNING:
  - sqlalchemy.engine / pool / dialects  (per-query noise)
  - httpx / httpcore                     (every Groq/Qdrant call)
  - sentence_transformers / transformers (model loading chatter)
  - groq._base_client                    (internal retry noise)
  - uvicorn.access /health               (Docker healthcheck spam)
"""

import logging
import sys
import uuid
from typing import Any

import structlog


class _HealthCheckFilter(logging.Filter):
    """Drop GET /health access log lines — Docker pings every 30s."""

    def filter(self, record: logging.LogRecord) -> bool:
        return "GET /health" not in record.getMessage()


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

    # Drop /health from access logs (Docker healthcheck every 30s)
    logging.getLogger("uvicorn.access").addFilter(_HealthCheckFilter())
