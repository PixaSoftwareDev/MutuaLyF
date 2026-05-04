"""Celery tasks for intent classifier retraining with versioning and rollback.

Triggered:
  - After approving a pending intention cluster (from intentions panel)
  - After HDBSCAN surfaces new candidates and they are approved
  - Manually from admin panel

Per-tenant: each tenant has its own Qdrant collection and version history.
"""

import asyncio
import logging

from workers.celery_app import app

logger = logging.getLogger(__name__)


@app.task(
    name="workers.training_tasks.retrain_intent_classifier",
    queue="training",
    max_retries=2,
    soft_time_limit=600,  # 10 min max
)
def retrain_intent_classifier(tenant_id: str) -> dict:
    """Retrain the intent classifier for one tenant.

    Adds pending approved examples to Qdrant, evaluates accuracy,
    and rolls back automatically if accuracy drops more than 5%.
    """
    logger.info("training_task_start tenant_id=%s", tenant_id)
    result = asyncio.run(_run_retrain(tenant_id))
    logger.info(
        "training_task_done tenant_id=%s committed=%s rolled_back=%s "
        "baseline=%.3f new=%.3f added=%d reason=%s",
        tenant_id,
        result.committed,
        result.rolled_back,
        result.baseline_accuracy,
        result.new_accuracy,
        result.examples_added,
        result.reason,
    )
    return result._asdict()


@app.task(
    name="workers.training_tasks.retrain_all_tenants",
    queue="training",
    max_retries=1,
    soft_time_limit=3600,
)
def retrain_all_tenants() -> dict:
    """Retrain all active tenants — called after nightly clustering."""
    return asyncio.run(_run_all())


async def _run_retrain(tenant_id: str):
    from services.classifier_trainer import retrain_tenant
    return await retrain_tenant(tenant_id)


async def _run_all() -> dict:
    from core.database import get_worker_pg_session
    from sqlalchemy import text
    from services.classifier_trainer import retrain_tenant

    async with get_worker_pg_session(None) as session:
        result = await session.execute(
            text("SELECT id FROM tenants WHERE status = 'active'")
        )
        tenant_ids = [row[0] for row in result.fetchall()]

    results = []
    for tenant_id in tenant_ids:
        try:
            r = await retrain_tenant(tenant_id)
            results.append(r._asdict())
        except Exception as exc:
            logger.error("retrain_all_tenant_error tenant_id=%s error=%s", tenant_id, exc)
            results.append({"tenant_id": tenant_id, "error": str(exc)})

    committed = sum(1 for r in results if r.get("committed"))
    rolled_back = sum(1 for r in results if r.get("rolled_back"))
    logger.info("retrain_all_done tenants=%d committed=%d rolled_back=%d", len(results), committed, rolled_back)
    return {"tenants": len(results), "committed": committed, "rolled_back": rolled_back, "results": results}
