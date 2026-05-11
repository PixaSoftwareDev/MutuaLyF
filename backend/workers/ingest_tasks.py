"""Celery tasks for document ingestion pipeline.

Full pipeline per document:
  1. Extract text from file bytes
  2. Chunk (fixed-size 512/64 overlap)
  3. Quality gate per chunk (Groq) — non-blocking on failure
  4. Embed chunks (multilingual-e5-large) — batch
  5. Index in Qdrant
  6. Extract entities (GLiNER) → write to Neo4j (MERGE, circuit-breaker protected)
  7. Update document status in PostgreSQL
  8. Log usage event

Event-loop contract
-------------------
Every Celery task that does async work must:
  1. Call asyncio.run() exactly ONCE.
  2. Create all async clients (Qdrant, Neo4j) INSIDE that single run, using
     the get_worker_*() context managers from core.database.
  3. Never pass async client objects across asyncio.run() boundaries — they
     are bound to the event loop that created them.
"""

import asyncio
import logging
import os
import time
import uuid
from pathlib import Path

from celery import Task
from neo4j import AsyncDriver
from qdrant_client import AsyncQdrantClient
from qdrant_client.models import PointStruct

from workers.celery_app import app
from core.config import settings

logger = logging.getLogger(__name__)

_RETRY_DELAYS = [60, 300, 1800, 7200]  # 1m, 5m, 30m, 2h


# ── process_document ──────────────────────────────────────────────────────────

@app.task(
    bind=True,
    name="workers.ingest_tasks.process_document",
    queue="ingest",
    max_retries=3,
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_backoff_max=600,
)
def process_document(
    self: Task,
    document_id: str,
    tenant_id: str,
    file_path: str,
    mime_type: str,
    filename: str,
) -> dict:
    """Full ingestion pipeline. Runs async work in a single asyncio.run() call."""
    logger.info("ingest_start document_id=%s tenant_id=%s", document_id, tenant_id)
    return asyncio.run(
        _ingest_with_lifecycle(document_id, tenant_id, file_path, mime_type, filename)
    )


async def _ingest_with_lifecycle(
    document_id: str,
    tenant_id: str,
    file_path: str,
    mime_type: str,
    filename: str,
) -> dict:
    """Single event loop entry point. Opens all async clients here and closes them on exit."""
    from core.database import get_worker_qdrant_client, get_worker_neo4j_driver

    async with get_worker_qdrant_client() as qdrant, get_worker_neo4j_driver() as neo4j_driver:
        try:
            result = await _run_ingest_pipeline(
                document_id, tenant_id, file_path, mime_type, filename,
                qdrant=qdrant,
                neo4j_driver=neo4j_driver,
            )
            logger.info("ingest_complete document_id=%s chunks=%d", document_id, result["chunk_count"])
            return result
        except Exception as exc:
            logger.error("ingest_failed document_id=%s error=%s", document_id, exc)
            await _update_document_status(document_id, tenant_id, "failed")
            raise
        finally:
            # Always clean up temp file regardless of success or failure
            try:
                os.unlink(file_path)
            except OSError:
                pass


