"""Celery tasks for intent classifier retraining with rollback."""

import logging
from workers.celery_app import app

logger = logging.getLogger(__name__)


@app.task(name="workers.training_tasks.retrain_intent_classifier", queue="training")
def retrain_intent_classifier(tenant_id: str) -> None:
    """Retrain the intent classifier for a tenant. Rolls back if new model has lower accuracy."""
    logger.info("training_task_start tenant_id=%s", tenant_id)
    raise NotImplementedError("Classifier retraining not yet implemented")
