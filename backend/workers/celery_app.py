"""Celery application configuration."""

from celery import Celery
from celery.schedules import crontab
from celery.signals import worker_process_init
from core.config import settings

app = Celery(
    "ia_platform",
    broker=settings.redis_url_broker,
    backend=settings.redis_url_broker,
    include=[
        "workers.ingest_tasks",
        "workers.clustering_tasks",
        "workers.training_tasks",
        "workers.handoff_tasks",
    ],
)

@worker_process_init.connect
def on_worker_process_init(**kwargs):
    """Run once in each forked worker process.

    1. Dispose inherited SQLAlchemy engine — asyncpg connections from the parent
       are bound to the parent's event loop and must not be reused after fork.
    2. Pre-warm CPU-intensive models so the FIRST task doesn't pay cold-load cost.
       multilingual-e5-large: ~5s load  |  GLiNER large: ~21s load
    """
    import asyncio
    from core.database import _pg_engine

    if _pg_engine is not None:
        loop = asyncio.new_event_loop()
        loop.run_until_complete(_pg_engine.dispose())
        loop.close()

    # Pre-warm models — @lru_cache ensures they load exactly once per process.
    # Any import error is non-fatal: the task will attempt lazy loading instead.
    try:
        from services.embeddings import _load_model as _warm_embeddings
        _warm_embeddings()
    except Exception:
        pass

    try:
        from services.nlu import _load_model as _warm_nlu
        _warm_nlu()
    except Exception:
        pass


app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_acks_late=True,  # Acknowledge after completion — prevents losing jobs on worker crash
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,  # Fair dispatch — don't prefetch more than one task per worker
    task_routes={
        "workers.ingest_tasks.*": {"queue": "ingest"},
        "workers.clustering_tasks.*": {"queue": "clustering"},
        "workers.training_tasks.*": {"queue": "training"},
    },
    beat_schedule={
        "nightly-clustering": {
            "task": "workers.clustering_tasks.run_hdbscan_clustering",
            "schedule": crontab(hour=2, minute=0),
        },
        "nightly-retraining": {
            "task": "workers.training_tasks.retrain_all_tenants",
            "schedule": crontab(hour=3, minute=0),
        },
        "operator-inactivity-check": {
            "task": "workers.handoff_tasks.check_operator_inactivity",
            "schedule": 60,
        },
        "close-stale-conversations": {
            "task": "workers.handoff_tasks.close_stale_conversations",
            "schedule": 300,  # every 5 min — close bot_active idle > 30 min
        },
    },
)
