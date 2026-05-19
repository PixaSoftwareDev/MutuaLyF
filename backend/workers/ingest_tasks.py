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
    from services.chunker import extract_text_from_bytes, chunk_document_hierarchical
    from services.quality_gate import validate_chunks_batch, QualityStatus
    from services.embeddings import embed_batch

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

    # ── 2. Classify document type + Hierarchical chunk (CPU-bound) ──────────────
    t = time.monotonic()
    from services.doc_classifier import classify_document
    from services.chunker import HierarchicalChunk, Chunk as ChunkType

    def _classify_and_chunk():
        classification = classify_document(text)
        logger.info(
            "doc_classified document_id=%s type=%s strategy=%s confidence=%.2f",
            document_id, classification.doc_type, classification.chunking_strategy, classification.confidence,
        )
        return chunk_document_hierarchical(
            text, document_id, tenant_id,
            {"filename": filename, "mime_type": mime_type, "document_id": document_id},
            classification=classification,
        )

    parents, children = await loop.run_in_executor(None, _classify_and_chunk)
    timings["chunk_ms"] = _ms(t)

    if not children:
        await _update_document_status(document_id, tenant_id, "failed")
        return {"chunk_count": 0, "status": "failed", "timings": timings}

    # ── 3. Quality gate on PARENTS (≈5× fewer Groq calls than gating children) ─
    # Stage 2 (semantic autonomy) + Stage 1 (Groq coherence) both run on parent
    # text.  Children whose parent is rejected are dropped before embedding.
    t = time.monotonic()
    from services.quality_gate import validate_chunk_semantic_autonomy, validate_chunks_batch, QualityStatus

    # Stage 2: filter parents that are too short to be useful
    autonomous_checks = await asyncio.gather(*[
        validate_chunk_semantic_autonomy(p) for p in parents  # type: ignore[arg-type]
    ])
    parents_stage2 = [p for p, ok in zip(parents, autonomous_checks) if ok]
    if not parents_stage2:
        parents_stage2 = parents  # keep all if everything filtered

    # Stage 1: Groq coherence gate on parent texts
    from services.orchestrator import _get_tenant_config as _get_config, _get_system_template
    _cfg = await _get_config(tenant_id)
    quality_prompt = _cfg.get("prompt_quality_gate") or await _get_system_template("Validador de documentos")

    # Wrap parents as Chunk-compatible objects for validate_chunks_batch
    import dataclasses as _dc
    parent_as_chunks: list[ChunkType] = [
        ChunkType(
            id=p.id,
            document_id=p.document_id,
            tenant_id=p.tenant_id,
            text=p.text,
            token_count=p.token_count,
            chunk_index=p.chunk_index,
            total_chunks=len(parents_stage2),
        )
        for p in parents_stage2
    ]
    quality_results = await validate_chunks_batch(parent_as_chunks, custom_prompt=quality_prompt)
    timings["quality_ms"] = _ms(t)

    quality_map = {r.chunk_id: r for r in quality_results}
    passed_parent_ids = {
        r.chunk_id for r in quality_results
        if r.status != QualityStatus.SKIPPED
    }

    # Keep only children whose parent passed quality gate
    chunks = [c for c in children if c.parent_id in passed_parent_ids]
    if not chunks:
        chunks = children  # fallback: keep all if gate wiped everything

    # ── 4. Store parents in PostgreSQL (before Qdrant so children can reference them) ─
    t = time.monotonic()
    await _store_parent_chunks(
        [p for p in parents_stage2 if p.id in passed_parent_ids],
        tenant_id,
    )
    timings["parent_store_ms"] = _ms(t)

    # ── 5. Embed children + ensure Qdrant collection ──────────────────────────
    t = time.monotonic()
    collection = f"{tenant_id}_docs"
    await _ensure_qdrant_collection(qdrant, collection)

    embeddings = await loop.run_in_executor(None, embed_batch, [c.text for c in chunks], False)
    timings["embed_ms"] = _ms(t)

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
                # Quality gate runs on parents; children inherit parent's result.
                "quality_gate_status": (quality_map[chunk.parent_id].status.value
                                        if chunk.parent_id and chunk.parent_id in quality_map else "passed"),
                "quality_gate_confidence": (round(quality_map[chunk.parent_id].confidence, 3)
                                            if chunk.parent_id and chunk.parent_id in quality_map else None),
                "quality_gate_reason": (quality_map[chunk.parent_id].reason
                                        if chunk.parent_id and chunk.parent_id in quality_map else None),
                **chunk.metadata,
            },
        )
        for chunk, emb in valid
    ]

    # ── 6. Duplicate detection (non-blocking) ────────────────────────────────
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

    # ── 7. Upsert to Qdrant in batches of 100 ────────────────────────────────
    t = time.monotonic()
    for i in range(0, len(points), 100):
        await qdrant.upsert(collection_name=collection, points=points[i:i + 100])
    timings["qdrant_ms"] = _ms(t)

    logger.info("ingest_indexed document_id=%s points=%d", document_id, len(points))

    # ── 8. Mark document ready immediately — chunks are searchable now ────────
    # NLU/Neo4j entity extraction runs as a background task so the user sees
    # "ready" without waiting for GLiNER CPU inference (which can take minutes).
    passed_count = sum(1 for r in quality_results if r.status.value == "passed")
    pending_count = sum(1 for r in quality_results if r.status.value == "pending")
    if pending_count > 0:
        agg_quality = "pending"
    elif passed_count > 0:
        agg_quality = "passed"
    else:
        agg_quality = "skipped"

    timings["total_ms"] = _ms(t0)
    logger.info(
        "ingest_pipeline_done document_id=%s chunks=%d timings=%s",
        document_id, len(points), timings,
    )

    await _update_document_status(
        document_id, tenant_id, "ready",
        chunk_count=len(points),
        quality_gate_status=agg_quality,
    )
    await _log_usage_event(tenant_id, "ingest", len(points))
    await _invalidate_tenant_cache(tenant_id)

    # ── 9. Enqueue NLU + Neo4j as background task ─────────────────────────────
    chunk_texts_and_ids = [(chunk.id, chunk.text) for chunk, _ in valid]
    enrich_document_entities.apply_async(
        args=[document_id, tenant_id, chunk_texts_and_ids],
        countdown=0,
    )

    # ── 10. Enqueue quality gate retries for chunks pending Groq response ──────
    pending_retry = [
        c for c, _ in valid
        if quality_map.get(c.id) and quality_map[c.id].status.value == "pending"
    ]
    for chunk in pending_retry:
        revalidate_chunk_quality.apply_async(args=[chunk.id, tenant_id], countdown=_RETRY_DELAYS[0])

    try:
        from core.metrics import INGEST_TOTAL, PIPELINE_DURATION, QUALITY_GATE_TOTAL
        INGEST_TOTAL.labels(tenant_id=tenant_id, status="ready").inc()
        PIPELINE_DURATION.labels(tenant_id=tenant_id).observe(timings["total_ms"])
        for r in quality_results:
            QUALITY_GATE_TOTAL.labels(status=r.status.value).inc()
    except Exception as _metrics_exc:
        logger.debug("metrics_unavailable_in_worker error=%s", _metrics_exc)

    return {"chunk_count": len(points), "status": "ready", "timings": timings}


