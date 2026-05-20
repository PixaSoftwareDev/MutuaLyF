"""Async database connections: PostgreSQL, Neo4j, Qdrant, Redis."""

import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import redis.asyncio as aioredis
from neo4j import AsyncGraphDatabase, AsyncDriver
from qdrant_client import AsyncQdrantClient
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool
from sqlalchemy import text

from core.config import settings

logger = logging.getLogger(__name__)

# ── PostgreSQL ─────────────────────────────────────────────────────────────────

_pg_engine: AsyncEngine | None = None
_pg_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_pg_engine() -> AsyncEngine:
    global _pg_engine
    if _pg_engine is None:
        _pg_engine = create_async_engine(
            settings.postgres_dsn,
            # Bumped from 10/20 -> 30/50 (max 80 connections). Cada query del
            # widget abre 2-3 sesiones (search_path SET, leer datos, log async).
            # Con 15 concurrent users el viejo cap de 30 (10+20) se saturaba
            # y los logs de query/usage_event empezaban a fallar en cascada.
            pool_size=30,
            max_overflow=50,
            pool_pre_ping=True,
            pool_timeout=settings.db_timeout_ms / 1000,
            echo=False,
            # Disable asyncpg prepared-statement cache so that search_path changes
            # between tenant sessions don't cause table-not-found errors on cached statements.
            connect_args={"prepared_statement_cache_size": 0},
        )
    return _pg_engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _pg_session_factory
    if _pg_session_factory is None:
        _pg_session_factory = async_sessionmaker(
            bind=get_pg_engine(),
            class_=AsyncSession,
            expire_on_commit=False,
            autoflush=False,
        )
    return _pg_session_factory


@asynccontextmanager
async def get_pg_session(tenant_id: str | None = None) -> AsyncGenerator[AsyncSession, None]:
    """Yield an AsyncSession. If tenant_id provided, sets search_path for tenant isolation.

    Resets search_path to public in finally so the pooled connection doesn't leak
    tenant-specific schema state to the next session that reuses it.
    """
    # __platform__ is the super-admin sentinel — treat as global (no search_path override)
    if tenant_id == "__platform__":
        tenant_id = None

    factory = get_session_factory()
    async with factory() as session:
        # Always start with a clean public schema to avoid stale search_path from the pool
        await session.execute(text("SET search_path TO public"))
        if tenant_id:
            # Sanitize tenant_id before using in SQL — only alphanumeric and underscores allowed
            safe_id = _validate_tenant_id(tenant_id)
            await session.execute(text(f"SET search_path TO tenant_{safe_id}, public"))
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            if tenant_id:
                try:
                    await session.execute(text("SET search_path TO public"))
                    await session.commit()
                except Exception:
                    pass


@asynccontextmanager
async def get_worker_pg_session(tenant_id: str | None = None) -> AsyncGenerator[AsyncSession, None]:
    """Session for Celery workers: uses NullPool to avoid fork/event-loop conflicts.

    Never reuses connections across asyncio.run() calls, so it's safe after fork.
    """
    engine = create_async_engine(
        settings.postgres_dsn,
        poolclass=NullPool,
        echo=False,
    )
    factory = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False, autoflush=False)
    async with factory() as session:
        if tenant_id:
            safe_id = _validate_tenant_id(tenant_id)
            await session.execute(text(f"SET search_path TO tenant_{safe_id}, public"))
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await engine.dispose()


def _validate_tenant_id(tenant_id: str) -> str:
    """Ensure tenant_id contains only safe characters before schema interpolation."""
    if not tenant_id.replace("_", "").replace("-", "").isalnum():
        raise ValueError(f"Invalid tenant_id format: {tenant_id!r}")
    # Normalize dashes to underscores for schema name compatibility
    return tenant_id.replace("-", "_")


async def close_pg_engine() -> None:
    global _pg_engine
    if _pg_engine:
        await _pg_engine.dispose()
        _pg_engine = None
        logger.info("PostgreSQL engine closed")


# ── Neo4j ─────────────────────────────────────────────────────────────────────

_neo4j_driver: AsyncDriver | None = None


def get_neo4j_driver() -> AsyncDriver:
    global _neo4j_driver
    if _neo4j_driver is None:
        _neo4j_driver = AsyncGraphDatabase.driver(
            settings.neo4j_uri,
            auth=(settings.neo4j_user, settings.neo4j_password),
            max_connection_lifetime=3600,
            max_connection_pool_size=50,
            connection_acquisition_timeout=settings.neo4j_timeout_ms / 1000,
        )
    return _neo4j_driver


