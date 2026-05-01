"""FastAPI application entry point."""

import uuid
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from core.config import settings
from core.logging_config import configure_logging
from core.database import connect_all, disconnect_all
from core.tenant import TenantMiddleware
from api.v1 import auth, query, ingest, intentions, tenants

# ── Logging — must be first, before any other import that logs ─────────────────
configure_logging(settings.log_level, settings.is_production)
logger = structlog.get_logger(__name__)


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("startup_begin", environment=settings.environment)
    await connect_all()
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

# ── Routers ───────────────────────────────────────────────────────────────────

app.include_router(auth.router, prefix="/api/v1/auth", tags=["auth"])
app.include_router(query.router, prefix="/api/v1", tags=["query"])
app.include_router(ingest.router, prefix="/api/v1", tags=["ingest"])
app.include_router(intentions.router, prefix="/api/v1", tags=["intentions"])
app.include_router(tenants.router, prefix="/api/v1/tenants", tags=["tenants"])


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health", tags=["health"])
async def health() -> dict:
    return {"status": "ok", "environment": settings.environment}