# ── enrich_document_entities ─────────────────────────────────────────────────

@app.task(
    bind=True,
    name="workers.ingest_tasks.enrich_document_entities",
    queue="ingest",
    max_retries=2,
    autoretry_for=(Exception,),
    retry_backoff=True,
)
def enrich_document_entities(
    self: Task,
    document_id: str,
    tenant_id: str,
    chunk_texts_and_ids: list[tuple[str, str]],
) -> dict:
    """Run GLiNER NLU + write entities to Neo4j.

    Runs after the document is already marked ready so users can query
    immediately. Entity enrichment is a best-effort enhancement.
    """
    logger.info("nlu_enrich_start document_id=%s chunks=%d", document_id, len(chunk_texts_and_ids))
    return asyncio.run(_run_entity_enrichment(document_id, tenant_id, chunk_texts_and_ids))


async def _run_entity_enrichment(
    document_id: str,
    tenant_id: str,
    chunk_texts_and_ids: list[tuple[str, str]],
) -> dict:
    from services.nlu import extract_entities
    from services.neo4j_client import write_entities_for_chunk
    from core.database import get_worker_neo4j_driver

    loop = asyncio.get_running_loop()

    entity_lists = await asyncio.gather(*[
        loop.run_in_executor(None, extract_entities, text)
        for _, text in chunk_texts_and_ids
    ])

    async with get_worker_neo4j_driver() as neo4j_driver:
        neo4j_tasks = [
            write_entities_for_chunk(
                tenant_id=tenant_id,
                chunk_id=chunk_id,
                document_id=document_id,
                entities=entities,
                driver=neo4j_driver,
            )
            for (chunk_id, _), entities in zip(chunk_texts_and_ids, entity_lists)
            if entities
        ]
        if neo4j_tasks:
            await asyncio.gather(*neo4j_tasks, return_exceptions=True)

    entity_count = sum(len(e) for e in entity_lists if e)
    logger.info("nlu_enrich_done document_id=%s entities=%d", document_id, entity_count)
    return {"document_id": document_id, "entity_count": entity_count}


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
        # Load tenant quality-gate prompt via worker pg session (avoids using the
        # FastAPI app pool, which is not available in the Celery process).
        quality_prompt: str | None = None
        try:
            from core.database import get_worker_pg_session
            from sqlalchemy import text as _sa_text
            async with get_worker_pg_session(tenant_id) as _pg:
                row = await _pg.execute(
                    _sa_text(
                        "SELECT pt.content FROM system_prompt_templates pt "
                        "JOIN tenants t ON t.prompt_template_id = pt.id "
                        "WHERE t.id = :tid"
                    ),
                    {"tid": tenant_id},
                )
                quality_prompt = (row.scalar_one_or_none() or None)
        except Exception as _cfg_exc:
            logger.warning("tenant_config_load_failed_worker tenant_id=%s error=%s", tenant_id, _cfg_exc)
        result = await complete_quality_gate(chunk_text, tenant_id, custom_prompt=quality_prompt)

        # Respect manual overrides — never overwrite a human decision
        if results[0].payload.get("manually_reviewed"):
            logger.info(
                "quality_gate_retry_skipped_manual_override chunk_id=%s reviewed_by=%s",
                chunk_id, results[0].payload.get("reviewed_by"),
            )
            return "done"

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

        # Update the document-level quality_gate_status in PostgreSQL if all
        # chunks for this document are now resolved (none pending).
        doc_id = results[0].payload.get("document_id")
        if doc_id:
            await _maybe_resolve_document_quality(qdrant, collection, doc_id, tenant_id)

        return "done"


