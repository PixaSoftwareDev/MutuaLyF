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
