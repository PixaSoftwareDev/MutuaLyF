"""Query orchestrator: decides model, data sources, and assembles the final response.

Execution flow:
  1. Check Redis cache → return immediately on hit
  2. In parallel (asyncio.gather):
     a. Classify intent (embedding similarity)
     b. Extract entities via GLiNER (NLU)
     c. Check if query warrants Neo4j lookup
  3. Retrieve from Qdrant (always) + Neo4j (only if entities found)
  4. Rerank merged results
  5. Choose Groq model based on query complexity
  6. Generate response with isolated user input
  7. Cache response in Redis
  8. Log to consultas_log (background Celery task)
"""

import asyncio
import hashlib
import json
import logging
import time
from typing import Any

from groq import APIError, APITimeoutError, RateLimitError

from core.config import settings
from core.database import get_redis_cache

logger = logging.getLogger(__name__)


async def handle_query(
    question: str,
    tenant_id: str,
    user_id: str | None = None,
    language: str = "es",
) -> dict[str, Any]:
    """Main entry point for a user query.

    Args:
        question: Raw user question (will be sanitized before LLM use).
        tenant_id: Tenant scope.
        user_id: Optional user ID for audit logging.
        language: Response language hint.

    Returns:
        Dict with keys: answer, sources, intent_label, intent_confidence, from_cache, latency_ms.
    """
    start_ms = int(time.monotonic() * 1000)
    question_hash = _hash_question(question)

    # ── Step 1: Redis cache ────────────────────────────────────────────────────
    cached = await _check_cache(question_hash, tenant_id)
    if cached:
        latency_ms = int(time.monotonic() * 1000) - start_ms
        logger.info("cache_hit tenant_id=%s latency_ms=%d", tenant_id, latency_ms)
        from core.metrics import CACHE_HITS_TOTAL, QUERIES_TOTAL, QUERY_DURATION
        CACHE_HITS_TOTAL.labels(tenant_id=tenant_id).inc()
        QUERIES_TOTAL.labels(tenant_id=tenant_id, complexity="cached", from_cache="true").inc()
        QUERY_DURATION.labels(tenant_id=tenant_id, complexity="cached").observe(latency_ms)
        cached["from_cache"] = True
        cached["latency_ms"] = latency_ms
        return cached

    # ── Step 2: Parallel classification + NLU ─────────────────────────────────
    from services.classifier import classify_intent
    from services.nlu import extract_entities

    intent_task = asyncio.create_task(classify_intent(question, tenant_id))
    # NLU runs in a thread to avoid blocking the event loop (CPU-bound)
    loop = asyncio.get_running_loop()
    nlu_timeout = settings.nlu_timeout_ms / 1000

    async def _extract_with_timeout() -> list:
        try:
            return await asyncio.wait_for(
                loop.run_in_executor(None, extract_entities, question),
                timeout=nlu_timeout,
            )
        except asyncio.TimeoutError:
            logger.warning("nlu_timeout_exceeded tenant_id=%s", tenant_id)
            return []

    entity_task = asyncio.create_task(_extract_with_timeout())

    intent_result, entities = await asyncio.gather(intent_task, entity_task, return_exceptions=True)

    if isinstance(intent_result, Exception):
        logger.warning("intent_classification_failed error=%s", intent_result)
        intent_result = None
    if isinstance(entities, Exception):
        logger.warning("nlu_extraction_failed error=%s", entities)
        entities = []

    # ── Step 3: Retrieve from Qdrant + Neo4j in parallel ──────────────────────
    from services.retrieval import retrieve
    from services.neo4j_client import query_entities

    entity_names = [e.text for e in (entities or [])]
    use_neo4j = bool(entity_names)

    retrieval_task = retrieve(question, tenant_id)
    neo4j_task = query_entities(tenant_id, entity_names) if use_neo4j else _empty_list()

    qdrant_chunks, neo4j_records = await asyncio.gather(retrieval_task, neo4j_task, return_exceptions=True)

    if isinstance(qdrant_chunks, Exception):
        logger.error("retrieval_failed tenant_id=%s error=%s", tenant_id, qdrant_chunks)
        qdrant_chunks = []
    if isinstance(neo4j_records, Exception):
        logger.warning("neo4j_retrieval_failed error=%s", neo4j_records)
        neo4j_records = []

    # ── Step 4: Build context from retrieved chunks ────────────────────────────
    context_parts: list[str] = []
    sources: list[dict] = []

    for chunk in (qdrant_chunks or []):
        context_parts.append(chunk.text)
        sources.append({
            "chunk_id": chunk.chunk_id,
            "document_id": chunk.document_id,
            "document_title": chunk.metadata.get("filename", chunk.document_id),
            "content_excerpt": chunk.text[:200],
            "score": round(chunk.score, 4),
        })

    context = "\n\n---\n\n".join(context_parts[:5])  # Top 5 chunks in context

    # ── Step 5: Choose model based on complexity ───────────────────────────────
    from services.groq_client import QueryComplexity, classify_complexity, complete

    entity_count = len(entity_names)
    complexity = classify_complexity(question, entity_count)

    # ── Step 6: Generate answer with isolated user input ──────────────────────
    system_prompt = (
        "Eres un asistente de conocimiento institucional. "
        "Responde SOLO basándote en el contexto proporcionado. "
        "Si la información no está en el contexto, di que no la encontraste. "
        f"Responde en {language}."
    )
    # User input is in a separate message — never interpolated into the system prompt
    user_message = f"Contexto:\n{context}\n\nPregunta: {_sanitize_input(question)}"

    try:
        answer = await complete(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            complexity=complexity,
        )
    except (APITimeoutError, RateLimitError, APIError) as exc:
        latency_ms = int(time.monotonic() * 1000) - start_ms
        logger.error("groq_failed_after_retries tenant_id=%s error=%s latency_ms=%d", tenant_id, exc, latency_ms)
        return {
            "answer": "Lo siento, el servicio de IA no está disponible en este momento. Por favor intentá de nuevo en unos segundos.",
            "sources": sources,
            "intent_label": intent_result.label if intent_result else None,
            "intent_confidence": intent_result.confidence if intent_result else None,
            "from_cache": False,
            "latency_ms": latency_ms,
        }

    latency_ms = int(time.monotonic() * 1000) - start_ms

    response = {
        "answer": answer,
        "sources": sources,
        "intent_label": intent_result.label if intent_result else None,
        "intent_confidence": intent_result.confidence if intent_result else None,
        "from_cache": False,
        "latency_ms": latency_ms,
    }

    # ── Step 7: Cache the response ────────────────────────────────────────────
    await _set_cache(question_hash, tenant_id, response)

    # ── Step 8: Log async (non-blocking) ──────────────────────────────────────
    from workers.ingest_tasks import _log_usage_event
    asyncio.create_task(
        _log_usage_event(tenant_id, "query", 1)
    )
    asyncio.create_task(
        _log_query(
            question_hash=question_hash,
            tenant_id=tenant_id,
            user_id=user_id,
            intent_label=response["intent_label"],
            intent_confidence=response["intent_confidence"],
            latency_ms=latency_ms,
        )
    )

    from core.metrics import QUERIES_TOTAL, QUERY_DURATION
    QUERIES_TOTAL.labels(tenant_id=tenant_id, complexity=complexity, from_cache="false").inc()
    QUERY_DURATION.labels(tenant_id=tenant_id, complexity=complexity).observe(latency_ms)

    logger.info(
        "query_complete tenant_id=%s latency_ms=%d complexity=%s intent=%s",
        tenant_id, latency_ms, complexity, response["intent_label"],
    )
    return response