async def close_neo4j_driver() -> None:
    global _neo4j_driver
    if _neo4j_driver:
        await _neo4j_driver.close()
        _neo4j_driver = None
        logger.info("Neo4j driver closed")


# ── Qdrant ────────────────────────────────────────────────────────────────────

_qdrant_client: AsyncQdrantClient | None = None


def get_qdrant_client() -> AsyncQdrantClient:
    global _qdrant_client
    if _qdrant_client is None:
        _qdrant_client = AsyncQdrantClient(
            host=settings.qdrant_host,
            port=settings.qdrant_port,
            timeout=settings.db_timeout_ms / 1000,
        )
    return _qdrant_client


async def close_qdrant_client() -> None:
    global _qdrant_client
    if _qdrant_client:
        await _qdrant_client.close()
        _qdrant_client = None
        logger.info("Qdrant client closed")


# ── Redis ─────────────────────────────────────────────────────────────────────

_redis_cache: aioredis.Redis | None = None
_redis_ratelimit: aioredis.Redis | None = None


def get_redis_cache() -> aioredis.Redis:
    global _redis_cache
    if _redis_cache is None:
        # connect_timeout stays tight (local network); read timeout must absorb
        # event loop contention under load (200%+ CPU on backend).
        _redis_cache = aioredis.from_url(
            settings.redis_url_cache,
            decode_responses=True,
            socket_timeout=settings.redis_timeout_ms / 1000,
            socket_connect_timeout=0.1,
            max_connections=50,
        )
    return _redis_cache


def get_redis_ratelimit() -> aioredis.Redis:
    global _redis_ratelimit
    if _redis_ratelimit is None:
        _redis_ratelimit = aioredis.from_url(
            settings.redis_url_ratelimit,
            decode_responses=True,
            socket_timeout=settings.redis_timeout_ms / 1000,
            socket_connect_timeout=0.1,
            max_connections=50,
        )
    return _redis_ratelimit


def new_redis_pubsub_connection() -> aioredis.Redis:
    """Create a NEW dedicated Redis connection for pubsub.

    PubSub holds blocking subscriptions — must NOT share the connection pool.
    Caller is responsible for closing the connection (e.g. SSE subscribers
    should `await conn.aclose()` on disconnect). Uses the same socket timeouts
    as the shared cache client for consistency under load.
    """
    return aioredis.from_url(
        settings.redis_url_cache,
        decode_responses=True,
        socket_timeout=settings.redis_timeout_ms / 1000,
        socket_connect_timeout=0.1,
    )


async def close_redis_connections() -> None:
    global _redis_cache, _redis_ratelimit
    if _redis_cache:
        await _redis_cache.aclose()
        _redis_cache = None
    if _redis_ratelimit:
        await _redis_ratelimit.aclose()
        _redis_ratelimit = None
    logger.info("Redis connections closed")


# ── Startup / shutdown helpers ────────────────────────────────────────────────

async def connect_all() -> None:
    """Initialize all database connections at application startup."""
    get_pg_engine()
    get_neo4j_driver()
    get_qdrant_client()
    get_redis_cache()
    get_redis_ratelimit()
    logger.info("All database connections initialized")


async def disconnect_all() -> None:
    """Close all database connections at application shutdown."""
    await close_pg_engine()
    await close_neo4j_driver()
    await close_qdrant_client()
    await close_redis_connections()
    logger.info("All database connections closed")


# ── Worker-safe context managers ───────────────────────────────────────────────
#
# Celery workers call asyncio.run() once per task. Each call creates a new event
# loop and destroys it when done. Async clients that hold httpx / socket state
# (AsyncQdrantClient, AsyncDriver) cannot be reused across different event loops
# — their internal transports are bound to the loop they were created in.
#
# Rule: the API server (FastAPI) uses the module-level singletons above because
# it has a single long-lived event loop. Worker tasks must use these context
# managers to get a fresh client that is created and closed within the same loop.

@asynccontextmanager
async def get_worker_qdrant_client() -> AsyncGenerator[AsyncQdrantClient, None]:
    client = AsyncQdrantClient(
        host=settings.qdrant_host,
        port=settings.qdrant_port,
        timeout=settings.db_timeout_ms / 1000,
    )
    try:
        yield client
    finally:
        await client.close()


@asynccontextmanager
async def get_worker_neo4j_driver() -> AsyncGenerator[AsyncDriver, None]:
    driver = AsyncGraphDatabase.driver(
        settings.neo4j_uri,
        auth=(settings.neo4j_user, settings.neo4j_password),
        connection_acquisition_timeout=settings.neo4j_timeout_ms / 1000,
    )
    try:
        yield driver
    finally:
        await driver.close()
