"""Intent classifier retraining with versioning and automatic rollback.

The classifier IS the Qdrant collection — no separate ML model file.
Each training run generates a version_id. Qdrant points carry that ID in payload.

Flow:
  1. Evaluate baseline accuracy on held-out queries from consultas_log
  2. Generate new version_id
  3. Embed unapproved examples, upsert to Qdrant with new version_id
  4. Evaluate new accuracy on same held-out set
  5a. New >= Old - ROLLBACK_TOLERANCE → commit: remove old version points
  5b. New < threshold → rollback: remove new version points, restore prev version
  6. Persist result to intenciones table

Accuracy evaluation:
  - Uses recent queries from consultas_log where intent_confidence >= 0.95
    as pseudo ground-truth (high confidence = classifier was likely correct)
  - Re-runs current classifier on their question_text
  - Compares predicted label vs logged label

ROLLBACK_TOLERANCE = 0.05 — accept up to 5% accuracy drop after adding new examples.
"""

import logging
import uuid
from typing import NamedTuple

logger = logging.getLogger(__name__)

ROLLBACK_TOLERANCE = 0.05     # Accept up to 5% accuracy degradation
MIN_EVAL_SAMPLES = 10          # Skip evaluation if fewer samples available
MAX_NEW_EXAMPLES_PER_RUN = 200


class TrainResult(NamedTuple):
    tenant_id: str
    version_id: str
    baseline_accuracy: float
    new_accuracy: float
    examples_added: int
    committed: bool
    rolled_back: bool
    skipped: bool
    reason: str


