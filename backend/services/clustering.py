"""HDBSCAN intent clustering service.

Flow per tenant:
  1. Fetch unclassified queries with question_text from consultas_log
  2. Embed them in batch (multilingual-e5-large)
  3. Run HDBSCAN — discovers clusters without needing k
  4. Assign cluster_candidate_id to each query
  5. Clusters >= MIN_CLUSTER_SIZE → mark 'candidate' (surfaces in intentions panel)
  6. Queries still unassigned after 60 days → mark 'dismissed'
  7. Delete dismissed queries older than 90 days (per CLAUDE.md cleanup policy)

HDBSCAN returns label=-1 for noise (queries that don't belong to any cluster).
These stay 'unassigned' and are re-evaluated on the next nightly run.
"""

import logging
import uuid
from datetime import datetime, timezone, timedelta

import numpy as np

from core.config import settings

logger = logging.getLogger(__name__)

_DISMISS_DAYS = settings.intent_cluster_dismiss_days   # 60 days default
_CLEANUP_DAYS = 90
_NOISE_LABEL = -1


async def cluster_tenant(tenant_id: str) -> dict:
    """Run full clustering pipeline for one tenant. Returns a summary dict."""
    from core.database import get_worker_pg_session
    from sqlalchemy import text

    logger.info("clustering_start tenant_id=%s", tenant_id)
    summary = {
        "tenant_id": tenant_id,
        "queries_fetched": 0,
        "clusters_found": 0,
        "candidates_surfaced": 0,
        "noise_queries": 0,
        "dismissed": 0,
        "cleaned_up": 0,
        "error": None,
    }

    try:
        # ── 1. Fetch unclassified queries with text ───────────────────────────
        async with get_worker_pg_session(tenant_id) as session:
            result = await session.execute(text("""
                SELECT id, question_text
                FROM consultas_log
                WHERE cluster_status = 'unassigned'
                  AND question_text IS NOT NULL
                  AND question_text != ''
                ORDER BY created_at DESC
                LIMIT 5000
            """))
            rows = result.fetchall()

        if len(rows) < settings.intent_cluster_min_size:
            logger.info(
                "clustering_skip tenant_id=%s reason=not_enough_queries count=%d min=%d",
                tenant_id, len(rows), settings.intent_cluster_min_size,
            )
            summary["queries_fetched"] = len(rows)
            return summary

        ids = [str(r[0]) for r in rows]
        texts = [r[1] for r in rows]
        summary["queries_fetched"] = len(texts)

        # ── 2. Embed in batch ─────────────────────────────────────────────────
        embeddings = _embed_for_clustering(texts)
        if embeddings is None:
            summary["error"] = "embedding_failed"
            return summary

        # ── 3. Run HDBSCAN ────────────────────────────────────────────────────
        labels = _run_hdbscan(embeddings)
        unique_labels = set(labels) - {_NOISE_LABEL}
        summary["clusters_found"] = len(unique_labels)
        summary["noise_queries"] = int(np.sum(labels == _NOISE_LABEL))

        logger.info(
            "clustering_hdbscan_done tenant_id=%s queries=%d clusters=%d noise=%d",
            tenant_id, len(texts), len(unique_labels), summary["noise_queries"],
        )

        # ── 4. Assign cluster_candidate_id and count per cluster ──────────────
        cluster_id_map: dict[int, str] = {
            label: str(uuid.uuid4()) for label in unique_labels
        }
        cluster_counts: dict[int, int] = {}
        for label in labels:
            if label != _NOISE_LABEL:
                cluster_counts[label] = cluster_counts.get(label, 0) + 1

        # ── 5. Bulk update: assign cluster IDs ───────────────────────────────
        candidate_ids = set()
        unassigned_noise_ids = []

        for idx, (row_id, label) in enumerate(zip(ids, labels)):
            if label == _NOISE_LABEL:
                unassigned_noise_ids.append(row_id)
                continue

            cluster_uuid = cluster_id_map[label]
            count = cluster_counts[label]
            new_status = "candidate" if count >= settings.intent_cluster_min_size else "unassigned"
            if new_status == "candidate":
                candidate_ids.add(cluster_uuid)

        # Update candidate clusters
        candidates_by_cluster: dict[str, list[str]] = {}
        for idx, (row_id, label) in enumerate(zip(ids, labels)):
            if label == _NOISE_LABEL:
                continue
            cluster_uuid = cluster_id_map[label]
            if cluster_uuid in candidate_ids:
                candidates_by_cluster.setdefault(cluster_uuid, []).append(row_id)

        async with get_worker_pg_session(tenant_id) as session:
            for cluster_uuid, cluster_row_ids in candidates_by_cluster.items():
                if not cluster_row_ids:
                    continue
                # Use unnest for bulk update
                await session.execute(text("""
                    UPDATE consultas_log
                    SET cluster_candidate_id = :cluster_id,
                        cluster_status = 'candidate'
                    WHERE id = ANY(:ids::uuid[])
                """), {
                    "cluster_id": cluster_uuid,
                    "ids": cluster_row_ids,
                })

        summary["candidates_surfaced"] = len(candidate_ids)
        logger.info(
            "clustering_candidates tenant_id=%s surfaced=%d",
            tenant_id, summary["candidates_surfaced"],
        )

        # ── 6. Dismiss queries that have been unassigned for 60+ days ─────────
        async with get_worker_pg_session(tenant_id) as session:
            result = await session.execute(text("""
                UPDATE consultas_log
                SET cluster_status = 'dismissed'
                WHERE cluster_status = 'unassigned'
                  AND created_at < NOW() - INTERVAL ':days days'
                  AND question_text IS NOT NULL
            """.replace(":days days", f"{_DISMISS_DAYS} days")))
            summary["dismissed"] = result.rowcount

        # ── 7. Clean up dismissed queries older than 90 days ──────────────────
        async with get_worker_pg_session(tenant_id) as session:
            result = await session.execute(text("""
                DELETE FROM consultas_log
                WHERE cluster_status = 'dismissed'
                  AND quality_gate_status = 'skipped'
                  AND created_at < NOW() - INTERVAL ':days days'
            """.replace(":days days", f"{_CLEANUP_DAYS} days")))
            summary["cleaned_up"] = result.rowcount

        logger.info("clustering_complete tenant_id=%s summary=%s", tenant_id, summary)

    except Exception as exc:
        logger.error("clustering_failed tenant_id=%s error=%s", tenant_id, exc)
        summary["error"] = str(exc)

    return summary