async def _run_ingest_pipeline(
    document_id: str,
    tenant_id: str,
    file_path: str,
    mime_type: str,
    filename: str,
    *,
    qdrant: AsyncQdrantClient,
    neo4j_driver: AsyncDriver,
) -> dict:
    """Core ingestion logic. All async clients are injected — no global lookups."""
    from services.chunker import extract_text_from_bytes, chunk_document
    from services.quality_gate import validate_chunks_batch, QualityStatus
    from services.embeddings import embed_batch
    from services.nlu import extract_entities
    from services.neo4j_client import write_entities_for_chunk

    loop = asyncio.get_running_loop()
    timings: dict[str, int] = {}
    t0 = time.monotonic()

    def _ms(t_start: float) -> int:
        return int((time.monotonic() - t_start) * 1000)

    await _update_document_status(document_id, tenant_id, "processing")

    # ── 1. Extract text (CPU-bound: PDF parsing, docx parsing) ───────────────
    # Read file bytes FIRST before any operation that might fail — so Celery
    # retries can still access the file (it's deleted only on success at step 10).
    t = time.monotonic()
    try:
        file_bytes = Path(file_path).read_bytes()
    except FileNotFoundError:
        logger.error(
            "ingest_file_not_found document_id=%s path=%s "
            "(file was cleaned up — no retry possible)",
            document_id, file_path,
        )
        await _update_document_status(document_id, tenant_id, "failed")
        return {"chunk_count": 0, "status": "failed", "timings": {"extract_ms": 0}}
    text = await loop.run_in_executor(
        None, extract_text_from_bytes, file_bytes, mime_type, filename
    )
    timings["extract_ms"] = _ms(t)

    if not text.strip():
        logger.warning("ingest_empty_text document_id=%s", document_id)
        await _update_document_status(document_id, tenant_id, "failed")
        return {"chunk_count": 0, "status": "failed", "timings": timings}

    # ── 2. Classify document type + Chunk (CPU-bound) ────────────────────────
    t = time.monotonic()
    from services.doc_classifier import classify_document

    def _classify_and_chunk():
        classification = classify_document(text)
        logger.info(
            "doc_classified document_id=%s type=%s strategy=%s confidence=%.2f",
            document_id, classification.doc_type, classification.chunking_strategy, classification.confidence,
        )
        return chunk_document(
            text, document_id, tenant_id,
            {"filename": filename, "mime_type": mime_type, "document_id": document_id},
            classification=classification,
        )

    chunks = await loop.run_in_executor(None, _classify_and_chunk)
    timings["chunk_ms"] = _ms(t)

    if not chunks:
        await _update_document_status(document_id, tenant_id, "failed")
        return {"chunk_count": 0, "status": "failed", "timings": timings}

    # ── 3. Quality gate stage 2: filter non-autonomous chunks ─────────────────
    t = time.monotonic()
    from services.quality_gate import validate_chunk_semantic_autonomy
    autonomous_checks = await asyncio.gather(*[
        validate_chunk_semantic_autonomy(c) for c in chunks
    ])
    chunks_stage2 = [c for c, ok in zip(chunks, autonomous_checks) if ok]
    filtered_count = len(chunks) - len(chunks_stage2)
    if filtered_count > 0:
        logger.info(
            "quality_stage2_filtered document_id=%s removed=%d kept=%d",
            document_id, filtered_count, len(chunks_stage2),
        )
    chunks = chunks_stage2 if chunks_stage2 else chunks  # keep original if all filtered

    # ── 4+5. Quality gate stage 1 (Groq I/O) + Embeddings (CPU) run concurrently ─
    from services.orchestrator import _get_tenant_config as _get_config
    _cfg = await _get_config(tenant_id)
    quality_task = validate_chunks_batch(chunks, max_concurrent=5, custom_prompt=_cfg.get("prompt_quality_gate"))
    embed_task = loop.run_in_executor(None, embed_batch, [c.text for c in chunks], False)
    quality_results, embeddings = await asyncio.gather(quality_task, embed_task)
    timings["quality_and_embed_ms"] = _ms(t)
    quality_map = {r.chunk_id: r for r in quality_results}

    # ── 5. Ensure Qdrant collection exists, build points ─────────────────────
    collection = f"{tenant_id}_docs"
    await _ensure_qdrant_collection(qdrant, collection)

    valid: list[tuple] = [
        (chunk, emb)
        for chunk, emb in zip(chunks, embeddings)
        if emb is not None
    ]
    if len(valid) < len(chunks):
        logger.warning(
            "embed_partial_failure document_id=%s total=%d embedded=%d",
            document_id, len(chunks), len(valid),
        )

    points: list[PointStruct] = [
        PointStruct(
            id=chunk.id,
            vector=emb,
            payload={
                "document_id": chunk.document_id,
                "tenant_id": chunk.tenant_id,
                "text": chunk.text,
                "chunk_index": chunk.chunk_index,
                "total_chunks": chunk.total_chunks,
                "chunk_level": chunk.chunk_level,
                "parent_id": chunk.parent_id,
                "quality_gate_status": (quality_map[chunk.id].status.value
                                        if chunk.id in quality_map else "pending"),
                **chunk.metadata,
            },
        )
        for chunk, emb in valid
    ]

    # ── 6. Extract entities concurrently (GLiNER — CPU per chunk) ────────────
    t = time.monotonic()
    entity_lists = await asyncio.gather(*[
        loop.run_in_executor(None, extract_entities, chunk.text)
        for chunk, _ in valid
    ])
    timings["nlu_ms"] = _ms(t)

    # ── 7. Write Neo4j entities concurrently across all chunks ────────────────
    t = time.monotonic()
    neo4j_tasks = [
        write_entities_for_chunk(
            tenant_id=tenant_id,
            chunk_id=chunk.id,
            document_id=document_id,
            entities=entities,
            driver=neo4j_driver,
        )
        for (chunk, _), entities in zip(valid, entity_lists)
        if entities
    ]
    if neo4j_tasks:
        await asyncio.gather(*neo4j_tasks, return_exceptions=True)
    timings["neo4j_ms"] = _ms(t)

    # ── 7b. Duplicate detection (non-blocking) ────────────────────────────────
    # Only cross-document duplicates are reported. Within-batch comparison is
    # skipped because every batch belongs to a single document — comparing its
    # chunks against each other always yields same-doc pairs, which are never
    # actionable (overlap artifact, not a real duplicate).
    try:
        from services.duplicate_detector import find_duplicates_against_existing
        from core.database import get_worker_pg_session
        from sqlalchemy import text as sa_text

        valid_chunks = [c for c, _ in valid]
        valid_vectors = [emb for _, emb in valid]

        existing_pairs = await find_duplicates_against_existing(
            valid_chunks, tenant_id, valid_vectors, qdrant_client=qdrant
        )

        if existing_pairs:
            logger.warning(
                "duplicates_detected document_id=%s existing_pairs=%d",
                document_id, len(existing_pairs),
            )

        # Insert existing-vs-new duplicate pairs into PG
        if existing_pairs:
            async with get_worker_pg_session(tenant_id) as pg_session:
                for pair in existing_pairs:
                    try:
                        await pg_session.execute(
                            sa_text(
                                "INSERT INTO chunk_duplicate_pairs "
                                "(chunk_id_a, chunk_id_b, doc_id_a, doc_id_b, "
                                " text_a, text_b, jaccard_score, cosine_score) "
                                "VALUES (:a, :b, :da, :db, :ta, :tb, :j, :c) "
                                "ON CONFLICT DO NOTHING"
                            ),
                            {
                                "a": pair["chunk_id_new"],
                                "b": pair["chunk_id_existing"],
                                "da": pair["doc_id_new"],
                                "db": pair["doc_id_existing"],
                                "ta": pair["text_new"][:10000],
                                "tb": pair["text_existing"][:10000],
                                "j": pair["jaccard"],
                                "c": pair["cosine"],
                            },
                        )
                    except Exception as exc:
                        logger.warning(
                            "dup_pair_insert_failed chunk_ids=%s,%s error=%s",
                            pair["chunk_id_new"], pair["chunk_id_existing"], exc,
                        )
    except Exception as exc:
        logger.warning(
            "duplicate_detection_failed document_id=%s error=%s (continuing ingest)",
            document_id, exc,
        )

    # ── 8. Upsert to Qdrant in batches of 100 ────────────────────────────────
    t = time.monotonic()
    for i in range(0, len(points), 100):
        await qdrant.upsert(collection_name=collection, points=points[i:i + 100])
    timings["qdrant_ms"] = _ms(t)

    logger.info("ingest_indexed document_id=%s points=%d", document_id, len(points))

    # ── 9. Enqueue quality gate retries for chunks pending Groq response ──────
    pending_retry = [
        c for c, _ in valid
        if quality_map.get(c.id) and quality_map[c.id].status.value == "pending"
    ]
    for chunk in pending_retry:
        revalidate_chunk_quality.apply_async(args=[chunk.id, tenant_id], countdown=_RETRY_DELAYS[0])

    # ── 10. Finalize — status update FIRST, then metrics (graceful) ──────────
    # Compute aggregate quality_gate_status for the document
    all_statuses = {r.status.value for r in quality_results}
    if all_statuses == {"passed"}:
        agg_quality = "passed"
    elif "pending" in all_statuses:
        agg_quality = "pending"
    else:
        agg_quality = "skipped"

    timings["total_ms"] = _ms(t0)
    logger.info(
        "ingest_pipeline_done document_id=%s chunks=%d timings=%s",
        document_id, len(points), timings,
    )

    # Status + usage BEFORE anything that can raise (metrics)
    await _update_document_status(
        document_id, tenant_id, "ready",
        chunk_count=len(points),
        quality_gate_status=agg_quality,
    )
    await _log_usage_event(tenant_id, "ingest", len(points))

    try:
        from core.metrics import INGEST_TOTAL, PIPELINE_DURATION, QUALITY_GATE_TOTAL
        INGEST_TOTAL.labels(tenant_id=tenant_id, status="ready").inc()
        PIPELINE_DURATION.labels(tenant_id=tenant_id).observe(timings["total_ms"])
        for r in quality_results:
            QUALITY_GATE_TOTAL.labels(status=r.status.value).inc()
    except Exception as _metrics_exc:
        logger.debug("metrics_unavailable_in_worker error=%s", _metrics_exc)

    return {"chunk_count": len(points), "status": "ready", "timings": timings}


