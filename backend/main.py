"""FastAPI application entry point."""

import uuid
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from fastapi.middleware.cors import CORSMiddleware

from core.config import settings
from core.logging_config import configure_logging
from core.database import connect_all, disconnect_all
from core.tenant import TenantMiddleware
from core.metrics import setup_metrics
from core.tracing import setup_tracing
from api.v1 import auth, query, ingest, intentions, tenants, widget_conversation, operator_panel, duplicates, audit_log, system_prompts, branding, export, attachments, channels
# ENTITIES_DISABLED: from api.v1 import entities

# ── Logging — must be first, before any other import that logs ─────────────────
configure_logging(settings.log_level, settings.is_production)
logger = structlog.get_logger(__name__)


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("startup_begin", environment=settings.environment)
    # setup_tracing se mueve a antes del app.add_middleware: FastAPI no permite
    # registrar middlewares despues de que la app empezo a recibir requests
    # (lifespan se ejecuta despues), y el FastAPIInstrumentor de OTEL agrega
    # un middleware bajo el capot.
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
        # ENTITIES_DISABLED: from services.nlu import _load_model as _warm_nlu
        logger.info("model_warmup_start")
        await asyncio.gather(
            loop.run_in_executor(None, _warm_embed),
            loop.run_in_executor(None, _load_reranker),
            # ENTITIES_DISABLED: loop.run_in_executor(None, _warm_nlu),
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

# OTEL setup ANTES de los add_middleware: FastAPIInstrumentor agrega un
# middleware propio bajo el capot y FastAPI lo rechaza si la app ya esta
# en marcha (lifespan). Antes esto vivia adentro del lifespan y tiraba
# "Cannot add middleware after an application has started".
setup_tracing(app)


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


# ── Errores de parámetros mal formados → 422 (no 500) ──────────────────────────
# Un UUID/fecha/número inválido en la URL hace que Postgres lance un "data exception"
# (SQLSTATE clase 22). Sin esto FastAPI lo devuelve como 500, ensuciando logs/alertas
# y tapando los 500 reales. Lo convertimos en 422; cualquier OTRO error de base de
# datos sigue siendo 500 (no enmascaramos bugs).
@app.exception_handler(DBAPIError)
async def _dbapi_error_handler(request: Request, exc: DBAPIError):
    orig = getattr(exc, "orig", None)
    sqlstate = getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)
    log = structlog.get_logger(__name__)
    if sqlstate and str(sqlstate).startswith("22"):
        log.info("invalid_param_format", path=str(request.url.path), sqlstate=str(sqlstate))
        return JSONResponse(status_code=422, content={"detail": "Parámetro con formato inválido."})
    log.error("db_error", path=str(request.url.path),
              sqlstate=(str(sqlstate) if sqlstate else None), error=str(exc))
    return JSONResponse(status_code=500, content={"detail": "Error interno del servidor."})


# ── Validación de datos (422) → mensaje único en español ───────────────────────
# Pydantic devuelve los errores como lista de objetos y EN INGLÉS ("field
# required", "value is not a valid email"). Si el front los muestra crudos, el
# usuario ve jerga/«[object Object]». Logueamos el detalle técnico para debug y
# le damos al usuario un único mensaje claro.
@app.exception_handler(RequestValidationError)
async def _validation_error_handler(request: Request, exc: RequestValidationError):
    structlog.get_logger(__name__).info(
        "request_validation_error", path=str(request.url.path), errors=exc.errors())
    return JSONResponse(
        status_code=422,
        content={"detail": "Revisá los datos enviados: hay un campo incompleto o con formato inválido."},
    )


