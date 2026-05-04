"""Intentions panel: list, validate and manage discovered intents."""

import logging
import uuid
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import text

from core.database import get_pg_session
from core.security import CurrentUser, require_admin
from core.tenant import get_tenant_id

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────

class IntentionCreate(BaseModel):
    label: str
    description: str | None = None
    examples: list[str] = []  # raw query strings to embed and add


class IntentionUpdate(BaseModel):
    label: str | None = None
    description: str | None = None
    is_active: bool | None = None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/intentions")
async def list_intentions(
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """List all intentions + pending review groups from consultas_log."""
    async with get_pg_session(tenant_id) as session:
        # Active/inactive intentions with query stats for last 7 days
        result = await session.execute(text("""
            SELECT
                i.id,
                i.label,
                i.description,
                i.example_count,
                i.auto_learned_count,
                i.is_active,
                i.model_version,
                i.created_at,
                i.updated_at,
                COUNT(cl.id) FILTER (
                    WHERE cl.created_at >= NOW() - INTERVAL '7 days'
                ) AS queries_7d,
                AVG(cl.intent_confidence) FILTER (
                    WHERE cl.created_at >= NOW() - INTERVAL '7 days'
                ) AS avg_confidence_7d
            FROM intenciones i
            LEFT JOIN consultas_log cl ON cl.intent_label = i.label
            GROUP BY i.id
            ORDER BY i.is_active DESC, queries_7d DESC, i.created_at DESC
        """))
        rows = result.mappings().all()
        intentions = [_serialize_intention(dict(r)) for r in rows]

        # Pending: queries in mid-confidence band (70-94%) grouped by detected label
        # These need human confirmation before becoming active intentions
        result_pending = await session.execute(text("""
            SELECT
                intent_label,
                COUNT(*) AS query_count,
                AVG(intent_confidence) AS avg_confidence,
                MAX(created_at) AS last_seen,
                array_agg(question_hash ORDER BY created_at DESC) AS question_hashes
            FROM consultas_log
            WHERE
                intent_label IS NOT NULL
                AND intent_confidence >= :low
                AND intent_confidence < :high
                AND intent_label NOT IN (SELECT label FROM intenciones WHERE is_active = TRUE)
                AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY intent_label
            HAVING COUNT(*) >= 3
            ORDER BY query_count DESC
            LIMIT 50
        """), {"low": 0.70, "high": 0.95})
        pending_rows = result_pending.mappings().all()

        # Auto-learning blocked examples (hit 30% cap)
        result_blocked = await session.execute(text("""
            SELECT
                intent_label,
                COUNT(*) AS blocked_count,
                MAX(created_at) AS last_blocked
            FROM consultas_log
            WHERE auto_learning_blocked = TRUE
                AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY intent_label
            ORDER BY blocked_count DESC
        """))
        blocked = {r["intent_label"]: r["blocked_count"] for r in result_blocked.mappings().all()}

    pending = [
        {
            "id": f"pending_{r['intent_label'].replace(' ', '_')}",
            "label": r["intent_label"],
            "query_count": r["query_count"],
            "avg_confidence": round(float(r["avg_confidence"] or 0), 3),
            "last_seen": r["last_seen"].isoformat() if r["last_seen"] else None,
            "auto_learning_blocked_count": blocked.get(r["intent_label"], 0),
        }
        for r in pending_rows
    ]

    return {
        "intentions": intentions,
        "pending_review": pending,
        "total": len(intentions),
        "pending_total": len(pending),
    }


@router.get("/intentions/{intention_id}/examples")
async def get_intention_examples(
    intention_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
    limit: int = 10,
):
    """Return recent queries that matched this intention, for review."""
    async with get_pg_session(tenant_id) as session:
        row = await session.execute(
            text("SELECT label FROM intenciones WHERE id = :id"),
            {"id": intention_id},
        )
        intention = row.mappings().fetchone()
        if not intention:
            raise HTTPException(status_code=404, detail="Intention not found")

        result = await session.execute(text("""
            SELECT
                id,
                intent_confidence,
                auto_learning_blocked,
                from_cache,
                latency_ms,
                created_at
            FROM consultas_log
            WHERE intent_label = :label
            ORDER BY created_at DESC
            LIMIT :limit
        """), {"label": intention["label"], "limit": limit})
        examples = [dict(r) for r in result.mappings().all()]

    return {"intention_id": intention_id, "examples": examples}


@router.get("/intentions/label/{label}/examples")
async def get_pending_examples(
    label: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
    limit: int = 10,
):
    """Return sample queries for a pending intention label."""
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            SELECT
                id,
                intent_confidence,
                auto_learning_blocked,
                latency_ms,
                created_at
            FROM consultas_log
            WHERE intent_label = :label
                AND intent_confidence >= 0.70
                AND intent_confidence < 0.95
            ORDER BY created_at DESC
            LIMIT :limit
        """), {"label": label, "limit": limit})
        examples = [dict(r) for r in result.mappings().all()]
    return {"label": label, "examples": examples}


@router.post("/intentions", status_code=status.HTTP_201_CREATED)
async def create_intention(
    body: IntentionCreate,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Manually create and activate a new intention with optional seed examples."""
    async with get_pg_session(tenant_id) as session:
        existing = await session.execute(
            text("SELECT id FROM intenciones WHERE label = :label"),
            {"label": body.label},
        )
        if existing.fetchone():
            raise HTTPException(status_code=409, detail="Intention with this label already exists")

        intention_id = str(uuid.uuid4())
        await session.execute(text("""
            INSERT INTO intenciones (id, label, description, example_count, is_active)
            VALUES (:id, :label, :description, :example_count, TRUE)
        """), {
            "id": intention_id,
            "label": body.label,
            "description": body.description,
            "example_count": len(body.examples),
        })

    # Embed and index examples in Qdrant
    if body.examples:
        await _index_examples_in_qdrant(tenant_id, intention_id, body.label, body.examples)

    logger.info("intention_created tenant=%s label=%s id=%s", tenant_id, body.label, intention_id)
    return {"id": intention_id, "label": body.label, "status": "created"}


@router.post("/intentions/{intention_id}/approve")
async def approve_intention(
    intention_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Approve a pending intention: activate it and index its examples in Qdrant."""
    # intention_id may be a real UUID or a "pending_{label}" string
    if intention_id.startswith("pending_"):
        label = intention_id.removeprefix("pending_").replace("_", " ")
        return await _promote_pending_to_active(tenant_id, label)

    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text("UPDATE intenciones SET is_active = TRUE, updated_at = NOW() WHERE id = :id RETURNING label"),
            {"id": intention_id},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Intention not found")
        label = row[0]

    logger.info("intention_approved tenant=%s id=%s label=%s", tenant_id, intention_id, label)

    # Trigger async retraining — non-blocking
    try:
        from workers.training_tasks import retrain_intent_classifier
        retrain_intent_classifier.apply_async(args=[tenant_id], queue="training", countdown=5)
    except Exception as exc:
        logger.warning("retrain_trigger_failed tenant=%s error=%s", tenant_id, exc)

    return {"id": intention_id, "label": label, "status": "approved"}


@router.post("/intentions/{intention_id}/reject")
async def reject_intention(
    intention_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Reject/deactivate an intention. Pending ones are dismissed from consultas_log."""
    if intention_id.startswith("pending_"):
        label = intention_id.removeprefix("pending_").replace("_", " ")
        async with get_pg_session(tenant_id) as session:
            await session.execute(text("""
                UPDATE consultas_log
                SET cluster_status = 'dismissed'
                WHERE intent_label = :label AND intent_confidence < 0.95
            """), {"label": label})
        logger.info("pending_intention_dismissed tenant=%s label=%s", tenant_id, label)
        return {"label": label, "status": "dismissed"}

    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text("UPDATE intenciones SET is_active = FALSE, updated_at = NOW() WHERE id = :id RETURNING label"),
            {"id": intention_id},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Intention not found")
        label = row[0]

    logger.info("intention_deactivated tenant=%s id=%s label=%s", tenant_id, intention_id, label)
    return {"id": intention_id, "label": label, "status": "deactivated"}


@router.patch("/intentions/{intention_id}")
async def update_intention(
    intention_id: str,
    body: IntentionUpdate,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Update label, description or active state of an intention."""
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    set_clause = ", ".join(f"{k} = :{k}" for k in updates)
    updates["id"] = intention_id

    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text(f"UPDATE intenciones SET {set_clause}, updated_at = NOW() WHERE id = :id RETURNING id"),
            updates,
        )
        if not result.fetchone():
            raise HTTPException(status_code=404, detail="Intention not found")

    return {"id": intention_id, "status": "updated"}


@router.post("/intentions/retrain", status_code=status.HTTP_202_ACCEPTED)
async def trigger_retrain(
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Trigger manual retraining for this tenant (async, with rollback if accuracy drops)."""
    from workers.training_tasks import retrain_intent_classifier
    task = retrain_intent_classifier.apply_async(args=[tenant_id], queue="training")
    logger.info("retrain_triggered tenant_id=%s task_id=%s", tenant_id, task.id)
    return {
        "task_id": task.id,
        "status": "queued",
        "message": "Reentrenamiento iniciado. El clasificador se actualizará si la precisión mejora.",
    }


@router.get("/intentions/training/status")
async def get_training_status(
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Return current model version and accuracy for all active intentions."""
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            SELECT label, model_version, prev_model_version, last_accuracy, example_count
            FROM intenciones
            WHERE is_active = TRUE
            ORDER BY label
        """))
        rows = result.mappings().all()
    return {
        "intentions": [
            {
                "label": r["label"],
                "model_version": r["model_version"],
                "prev_model_version": r["prev_model_version"],
                "last_accuracy": round(float(r["last_accuracy"]), 3) if r["last_accuracy"] else None,
                "example_count": r["example_count"],
            }
            for r in rows
        ]
    }


@router.post("/intentions/cluster", status_code=status.HTTP_202_ACCEPTED)
async def trigger_clustering(
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Trigger an on-demand HDBSCAN clustering run for this tenant (async)."""
    from workers.clustering_tasks import cluster_single_tenant
    task = cluster_single_tenant.apply_async(args=[tenant_id], queue="clustering")
    logger.info("clustering_triggered tenant_id=%s task_id=%s", tenant_id, task.id)
    return {"task_id": task.id, "status": "queued", "message": "Clustering iniciado. El panel se actualizará en unos minutos."}


@router.delete("/intentions/{intention_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_intention(
    intention_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Permanently delete an intention and its Qdrant vectors."""
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text("DELETE FROM intenciones WHERE id = :id RETURNING label"),
            {"id": intention_id},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Intention not found")
        label = row[0]

    # Remove from Qdrant
    try:
        from core.database import get_qdrant_client
        from qdrant_client.models import Filter, FieldCondition, MatchValue
        qdrant = get_qdrant_client()
        await qdrant.delete(
            collection_name=f"{tenant_id}_intenciones",
            points_selector=Filter(must=[
                FieldCondition(key="intention_id", match=MatchValue(value=intention_id))
            ]),
        )
    except Exception as exc:
        logger.warning("delete_intention_qdrant_failed id=%s error=%s", intention_id, exc)

    logger.info("intention_deleted tenant=%s id=%s label=%s", tenant_id, intention_id, label)


# ── Internal helpers ──────────────────────────────────────────────────────────

def _serialize_intention(row: dict) -> dict:
    return {
        "id": str(row["id"]),
        "label": row["label"],
        "description": row["description"],
        "example_count": row["example_count"],
        "auto_learned_count": row["auto_learned_count"],
        "is_active": row["is_active"],
        "model_version": row["model_version"],
        "queries_7d": int(row["queries_7d"] or 0),
        "avg_confidence_7d": round(float(row["avg_confidence_7d"] or 0), 3),
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
    }


async def _promote_pending_to_active(tenant_id: str, label: str) -> dict:
    """Promote a pending cluster label to an active Intention."""
    async with get_pg_session(tenant_id) as session:
        existing = await session.execute(
            text("SELECT id FROM intenciones WHERE label = :label"), {"label": label}
        )
        row = existing.fetchone()
        if row:
            await session.execute(
                text("UPDATE intenciones SET is_active = TRUE, updated_at = NOW() WHERE id = :id"),
                {"id": str(row[0])},
            )
            intention_id = str(row[0])
        else:
            intention_id = str(uuid.uuid4())
            await session.execute(text("""
                INSERT INTO intenciones (id, label, is_active, example_count)
                VALUES (:id, :label, TRUE, 0)
            """), {"id": intention_id, "label": label})

    logger.info("pending_promoted tenant=%s label=%s id=%s", tenant_id, label, intention_id)
    return {"id": intention_id, "label": label, "status": "approved"}


async def _index_examples_in_qdrant(
    tenant_id: str,
    intention_id: str,
    label: str,
    examples: list[str],
) -> None:
    """Embed example queries and upsert into the tenant's intenciones collection."""
    try:
        import asyncio
        from core.database import get_qdrant_client
        from qdrant_client.models import PointStruct, VectorParams, Distance
        from services.embeddings import embed_batch

        loop = asyncio.get_running_loop()
        vectors = await loop.run_in_executor(None, embed_batch, examples, True)

        qdrant = get_qdrant_client()
        collection = f"{tenant_id}_intenciones"

        try:
            await qdrant.get_collection(collection)
        except Exception:
            await qdrant.create_collection(
                collection_name=collection,
                vectors_config=VectorParams(size=1024, distance=Distance.COSINE),
            )

        points = [
            PointStruct(
                id=str(uuid.uuid4()),
                vector=vec,
                payload={"intention_id": intention_id, "label": label, "text": text},
            )
            for text, vec in zip(examples, vectors)
            if vec is not None
        ]
        if points:
            await qdrant.upsert(collection_name=collection, points=points)
            logger.info("intention_examples_indexed label=%s count=%d", label, len(points))
    except Exception as exc:
        logger.error("index_examples_failed intention_id=%s error=%s", intention_id, exc)