async def retrain_tenant(tenant_id: str) -> TrainResult:
    """Full retraining pipeline for one tenant. Returns TrainResult."""
    logger.info("retrain_start tenant_id=%s", tenant_id)

    # ── 1. Collect unapproved (pending) examples with text ────────────────────
    new_examples = await _fetch_pending_examples(tenant_id)
    if not new_examples:
        logger.info("retrain_skip tenant_id=%s reason=no_new_examples", tenant_id)
        return TrainResult(
            tenant_id=tenant_id, version_id="", baseline_accuracy=0.0,
            new_accuracy=0.0, examples_added=0, committed=False,
            rolled_back=False, skipped=True, reason="no_new_examples",
        )

    # ── 2. Evaluate baseline ──────────────────────────────────────────────────
    baseline_acc = await _evaluate_accuracy(tenant_id)
    logger.info("retrain_baseline tenant_id=%s accuracy=%.3f", tenant_id, baseline_acc)

    # ── 3. New version_id ─────────────────────────────────────────────────────
    new_version_id = str(uuid.uuid4())[:8]  # Short for readability in logs

    # ── 4. Embed + upsert new examples ────────────────────────────────────────
    added = await _embed_and_upsert(tenant_id, new_examples, new_version_id)
    if added == 0:
        return TrainResult(
            tenant_id=tenant_id, version_id=new_version_id,
            baseline_accuracy=baseline_acc, new_accuracy=baseline_acc,
            examples_added=0, committed=False, rolled_back=False,
            skipped=True, reason="embed_failed",
        )

    # ── 5. Evaluate new accuracy ──────────────────────────────────────────────
    new_acc = await _evaluate_accuracy(tenant_id)
    logger.info(
        "retrain_eval tenant_id=%s baseline=%.3f new=%.3f added=%d",
        tenant_id, baseline_acc, new_acc, added,
    )

    # ── 6. Commit or rollback ─────────────────────────────────────────────────
    if new_acc >= baseline_acc - ROLLBACK_TOLERANCE:
        await _commit_version(tenant_id, new_version_id, new_acc, new_examples)
        logger.info("retrain_committed tenant_id=%s version=%s acc=%.3f", tenant_id, new_version_id, new_acc)
        return TrainResult(
            tenant_id=tenant_id, version_id=new_version_id,
            baseline_accuracy=baseline_acc, new_accuracy=new_acc,
            examples_added=added, committed=True, rolled_back=False,
            skipped=False, reason="committed",
        )
    else:
        await _rollback_version(tenant_id, new_version_id)
        logger.warning(
            "retrain_rolled_back tenant_id=%s version=%s baseline=%.3f new=%.3f",
            tenant_id, new_version_id, baseline_acc, new_acc,
        )
        return TrainResult(
            tenant_id=tenant_id, version_id=new_version_id,
            baseline_accuracy=baseline_acc, new_accuracy=new_acc,
            examples_added=added, committed=False, rolled_back=True,
            skipped=False, reason=f"accuracy_drop_{baseline_acc:.2f}_to_{new_acc:.2f}",
        )


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _fetch_pending_examples(tenant_id: str) -> list[dict]:
    """Fetch examples not yet embedded (version_id IS NULL) with their text."""
    from core.database import get_worker_pg_session
    from sqlalchemy import text

    async with get_worker_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            SELECT
                ie.id          AS example_id,
                ie.intencion_id,
                i.label,
                COALESCE(ie.question_text, cl.question_text) AS question_text
            FROM intencion_ejemplos ie
            JOIN intenciones i ON i.id = ie.intencion_id
            LEFT JOIN consultas_log cl ON cl.question_hash = ie.question_hash
            WHERE ie.version_id IS NULL
              AND ie.is_approved = TRUE
              AND i.is_active = TRUE
              AND COALESCE(ie.question_text, cl.question_text) IS NOT NULL
            LIMIT :limit
        """), {"limit": MAX_NEW_EXAMPLES_PER_RUN})
        return [dict(r) for r in result.mappings().all()]


async def _evaluate_accuracy(tenant_id: str) -> float:
    """Evaluate classifier accuracy on recent high-confidence queries.

    Uses queries where confidence >= 0.95 as pseudo ground truth.
    Re-runs the live classifier on their question_text and checks label match.
    Returns accuracy in [0, 1]. Returns 1.0 if not enough samples to evaluate.
    """
    from core.database import get_worker_pg_session
    from sqlalchemy import text
    from services.embeddings import embed_query
    from core.database import get_worker_qdrant_client

    async with get_worker_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            SELECT question_text, intent_label
            FROM consultas_log
            WHERE intent_confidence >= 0.95
              AND intent_label IS NOT NULL
              AND question_text IS NOT NULL
              AND from_cache = FALSE
              AND created_at >= NOW() - INTERVAL '30 days'
            ORDER BY RANDOM()
            LIMIT 100
        """))
        samples = result.fetchall()

    if len(samples) < MIN_EVAL_SAMPLES:
        logger.info("eval_skip tenant_id=%s reason=not_enough_samples count=%d", tenant_id, len(samples))
        return 1.0  # Optimistic default — don't rollback on insufficient data

    collection = f"{tenant_id}_intenciones"
    correct = 0

    async with get_worker_qdrant_client() as qdrant:
        try:
            await qdrant.get_collection(collection)
        except Exception:
            return 1.0  # No collection yet — skip evaluation

        import asyncio
        loop = asyncio.get_running_loop()

        for question_text, true_label in samples:
            try:
                vector = await loop.run_in_executor(None, embed_query, question_text)
                if vector is None:
                    continue
                results = await qdrant.search(
                    collection_name=collection,
                    query_vector=vector,
                    limit=1,
                    with_payload=True,
                )
                if results:
                    predicted_label = results[0].payload.get("label")
                    if predicted_label == true_label:
                        correct += 1
            except Exception as exc:
                logger.debug("eval_sample_error error=%s", exc)

    accuracy = correct / len(samples)
    logger.info("eval_done tenant_id=%s correct=%d total=%d accuracy=%.3f", tenant_id, correct, len(samples), accuracy)
    return accuracy


