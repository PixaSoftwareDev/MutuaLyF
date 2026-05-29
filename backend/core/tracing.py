"""OpenTelemetry distributed tracing setup.

Exports traces to Jaeger via OTLP/gRPC (port 4317).
Auto-instruments FastAPI routes, SQLAlchemy queries and httpx calls.

Spans added manually in critical paths:
  - orchestrator.handle_query  → span per step (cache, embed, qdrant, rerank, llm)
  - ingest pipeline            → span per stage (extract, chunk, embed, quality, neo4j, qdrant)

Disabled when OTEL_ENABLED=false (default in dev to avoid Jaeger dependency).
"""

import logging
import os

logger = logging.getLogger(__name__)

_tracer = None


def setup_tracing(app=None) -> None:
    """Initialize OpenTelemetry. No-op if OTEL_ENABLED is not 'true'."""
    if os.getenv("OTEL_ENABLED", "false").lower() != "true":
        logger.info("tracing_disabled set OTEL_ENABLED=true to enable")
        return

    try:
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

        service_name = os.getenv("OTEL_SERVICE_NAME", "ia-platform-backend")
        otlp_endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://jaeger:4317")
        sample_ratio = float(os.getenv("OTEL_SAMPLE_RATIO", "0.1"))  # 10% por default
        sample_ratio = max(0.0, min(1.0, sample_ratio))

        # Sampling: full sampling agrega ~10-15ms por request al RAG. Con 10% el
        # overhead amortizado es ~1-2ms y seguimos teniendo visibilidad de cola
        # larga (cualquier query >2s genera suficiente volumen para ser muestreada).
        # ParentBased respeta el sampling decision del request si ya viene con
        # trace context — clave para no romper trazas distribuidas que el
        # gateway/cliente ya inicio con sampling propio.
        sampler = ParentBased(root=TraceIdRatioBased(sample_ratio))

        resource = Resource.create({"service.name": service_name})
        provider = TracerProvider(resource=resource, sampler=sampler)
        exporter = OTLPSpanExporter(endpoint=otlp_endpoint, insecure=True)
        provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)

        global _tracer
        _tracer = trace.get_tracer(service_name)

        # Auto-instrument HTTP client and SQLAlchemy
        HTTPXClientInstrumentor().instrument()
        SQLAlchemyInstrumentor().instrument()

        # Auto-instrument FastAPI if app is provided
        if app is not None:
            FastAPIInstrumentor.instrument_app(app)

        logger.info(
            "tracing_enabled service=%s endpoint=%s sample_ratio=%.2f",
            service_name, otlp_endpoint, sample_ratio,
        )

    except ImportError as exc:
        logger.warning("tracing_import_failed error=%s — install opentelemetry packages", exc)
    except Exception as exc:
        logger.warning("tracing_setup_failed error=%s — tracing disabled", exc)


def get_tracer():
    """Return the tracer. Returns a no-op tracer if tracing is disabled."""
    if _tracer is not None:
        return _tracer
    try:
        from opentelemetry import trace
        return trace.get_tracer("ia-platform-noop")
    except Exception:
        return _NoopTracer()


class _NoopTracer:
    """Minimal no-op tracer so callers don't need to check if tracing is enabled."""
    def start_as_current_span(self, name, **kwargs):
        from contextlib import contextmanager
        @contextmanager
        def _noop():
            yield _NoopSpan()
        return _noop()

    def start_span(self, name, **kwargs):
        return _NoopSpan()


class _NoopSpan:
    def set_attribute(self, *a, **kw): pass
    def add_event(self, *a, **kw): pass
    def record_exception(self, *a, **kw): pass
    def set_status(self, *a, **kw): pass
    def end(self): pass
    def __enter__(self): return self
    def __exit__(self, *a): pass