# ── Red de seguridad: cualquier excepción no prevista → 500 amable ─────────────
# Sin esto, una excepción no capturada filtra stack trace / "Internal Server
# Error" en inglés al usuario. Se loguea completa (exc_info) para diagnóstico.
# Las HTTPException tienen su propio handler y NO pasan por acá (mantienen su detail).
@app.exception_handler(Exception)
async def _unhandled_error_handler(request: Request, exc: Exception):
    structlog.get_logger(__name__).error(
        "unhandled_exception", path=str(request.url.path), error=str(exc), exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"detail": "Ocurrió un error inesperado. Probá de nuevo en unos minutos."},
    )


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
app.include_router(attachments.router, prefix="/api/v1", tags=["attachments"])
app.include_router(duplicates.router, prefix="/api/v1", tags=["duplicates"])
app.include_router(audit_log.router, prefix="/api/v1", tags=["audit"])
app.include_router(system_prompts.router, prefix="/api/v1", tags=["system-prompts"])
# ENTITIES_DISABLED: app.include_router(entities.router, prefix="/api/v1", tags=["entities"])
app.include_router(branding.router, prefix="/api/v1", tags=["branding"])
app.include_router(export.router, prefix="/api/v1", tags=["export"])
app.include_router(channels.router, prefix="/api/v1", tags=["channels"])


# ── Static: tenant uploads (logos, favicons) ──────────────────────────────────
# Handler restrictivo en lugar de StaticFiles. Razones:
#   1. Anti path-traversal: validamos formato del path antes de tocar fs.
#   2. Solo extensiones whitelisted (logos/favicons) — si alguien crea otros
#      archivos en /uploads se ignoran.
#   3. Force Content-Disposition: inline + X-Content-Type-Options: nosniff
#      para que un archivo .png cuyo contenido sea HTML/JS no se ejecute.
import re as _re
from pathlib import Path as _Path
from fastapi import Path as _PathParam
from fastapi.responses import FileResponse, Response as _R
_uploads_dir = _Path("/uploads")
_uploads_dir.mkdir(parents=True, exist_ok=True)

_UPLOADS_FILENAME_RE = _re.compile(r"^(logo|favicon)-[a-f0-9]{4,16}\.(png|jpg|jpeg|svg|webp|ico)$")
_UPLOADS_TENANT_RE   = _re.compile(r"^[a-z0-9-]{1,50}$")
_UPLOADS_MIME = {
    "png":  "image/png", "jpg":  "image/jpeg", "jpeg": "image/jpeg",
    "svg":  "image/svg+xml", "webp": "image/webp", "ico":  "image/vnd.microsoft.icon",
}


@app.get("/uploads/{tenant_id}/{filename}", include_in_schema=False)
async def serve_upload(tenant_id: str = _PathParam(...), filename: str = _PathParam(...)) -> _R:
    if not _UPLOADS_TENANT_RE.match(tenant_id) or not _UPLOADS_FILENAME_RE.match(filename):
        return _R(status_code=404)
    path = _uploads_dir / tenant_id / filename
    try:
        # Ancla anti-traversal: el resolved path debe estar dentro de /uploads
        path.resolve().relative_to(_uploads_dir.resolve())
    except (ValueError, RuntimeError):
        return _R(status_code=404)
    if not path.is_file():
        return _R(status_code=404)
    ext = filename.rsplit(".", 1)[-1].lower()
    return FileResponse(
        path,
        media_type=_UPLOADS_MIME.get(ext, "application/octet-stream"),
        headers={
            "Cache-Control":          "public, max-age=604800, immutable",
            "Content-Disposition":    "inline",
            "X-Content-Type-Options": "nosniff",
        },
    )


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
    from core.database import get_pg_session, get_redis_cache, get_qdrant_client
    # ENTITIES_DISABLED: from core.database import get_neo4j_driver

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

    # ENTITIES_DISABLED: Neo4j health check desactivado
    # async def _check_neo4j() -> str: ...

    pg_res, redis_res, qdrant_res = await asyncio.gather(
        _check_pg(), _check_redis(), _check_qdrant(),
        return_exceptions=False,
    )
    checks["postgres"] = pg_res
    checks["redis"]    = redis_res
    checks["qdrant"]   = qdrant_res

    all_ok = all(v == "ok" for v in checks.values())
    response.status_code = 200 if all_ok else 503
    return {"status": "ok" if all_ok else "degraded", "checks": checks}