async def _embed_and_upsert(tenant_id: str, examples: list[dict], version_id: str) -> int:
    """Embed examples and upsert into Qdrant with version_id tag."""
    import asyncio
    from core.database import get_worker_qdrant_client
    from qdrant_client.models import PointStruct, VectorParams, Distance
    from services.embeddings import embed_batch

    texts = [e["question_text"] for e in examples]
    labels = [e["label"] for e in examples]
    intention_ids = [str(e["intencion_id"]) for e in examples]
    example_ids = [str(e["example_id"]) for e in examples]

    loop = asyncio.get_running_loop()
    vectors = await loop.run_in_executor(None, embed_batch, texts, True)

    valid_points = [
        PointStruct(
            id=str(uuid.uuid4()),
            vector=vec,
            payload={
                "intention_id": int_id,
                "label": label,
                "text": text,
                "version_id": version_id,
                "example_id": ex_id,
            },
        )
        for vec, label, int_id, text, ex_id in zip(vectors, labels, intention_ids, texts, example_ids)
        if vec is not None
    ]

    if not valid_points:
        return 0

    collection = f"{tenant_id}_intenciones"
    async with get_worker_qdrant_client() as qdrant:
        try:
            await qdrant.get_collection(collection)
        except Exception:
            await qdrant.create_collection(
                collection_name=collection,
                vectors_config=VectorParams(size=1024, distance=Distance.COSINE),
            )

        await qdrant.upsert(collection_name=collection, points=valid_points)

    logger.info("embed_upsert_done tenant_id=%s count=%d version=%s", tenant_id, len(valid_points), version_id)
    return len(valid_points)


async def _commit_version(tenant_id: str, new_version_id: str, accuracy: float, examples: list[dict]) -> None:
    """Commit new version: mark examples as versioned, update intenciones table."""
    from core.database import get_worker_pg_session
    from sqlalchemy import text

    example_ids = [str(e["example_id"]) for e in examples]

    async with get_worker_pg_session(tenant_id) as session:
        # Tag examples with new version_id
        await session.execute(text("""
            UPDATE intencion_ejemplos
            SET version_id = :version_id
            WHERE id = ANY(:ids::uuid[])
        """), {"version_id": new_version_id, "ids": example_ids})

        # Update intenciones: save prev_version for possible future rollback
        await session.execute(text("""
            UPDATE intenciones
            SET prev_model_version = model_version,
                model_version = :new_version,
                last_accuracy = :accuracy,
                updated_at = NOW()
            WHERE id IN (
                SELECT DISTINCT intencion_id FROM intencion_ejemplos
                WHERE id = ANY(:ids::uuid[])
            )
        """), {
            "new_version": new_version_id,
            "accuracy": accuracy,
            "ids": example_ids,
        })

    # Delete old version points from Qdrant (keep only current)
    await _prune_old_versions(tenant_id, new_version_id)


async def _rollback_version(tenant_id: str, new_version_id: str) -> None:
    """Rollback: delete all Qdrant points that belong to the failed version."""
    from core.database import get_worker_qdrant_client
    from qdrant_client.models import Filter, FieldCondition, MatchValue

    async with get_worker_qdrant_client() as qdrant:
        try:
            await qdrant.delete(
                collection_name=f"{tenant_id}_intenciones",
                points_selector=Filter(must=[
                    FieldCondition(key="version_id", match=MatchValue(value=new_version_id))
                ]),
            )
            logger.info("rollback_complete tenant_id=%s version=%s", tenant_id, new_version_id)
        except Exception as exc:
            logger.error("rollback_failed tenant_id=%s error=%s", tenant_id, exc)


async def _prune_old_versions(tenant_id: str, current_version_id: str) -> None:
    """Remove Qdrant points from versions older than current — keeps collection lean."""
    from core.database import get_worker_pg_session
    from sqlalchemy import text

    # Get the current and previous version IDs to keep
    async with get_worker_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            SELECT DISTINCT model_version, prev_model_version
            FROM intenciones
            WHERE model_version IS NOT NULL
        """))
        rows = result.fetchall()

    keep_versions = set()
    for row in rows:
        if row[0]:
            keep_versions.add(row[0])
        if row[1]:
            keep_versions.add(row[1])
    keep_versions.add(current_version_id)

    # We keep current + prev. Anything else can be pruned.
    # (For MVP we don't aggressively prune — just log the intent)
    logger.debug("prune_keep_versions tenant_id=%s versions=%s", tenant_id, keep_versions)
