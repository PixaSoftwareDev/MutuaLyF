"""Tareas de mantenimiento de calidad de datos.

Por ahora: detección de contradicciones de campos (direcciones/teléfonos en
conflicto en el corpus). Corre de noche y tras cada ingesta.
"""

import asyncio
import logging

from workers.celery_app import app

logger = logging.getLogger(__name__)


@app.task(
    name="workers.maintenance_tasks.detect_contradictions_task",
    bind=True,
    max_retries=2,
    default_retry_delay=60,
)
def detect_contradictions_task(self, tenant_id: str) -> dict:
    """Detecta contradicciones de campos para un tenant y cachea los hechos canónicos."""
    try:
        from services.contradiction_detector import detect_contradictions
        result = asyncio.run(detect_contradictions(tenant_id))
        logger.info(
            "contradictions_done tenant=%s scanned=%d contradictions=%d facts=%d",
            tenant_id, result.get("scanned", 0),
            len(result.get("contradictions", [])), len(result.get("canonical_facts", {})),
        )
        return {
            "tenant_id": tenant_id,
            "scanned": result.get("scanned", 0),
            "contradictions": len(result.get("contradictions", [])),
            "canonical_facts": len(result.get("canonical_facts", {})),
        }
    except Exception as exc:
        logger.error("contradictions_failed tenant=%s error=%s", tenant_id, exc)
        raise self.retry(exc=exc)


@app.task(name="workers.maintenance_tasks.detect_contradictions_all_tenants")
def detect_contradictions_all_tenants() -> dict:
    """Corre la detección para todos los tenants activos (paso nocturno)."""
    return asyncio.run(_detect_all())


async def _detect_all() -> dict:
    from core.database import get_worker_pg_session
    from services.contradiction_detector import detect_contradictions
    from sqlalchemy import text

    async with get_worker_pg_session(None) as session:
        result = await session.execute(text("SELECT id FROM tenants WHERE status = 'active'"))
        tenant_ids = [row[0] for row in result.fetchall()]

    total = 0
    for tid in tenant_ids:
        try:
            r = await detect_contradictions(tid)
            total += len(r.get("contradictions", []))
        except Exception as exc:
            logger.error("detect_all_tenant_error tenant_id=%s error=%s", tid, exc)
    logger.info("detect_all_done tenants=%d contradictions=%d", len(tenant_ids), total)
    return {"tenants_processed": len(tenant_ids), "total_contradictions": total}


@app.task(
    name="workers.maintenance_tasks.data_consistency_all_tenants",
    soft_time_limit=3600,
)
def data_consistency_all_tenants() -> dict:
    """Consistencia nocturna: purga puntos huérfanos del cache semántico
    (el Redis pareado tiene TTL 1h; sin esta purga el punto en Qdrant queda
    para siempre y el cache semántico devuelve entradas sin respaldo)."""
    return asyncio.run(_consistency_all())


_QUERY_CACHE_MAX_AGE_S = 7 * 24 * 3600  # puntos del cache semántico > 7 días = huérfanos


async def _purge_stale_query_cache(tenant_id: str) -> int:
    """Borra puntos del cache semántico cuyo Redis (TTL 1h) expiró hace días."""
    import time

    from core.database import get_worker_qdrant_client
    from qdrant_client.models import FieldCondition, Filter, FilterSelector, Range

    collection = f"{tenant_id}_query_cache"
    cutoff = int(time.time()) - _QUERY_CACHE_MAX_AGE_S
    try:
        async with get_worker_qdrant_client() as qdrant:
            info = await qdrant.get_collection(collection)
            before = info.points_count or 0
            await qdrant.delete(
                collection_name=collection,
                points_selector=FilterSelector(filter=Filter(must=[
                    FieldCondition(key="cached_at", range=Range(lt=cutoff)),
                ])),
            )
            info = await qdrant.get_collection(collection)
            purged = before - (info.points_count or 0)
            if purged:
                logger.info("query_cache_purged tenant=%s points=%d", tenant_id, purged)
            return purged
    except Exception as exc:
        # Colección puede no existir todavía — no es un error.
        logger.debug("query_cache_purge_skipped tenant=%s error=%s", tenant_id, exc)
        return 0


async def _consistency_all() -> dict:
    from core.database import get_worker_pg_session
    from sqlalchemy import text

    async with get_worker_pg_session(None) as session:
        result = await session.execute(text("SELECT id FROM tenants WHERE status = 'active'"))
        tenant_ids = [row[0] for row in result.fetchall()]

    summary = {"tenants": len(tenant_ids), "cache_purged": 0}
    for tid in tenant_ids:
        try:
            summary["cache_purged"] += await _purge_stale_query_cache(tid)
        except Exception as exc:
            logger.error("consistency_tenant_error tenant_id=%s error=%s", tid, exc)
    logger.info("consistency_all_done %s", summary)
    return summary