# ── revalidate_chunk_quality ──────────────────────────────────────────────────

@app.task(
    bind=True,
    name="workers.ingest_tasks.revalidate_chunk_quality",
    queue="ingest",
    max_retries=3,
)
def revalidate_chunk_quality(self: Task, chunk_id: str, tenant_id: str) -> None:
    """Retry quality gate for a chunk that failed due to Groq unavailability.

    Returns one of three outcomes (decided inside async code, acted on here):
      'done'  — validation succeeded or chunk no longer exists
      'retry' — Groq still unavailable, schedule next attempt
      'skip'  — retries exhausted, chunk permanently marked as skipped
    """
    logger.info("quality_gate_retry chunk_id=%s tenant_id=%s attempt=%d", chunk_id, tenant_id, self.request.retries)

    outcome = asyncio.run(_run_revalidation(chunk_id, tenant_id))

    if outcome == "retry":
        retry_index = min(self.request.retries + 1, len(_RETRY_DELAYS) - 1)
        raise self.retry(countdown=_RETRY_DELAYS[retry_index])

    if outcome == "skip":
        logger.warning("quality_gate_skipped chunk_id=%s retries_exhausted=True", chunk_id)


async def _run_revalidation(chunk_id: str, tenant_id: str) -> str:
    """Revalidate one chunk. Returns 'done', 'retry', or 'skip'."""
    from core.database import get_worker_qdrant_client
    from services.groq_client import complete_quality_gate

    async with get_worker_qdrant_client() as qdrant:
        collection = f"{tenant_id}_docs"

        results = await qdrant.retrieve(collection_name=collection, ids=[chunk_id], with_payload=True)
        if not results:
            logger.warning("quality_gate_retry_chunk_not_found chunk_id=%s", chunk_id)
            return "done"

        chunk_text = results[0].payload.get("text", "")
        from services.orchestrator import _get_tenant_config as _get_config
        _cfg = await _get_config(tenant_id)
        result = await complete_quality_gate(chunk_text, tenant_id, custom_prompt=_cfg.get("prompt_quality_gate"))

        if result["error"] is not None and result["is_coherent"] is None:
            # Groq still down — let the caller decide whether to retry or skip
            from celery import current_task
            retries = current_task.request.retries if current_task else 0
            max_retries = current_task.max_retries if current_task else 3
            if retries >= max_retries - 1:
                await qdrant.set_payload(
                    collection_name=collection,
                    payload={"quality_gate_status": "skipped"},
                    points=[chunk_id],
                )
                return "skip"
            return "retry"

        new_status = "passed" if result["is_coherent"] else "skipped"
        await qdrant.set_payload(
            collection_name=collection,
            payload={"quality_gate_status": new_status},
            points=[chunk_id],
        )
        logger.info("quality_gate_retry_done chunk_id=%s status=%s", chunk_id, new_status)
        return "done"