def _hash_question(question: str) -> str:
    return hashlib.sha256(question.strip().lower().encode()).hexdigest()


def _sanitize_input(question: str) -> str:
    """Strip control characters and truncate before sending to LLM."""
    sanitized = "".join(c for c in question if c.isprintable() or c in ("\n", "\t"))
    return sanitized[:2000]


async def _check_cache(question_hash: str, tenant_id: str) -> dict | None:
    redis = get_redis_cache()
    key = f"{tenant_id}:cache:{question_hash}"
    try:
        raw = await redis.get(key)
        if raw:
            return json.loads(raw)
    except Exception as exc:
        logger.warning("cache_read_failed key=%s error=%s", key, exc)
    return None


async def _set_cache(question_hash: str, tenant_id: str, response: dict) -> None:
    redis = get_redis_cache()
    key = f"{tenant_id}:cache:{question_hash}"
    try:
        # Exclude latency from cached value so hits show accurate latency
        cached = {k: v for k, v in response.items() if k != "latency_ms"}
        await redis.setex(key, settings.cache_ttl_seconds, json.dumps(cached))
    except Exception as exc:
        logger.warning("cache_write_failed key=%s error=%s", key, exc)


async def _log_query(
    question_hash: str,
    tenant_id: str,
    user_id: str | None,
    intent_label: str | None,
    intent_confidence: float | None,
    latency_ms: int,
) -> None:
    """Persist query log to consultas_log. Non-fatal on failure."""
    try:
        from core.database import get_pg_session
        from sqlalchemy import text

        async with get_pg_session(tenant_id) as session:
            await session.execute(
                text(
                    "INSERT INTO consultas_log "
                    "(user_id, question_hash, intent_label, intent_confidence, latency_ms, from_cache) "
                    "VALUES (:user_id, :question_hash, :intent_label, :intent_confidence, :latency_ms, FALSE)"
                ),
                {
                    "user_id": user_id,
                    "question_hash": question_hash,
                    "intent_label": intent_label,
                    "intent_confidence": intent_confidence,
                    "latency_ms": latency_ms,
                },
            )
    except Exception as exc:
        logger.warning("query_log_failed tenant_id=%s error=%s", tenant_id, exc)


async def _empty_list() -> list:
    return []
