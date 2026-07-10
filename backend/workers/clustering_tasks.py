"""Celery tasks for nightly HDBSCAN intent clustering.

Runs for ALL tenants once per night via Celery Beat.
Each tenant gets its own sub-task so one failure doesn't block others.

Schedule: daily at 02:00 UTC (configured in celery_app.py beat_schedule).
"""

import asyncio
import logging

from workers.celery_app import app

logger = logging.getLogger(__name__)


@app.task(
    name="workers.clustering_tasks.run_hdbscan_clustering",
    queue="clustering",
    max_retries=1,
    soft_time_limit=1800,  # 30 min max for entire run
)
def run_hdbscan_clustering() -> dict:
    """Nightly orchestrator: runs clustering for every active tenant."""
    logger.info("clustering_nightly_start")
    return asyncio.run(_run_all_tenants())


async def _run_all_tenants() -> dict:
    from core.database import get_worker_pg_session
    from sqlalchemy import text
    from services.clustering import cluster_tenant

    # Fetch all active tenants from the global table
    async with get_worker_pg_session(None) as session:
        result = await session.execute(
            text("SELECT id FROM tenants WHERE status = 'active'")
        )
        tenant_ids = [row[0] for row in result.fetchall()]

    logger.info("clustering_tenants_found count=%d", len(tenant_ids))

    results = []
    for tenant_id in tenant_ids:
        try:
            summary = await cluster_tenant(tenant_id)
            results.append(summary)
            _emit_metrics(summary)
        except Exception as exc:
            logger.error("clustering_tenant_error tenant_id=%s error=%s", tenant_id, exc)
            results.append({"tenant_id": tenant_id, "error": str(exc)})

    total_candidates = sum(r.get("candidates_surfaced", 0) for r in results)
    total_dismissed = sum(r.get("dismissed", 0) for r in results)
    logger.info(
        "clustering_nightly_complete tenants=%d candidates=%d dismissed=%d",
        len(tenant_ids), total_candidates, total_dismissed,
    )
    return {
        "tenants_processed": len(tenant_ids),
        "total_candidates_surfaced": total_candidates,
        "total_dismissed": total_dismissed,
        "results": results,
    }


@app.task(
    name="workers.clustering_tasks.cluster_single_tenant",
    queue="clustering",
    max_retries=0,
)
def cluster_single_tenant(tenant_id: str) -> dict:
    """On-demand clustering for a single tenant (triggered from admin panel)."""
    logger.info("clustering_single_start tenant_id=%s", tenant_id)
    from services.clustering import cluster_tenant
    result = asyncio.run(cluster_tenant(tenant_id))
    _emit_metrics(result)
    return result


@app.task(
    name="workers.clustering_tasks.promote_clusters",
    queue="clustering",
    max_retries=0,
    soft_time_limit=900,
)
def promote_clusters(tenant_id: str) -> dict:
    """Auto-promoción de clusters candidatos existentes SIN re-clusterizar.

    Útil para promover candidatos ya detectados (on-demand desde el panel o tras
    ajustar el umbral) sin pagar el costo de re-embeber todo el corpus.
    force=True: es un disparo manual del admin — corre aunque la promoción
    automática esté deshabilitada (modo sugerencia).
    """
    logger.info("promote_clusters_start tenant_id=%s", tenant_id)
    from services.intent_promotion import promote_candidate_clusters
    return asyncio.run(promote_candidate_clusters(tenant_id, force=True))


@app.task(
    name="workers.clustering_tasks.promote_all_tenants",
    queue="clustering",
    max_retries=0,
    soft_time_limit=1800,
)
def promote_all_tenants() -> dict:
    """Auto-promoción para todos los tenants activos (respaldo del paso nocturno)."""
    return asyncio.run(_promote_all())


async def _promote_all() -> dict:
    from core.database import get_worker_pg_session
    from sqlalchemy import text
    from services.intent_promotion import promote_candidate_clusters

    async with get_worker_pg_session(None) as session:
        result = await session.execute(text("SELECT id FROM tenants WHERE status = 'active'"))
        tenant_ids = [row[0] for row in result.fetchall()]

    results = []
    for tid in tenant_ids:
        try:
            results.append(await promote_candidate_clusters(tid))
        except Exception as exc:
            logger.error("promote_all_tenant_error tenant_id=%s error=%s", tid, exc)
            results.append({"tenant_id": tid, "error": str(exc)})
    total = sum(r.get("promoted", 0) for r in results)
    logger.info("promote_all_done tenants=%d promoted=%d", len(tenant_ids), total)
    return {"tenants_processed": len(tenant_ids), "total_promoted": total, "results": results}


def _emit_metrics(summary: dict) -> None:
    """Emit Prometheus counters for clustering results."""
    try:
        tenant_id = summary.get("tenant_id", "unknown")
        if summary.get("candidates_surfaced", 0) > 0:
            logger.info(
                "clustering_metric tenant_id=%s candidates=%d dismissed=%d",
                tenant_id,
                summary.get("candidates_surfaced", 0),
                summary.get("dismissed", 0),
            )
    except Exception:
        pass