# ── Internal helpers ──────────────────────────────────────────────────────────

async def _ensure_qdrant_collection(qdrant: AsyncQdrantClient, collection: str) -> None:
    """Create the Qdrant collection if it doesn't exist yet.

    Handles the race where a tenant was provisioned but the collection was
    never created (e.g., Qdrant was down during onboarding).
    """
    from qdrant_client.models import Distance, VectorParams

    try:
        await qdrant.get_collection(collection)
    except Exception:
        try:
            await qdrant.create_collection(
                collection_name=collection,
                vectors_config=VectorParams(size=1024, distance=Distance.COSINE),
            )
            logger.info("qdrant_collection_created collection=%s", collection)
        except Exception as exc:
            # Another worker may have created it concurrently — ignore
            logger.warning("qdrant_collection_create_skipped collection=%s reason=%s", collection, exc)


async def _update_document_status(
    document_id: str,
    tenant_id: str,
    status: str,
    chunk_count: int | None = None,
    quality_gate_status: str | None = None,
) -> None:
    from core.database import get_worker_pg_session
    from sqlalchemy import text

    async with get_worker_pg_session(tenant_id) as session:
        if chunk_count is not None and quality_gate_status is not None:
            await session.execute(
                text(
                    "UPDATE documentos SET status = :status, chunk_count = :count, "
                    "quality_gate_status = :qgs, updated_at = NOW() WHERE id = :id"
                ),
                {"status": status, "count": chunk_count, "qgs": quality_gate_status, "id": document_id},
            )
        elif chunk_count is not None:
            await session.execute(
                text("UPDATE documentos SET status = :status, chunk_count = :count, updated_at = NOW() WHERE id = :id"),
                {"status": status, "count": chunk_count, "id": document_id},
            )
        else:
            await session.execute(
                text("UPDATE documentos SET status = :status, updated_at = NOW() WHERE id = :id"),
                {"status": status, "id": document_id},
            )


async def _log_usage_event(tenant_id: str, event_type: str, value: int) -> None:
    from core.database import get_worker_pg_session
    from sqlalchemy import text

    async with get_worker_pg_session() as session:
        await session.execute(
            text("INSERT INTO usage_events (tenant_id, event_type, value) VALUES (:tenant_id, :event_type, :value)"),
            {"tenant_id": tenant_id, "event_type": event_type, "value": value},
        )
