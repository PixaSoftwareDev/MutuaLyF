"""Celery tasks for nightly HDBSCAN intent clustering."""

import logging
from workers.celery_app import app

logger = logging.getLogger(__name__)


@app.task(name="workers.clustering_tasks.run_hdbscan_clustering", queue="clustering")
def run_hdbscan_clustering() -> None:
    """Nightly job: cluster unclassified queries using HDBSCAN.

    Implemented in Etapa 2 — services/classifier.py must be wired first.
    """
    logger.info("clustering_task_triggered")
    raise NotImplementedError("HDBSCAN clustering not yet implemented")
