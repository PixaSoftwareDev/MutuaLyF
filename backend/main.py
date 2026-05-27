"""FastAPI application entry point."""

import uuid
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request, Response
from sqlalchemy import text
from fastapi.middleware.cors import CORSMiddleware

from core.config import settings
from core.logging_config import configure_logging
from core.database import connect_all, disconnect_all
from core.tenant import TenantMiddleware
from core.metrics import setup_metrics
from core.tracing import setup_tracing
from api.v1 import auth, query, ingest, intentions, tenants, widget_conversation, operator_panel, duplicates, audit_log, system_prompts, entities, branding, export

# ── Logging — must be first, before any other import that logs ─────────────────
configure_logging(settings.log_level, settings.is_production)
logger = structlog.get_logger(__name__)


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("startup_begin", environment=settings.environment)
    setup_tracing(app)
    await connect_all()

    # Default ThreadPoolExecutor en Python es min(32, cpu+4)=10 threads.
    # Bajo carga concurrente el RAG necesita threads para: embed(local o
    # HTTP-sync OpenAI), NLU GLiNER (CPU), reranker (CPU), Redis cache.
    # 10 threads se saturan con ~3-4 queries paralelas, encolando todo lo demás.
    # Subir a 64 destraba el cuello sin costo significativo (threads idle son
    # baratos en Python).
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    loop = asyncio.get_running_loop()
    loop.set_default_executor(ThreadPoolExecutor(max_workers=64, thread_name_prefix="bg"))
    logger.info("executor_configured", max_workers=64)
    try:
        from services.embeddings import _load_model as _warm_embed
        from services.retrieval import _load_reranker
        from services.nlu import _load_model as _warm_nlu
        logger.info("model_warmup_start")
        await asyncio.gather(
            loop.run_in_executor(None, _warm_embed),
            loop.run_in_executor(None, _load_reranker),
            loop.run_in_executor(None, _warm_nlu),
        )
        logger.info("model_warmup_complete")
    except Exception as exc:
        logger.warning("model_warmup_failed", error=str(exc))

    logger.info("startup_complete")
    yield
    logger.info("shutdown_begin")
    await disconnect_all()
    logger.info("shutdown_complete")


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="IA Inteligent Platform",
    version="1.0.0",
    docs_url="/docs" if not settings.is_production else None,
    redoc_url="/redoc" if not settings.is_production else None,
    lifespan=lifespan,
)


# ── Request-ID middleware ──────────────────────────────────────────────────────
# Binds a unique request_id to structlog contextvars so every log line
# emitted during a request includes it automatically.

@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(request_id=request_id)
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response


# ── CORS ──────────────────────────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(TenantMiddleware)

# ── Prometheus metrics ────────────────────────────────────────────────────────
setup_metrics(app)

# ── Routers ───────────────────────────────────────────────────────────────────

app.include_router(auth.router, prefix="/api/v1/auth", tags=["auth"])
app.include_router(query.router, prefix="/api/v1", tags=["query"])
app.include_router(ingest.router, prefix="/api/v1", tags=["ingest"])
app.include_router(intentions.router, prefix="/api/v1", tags=["intentions"])
app.include_router(tenants.router, prefix="/api/v1/tenants", tags=["tenants"])
app.include_router(widget_conversation.router, prefix="/api/v1", tags=["widget-chat"])
app.include_router(operator_panel.router, prefix="/api/v1", tags=["operator-panel"])
app.include_router(duplicates.router, prefix="/api/v1", tags=["duplicates"])
app.include_router(audit_log.router, prefix="/api/v1", tags=["audit"])
app.include_router(system_prompts.router, prefix="/api/v1", tags=["system-prompts"])
app.include_router(entities.router, prefix="/api/v1", tags=["entities"])
app.include_router(branding.router, prefix="/api/v1", tags=["branding"])
app.include_router(export.router, prefix="/api/v1", tags=["export"])


# ── Static: tenant uploads (logos, favicons) ──────────────────────────────────
# Mounted under /uploads so the frontend can reference them via the API origin.
from pathlib import Path as _Path
from fastapi.staticfiles import StaticFiles
_uploads_dir = _Path("/uploads")
_uploads_dir.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(_uploads_dir)), name="uploads")


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health", tags=["health"])
async def health() -> dict:
    """Liveness probe basico. NO chequea dependencias — uso para Docker
    healthcheck rapido (cada 30s). Si necesitas saber si el backend puede
    realmente atender requests, usa /health/ready."""
    return {"status": "ok", "environment": settings.environment}


@app.get("/health/ready", tags=["health"])
async def health_ready(response: Response) -> dict:
    """Readiness probe: chequea que las dependencias criticas respondan.
    Devuelve 503 si alguna esta caida — Docker/Kubernetes pueden usar este
    endpoint para sacar el container del load balancer sin matarlo.

    Cada check con timeout de 2s para que el endpoint nunca tarde >10s en
    total (5 deps x 2s peor caso). En la practica suele tomar <100ms si
    todas responden.
    """
    import asyncio
    from core.database import get_pg_session, get_redis_cache, get_qdrant_client, get_neo4j_driver

    checks: dict[str, str] = {}

    async def _check_pg() -> str:
        try:
            async with get_pg_session() as session:
                await asyncio.wait_for(session.execute(text("SELECT 1")), timeout=2.0)
            return "ok"
        except Exception as exc:
            return f"fail: {type(exc).__name__}: {str(exc)[:80]}"

    async def _check_redis() -> str:
        try:
            redis = get_redis_cache()
            await asyncio.wait_for(redis.ping(), timeout=2.0)
            return "ok"
        except Exception as exc:
            return f"fail: {type(exc).__name__}: {str(exc)[:80]}"

    async def _check_qdrant() -> str:
        try:
            client = get_qdrant_client()
            await asyncio.wait_for(client.get_collections(), timeout=2.0)
            return "ok"
        except Exception as exc:
            return f"fail: {type(exc).__name__}: {str(exc)[:80]}"

    async def _check_neo4j() -> str:
        try:
            driver = get_neo4j_driver()
            async with driver.session() as session:
                await asyncio.wait_for(session.run("RETURN 1"), timeout=2.0)
            return "ok"
        except Exception as exc:
            return f"fail: {type(exc).__name__}: {str(exc)[:80]}"

    pg_res, redis_res, qdrant_res, neo4j_res = await asyncio.gather(
        _check_pg(), _check_redis(), _check_qdrant(), _check_neo4j(),
        return_exceptions=False,
    )
    checks["postgres"] = pg_res
    checks["redis"]    = redis_res
    checks["qdrant"]   = qdrant_res
    checks["neo4j"]    = neo4j_res

    all_ok = all(v == "ok" for v in checks.values())
    response.status_code = 200 if all_ok else 503
    return {"status": "ok" if all_ok else "degraded", "checks": checks}