def _embed_for_clustering(texts: list[str]) -> "np.ndarray | None":
    """Embed queries using multilingual-e5-large. Returns (N, 1024) numpy array."""
    try:
        from services.embeddings import _load_model

        model = _load_model()
        if model is None:
            logger.error("clustering_embed_model_unavailable")
            return None

        prefix = "query: "
        prefixed = [f"{prefix}{t}" for t in texts]

        logger.info("clustering_embedding count=%d", len(prefixed))
        vectors = model.encode(
            prefixed,
            normalize_embeddings=True,
            batch_size=64,
            show_progress_bar=False,
        )
        return np.array(vectors, dtype=np.float32)

    except Exception as exc:
        logger.error("clustering_embed_failed error=%s", exc)
        return None


def _run_hdbscan(embeddings: "np.ndarray") -> "np.ndarray":
    """Run HDBSCAN on the embedding matrix. Returns integer label array (-1 = noise)."""
    try:
        import hdbscan

        min_cluster = max(settings.intent_cluster_min_size, 5)
        clusterer = hdbscan.HDBSCAN(
            min_cluster_size=min_cluster,
            min_samples=3,
            metric="euclidean",
            cluster_selection_method="eom",
            prediction_data=False,
        )
        labels = clusterer.fit_predict(embeddings)
        logger.info(
            "hdbscan_done n_samples=%d n_clusters=%d noise_pct=%.1f",
            len(labels),
            len(set(labels) - {_NOISE_LABEL}),
            100 * np.mean(labels == _NOISE_LABEL),
        )
        return labels

    except Exception as exc:
        logger.error("hdbscan_failed error=%s", exc)
        return np.full(len(embeddings), _NOISE_LABEL, dtype=int)