async def _maybe_resolve_document_quality(
    qdrant: AsyncQdrantClient,
    collection: str,
    doc_id: str,
    tenant_id: str,
) -> None:
    """Update document quality_gate_status in PG once all its chunks are resolved."""
    from qdrant_client.http import models as qmodels

    scroll_result = await qdrant.scroll(
        collection_name=collection,
        scroll_filter=qmodels.Filter(
            must=[qmodels.FieldCondition(key="document_id", match=qmodels.MatchValue(value=doc_id))]
        ),
        limit=1000,
        with_payload=["quality_gate_status"],
    )
    chunk_statuses = [p.payload.get("quality_gate_status", "pending") for p in scroll_result[0]]

    if any(s == "pending" for s in chunk_statuses):
        return  # Still chunks pending — do not update document yet

    agg = "passed" if any(s == "passed" for s in chunk_statuses) else "skipped"

    try:
        from core.database import get_worker_pg_session
        from sqlalchemy import text as _sa_text
        async with get_worker_pg_session(tenant_id) as pg:
            await pg.execute(
                _sa_text(
                    "UPDATE documentos SET quality_gate_status = :status, updated_at = now() "
                    "WHERE id = :doc_id"
                ),
                {"status": agg, "doc_id": doc_id},
            )
        logger.info("document_quality_resolved doc_id=%s status=%s", doc_id, agg)
    except Exception as exc:
        logger.warning("document_quality_update_failed doc_id=%s error=%s", doc_id, exc)


# ── Internal helpers ──────────────────────────────────────────────────────────

async def _store_parent_chunks(parents: list, tenant_id: str) -> None:
    """Persist parent chunks to PostgreSQL.

    Parents are large context blocks (≤700 words).  They are fetched at query
    time so the LLM receives full section context instead of small fragments.
    The ts_body tsvector column is auto-generated from the text column and
    enables BM25 keyword search without any extra work here.
    """
    if not parents:
        return
    import json as _json
    from core.database import get_worker_pg_session
    from sqlalchemy import text as _sa_text

    try:
        async with get_worker_pg_session(tenant_id) as session:
            for p in parents:
                await session.execute(
                    _sa_text("""
                        INSERT INTO parent_chunks
                            (id, document_id, text, chunk_index, token_count, metadata)
                        VALUES
                            (:id, :doc_id, :text, :idx, :tokens, :meta::jsonb)
                        ON CONFLICT (id) DO NOTHING
                    """),
                    {
                        "id":     p.id,
                        "doc_id": p.document_id,
                        "text":   p.text,
                        "idx":    p.chunk_index,
                        "tokens": p.token_count,
                        "meta":   _json.dumps(p.metadata),
                    },
                )
        logger.info("parent_chunks_stored tenant_id=%s count=%d", tenant_id, len(parents))
    except Exception as exc:
        logger.error("parent_chunks_store_failed tenant_id=%s error=%s", tenant_id, exc)


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


async def _invalidate_tenant_cache(tenant_id: str) -> None:
    """Delete all cached query responses for the tenant.

    Called after a successful ingestion so newly indexed content is immediately
    searchable. Without this, a 'no info' response cached before ingestion
    would be served for up to TTL seconds even after the document is ready.
    """
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        pattern = f"{tenant_id}:cache:*"
        cursor = 0
        deleted = 0
        while True:
            cursor, keys = await redis.scan(cursor, match=pattern, count=200)
            if keys:
                await redis.delete(*keys)
                deleted += len(keys)
            if cursor == 0:
                break
        if deleted:
            logger.info("cache_invalidated tenant_id=%s keys_deleted=%d", tenant_id, deleted)
    except Exception as exc:
        logger.warning("cache_invalidation_failed tenant_id=%s error=%s (continuing)", tenant_id, exc)


async def _log_usage_event(tenant_id: str, event_type: str, value: int) -> None:
    from core.database import get_worker_pg_session
    from sqlalchemy import text

    async with get_worker_pg_session() as session:
        await session.execute(
            text("INSERT INTO usage_events (tenant_id, event_type, value) VALUES (:tenant_id, :event_type, :value)"),
            {"tenant_id": tenant_id, "event_type": event_type, "value": value},
        )
