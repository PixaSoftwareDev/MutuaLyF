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
import re
import hashlib
import json
import logging
import time
from typing import Any

import httpx
from groq import APIError, APITimeoutError, RateLimitError

from core.config import settings
from core.database import get_redis_cache

logger = logging.getLogger(__name__)



_KW_STOPWORDS = {
    "de", "la", "el", "en", "un", "una", "los", "las", "del",
    "para", "por", "con", "que", "es", "se", "su", "al", "le",
    "da", "lo", "si", "te", "no", "fue", "son", "hay", "pero",
    "como", "cuando", "donde", "cuanto", "cuantos", "tiene",
}


def _keyword_overlap(query: str, text: str) -> float:
    """Fraction of meaningful query tokens (len>=3, not stopwords) found in text.

    Model-free ranking signal used when the TEI reranker is unavailable.
    """
    tokens = {
        t for t in re.findall(r"\w+", query.lower())
        if len(t) >= 3 and t not in _KW_STOPWORDS
    }
    if not tokens:
        return 0.0
    text_lower = text.lower()
    return sum(1 for t in tokens if t in text_lower) / len(tokens)

async def handle_query(
    question: str,
    tenant_id: str,
    user_id: str | None = None,
    language: str = "es",
    conversation_history: list[tuple[str, str]] | None = None,
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
    from core.tracing import get_tracer
    tracer = get_tracer()

    start_ms = int(time.monotonic() * 1000)
    question_hash = _hash_question(question)

    with tracer.start_as_current_span("query.handle") as span:
        span.set_attribute("tenant_id", tenant_id)
        span.set_attribute("question_hash", question_hash)

    # ── Step 0: Query normalization (acronym expansion) ────────────────────────
    # Normalize before cache lookup so "RRHH" and "Recursos Humanos" share cache.
    # The original question is kept for display; normalized version drives retrieval.
    from services.query_normalizer import normalize_query
    normalized_question = normalize_query(question)
    if normalized_question != question:
        logger.debug(
            "query_normalized original=%r normalized=%r",
            question[:80], normalized_question[:80],
        )

    # ── Step 1: Redis exact cache ──────────────────────────────────────────────
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
        asyncio.ensure_future(_log_query(
            tenant_id=tenant_id,
            user_id=user_id,
            question_text=question[:500],
            question_hash=question_hash,
            intent_label=cached.get("intent_label"),
            intent_confidence=cached.get("intent_confidence", 0.0),
            latency_ms=latency_ms,
            from_cache=True,
        ))
        return cached

    # ── Step 1b: Semantic cache ────────────────────────────────────────────────
    # Embed the query once here — embed_query_cached is LRU-cached by text,
    # so the subsequent call inside retrieve() costs nothing.
    query_vector: list[float] | None = None
    if settings.semantic_cache_enabled:
        from services.embedding_cache import embed_query_cached
        query_vector = await embed_query_cached(normalized_question)
        if query_vector is not None:
            sem_cached = await _check_semantic_cache(query_vector, tenant_id)
            if sem_cached:
                latency_ms = int(time.monotonic() * 1000) - start_ms
                logger.info("semantic_cache_hit tenant_id=%s latency_ms=%d", tenant_id, latency_ms)
                from core.metrics import CACHE_HITS_TOTAL, QUERIES_TOTAL, QUERY_DURATION
                CACHE_HITS_TOTAL.labels(tenant_id=tenant_id).inc()
                QUERIES_TOTAL.labels(tenant_id=tenant_id, complexity="cached", from_cache="true").inc()
                QUERY_DURATION.labels(tenant_id=tenant_id, complexity="cached").observe(latency_ms)
                sem_cached["from_cache"] = True
                sem_cached["latency_ms"] = latency_ms
                asyncio.ensure_future(_log_query(
                    tenant_id=tenant_id,
                    user_id=user_id,
                    question_text=question[:500],
                    question_hash=question_hash,
                    intent_label=sem_cached.get("intent_label"),
                    intent_confidence=sem_cached.get("intent_confidence", 0.0),
                    latency_ms=latency_ms,
                    from_cache=True,
                ))
                return sem_cached

    # ── Step 2: Parallel classification + NLU ─────────────────────────────────
    from services.classifier import classify_intent
    from services.nlu import extract_entities

    intent_task = asyncio.create_task(classify_intent(normalized_question, tenant_id))
    # NLU runs in a thread to avoid blocking the event loop (CPU-bound)
    loop = asyncio.get_running_loop()
    nlu_timeout = settings.nlu_timeout_ms / 1000

    async def _extract_with_timeout() -> list:
        try:
            return await asyncio.wait_for(
                loop.run_in_executor(None, extract_entities, normalized_question),
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
    from services.retrieval import retrieve, retrieve_multi_query
    from services.neo4j_client import query_entities

    entity_names = [e.text for e in (entities or [])]
    use_neo4j = bool(entity_names)

    # Detect ambiguity from classifier result
    is_ambiguous = intent_result is not None and getattr(intent_result, "is_ambiguous", False)
    second_label = getattr(intent_result, "second_label", None) if intent_result else None

    # Load tenant config early — needed by rewriter (bot_description) and context builder.
    # Redis-cached: <5ms, safe to load here before retrieval.
    tenant_config = await _get_tenant_config(tenant_id)
    bot_description: str = tenant_config.get("bot_description") or ""

    # ── Step 3a: Conversational query enrichment (legacy keyword merge) ────────
    # Short/elliptical queries ("¿y para el primer año?", "¿cuánto?", "¿sí?")
    # are semantically empty out of context. Append the last user question and
    # last bot topic keywords so the embedding captures the actual intent.
    # Esto sigue activo como red de seguridad si query rewriting falla.
    retrieval_question = _enrich_query_with_history(normalized_question, conversation_history)
    if retrieval_question != normalized_question:
        logger.debug(
            "query_enriched original=%r enriched=%r",
            normalized_question[:80], retrieval_question[:80],
        )

    # ── Step 3b: Query rewriting con LLM (vocabulary mismatch + follow-ups) ────
    # Antes del retrieval, un LLM rápido reescribe la query con sinónimos +
    # contexto del historial y genera N variantes. Multi-query retrieval usa
    # todas con RRF fusion → mejor recall sin tocar el contenido del KB.
    # Si feature flag off o LLM falla → fallback a query original (degraded).
    if settings.query_rewriting_enabled:
        from services.query_rewriter import rewrite_query
        rewrite_result = await rewrite_query(
            retrieval_question,
            conversation_history,
            bot_description=bot_description or None,
        )
        all_queries = rewrite_result.all_queries
        rewriter_expanded = not rewrite_result.skipped and not rewrite_result.fallback and len(all_queries) > 1
        if rewrite_result.skipped:
            logger.debug("query_rewrite_skipped_heuristic query=%r", retrieval_question[:80])
        elif rewrite_result.used_cache:
            logger.debug("query_rewrite_used_cache n_queries=%d", len(all_queries))
        elif rewrite_result.fallback:
            logger.warning("query_rewrite_fallback_to_original query=%r", retrieval_question[:80])
        else:
            logger.info(
                "query_rewrite_applied original=%r main=%r variants=%d expanded=%s",
                retrieval_question[:60], rewrite_result.main[:80],
                len(rewrite_result.variants), rewriter_expanded,
            )
        retrieval_task = retrieve_multi_query(all_queries, tenant_id)
    else:
        rewriter_expanded = False
        retrieval_task = retrieve(retrieval_question, tenant_id)

    neo4j_task = query_entities(tenant_id, entity_names) if use_neo4j else _empty_list()

    qdrant_chunks, neo4j_records = await asyncio.gather(retrieval_task, neo4j_task, return_exceptions=True)

    if isinstance(qdrant_chunks, Exception):
        logger.error("retrieval_failed tenant_id=%s error=%s", tenant_id, qdrant_chunks)
        qdrant_chunks = []
    if isinstance(neo4j_records, Exception):
        logger.warning("neo4j_retrieval_failed error=%s", neo4j_records)
        neo4j_records = []

    # ── Step 3b: Merge Neo4j entity chunks into Qdrant results ───────────────
    # Neo4j returns chunk_ids that contain named entities from the query.
    # Two cases:
    # 1. Chunk already in qdrant_chunks but score below min_score threshold →
    #    boost its score to 1.0 (entity match is always relevant).
    # 2. Chunk not in qdrant_chunks at all → fetch from Qdrant and add with score=1.0.
    if neo4j_records:
        from services.retrieval import retrieve_by_ids
        neo4j_chunk_ids = {r["chunk_id"] for r in neo4j_records}
        qdrant_list = list(qdrant_chunks or [])

        # Store pre-boost scores for relevance ordering after the hard 1.0 override.
        # Without this, all Neo4j-boosted chunks tie at 1.0 and the context builder
        # falls back to chunk_index order, always sending intro/contact chunks first
        # regardless of which section the query is about.
        for chunk in qdrant_list:
            chunk.metadata["_pre_neo4j_score"] = chunk.score

        # Hard boost to 1.0: ensures entity-confirmed chunks pass min_score=0.55
        # (after BM25+RRF, all scores are tiny ~0.01-0.03, below the filter threshold).
        for chunk in qdrant_list:
            if chunk.chunk_id in neo4j_chunk_ids:
                chunk.score = 1.0

        # Cap new_ids to 3 to avoid inflating context with sibling-child
        # duplicates from hierarchical chunking (same parent content, different child IDs).
        existing_ids = {c.chunk_id for c in qdrant_list}
        new_ids = [cid for cid in neo4j_chunk_ids if cid not in existing_ids][:3]
        if new_ids:
            entity_chunks = await retrieve_by_ids(new_ids, tenant_id)
            for ec in entity_chunks:
                ec.metadata["_pre_neo4j_score"] = 0.0  # no prior semantic score
                ec.score = 1.0
            qdrant_list.extend(entity_chunks)

        if neo4j_chunk_ids:
            logger.info(
                "neo4j_entity_boost tenant_id=%s entity_chunk_ids=%d new_fetched=%d",
                tenant_id, len(neo4j_chunk_ids), len(new_ids),
            )
        qdrant_chunks = qdrant_list

    # ── Step 4: Load remaining configs + personality template ────────────────────
    # tenant_config already loaded above (before rewriter). Extract remaining fields.
    min_score: float = tenant_config.get("min_retrieval_score", 0.55)
    bot_scope: str   = tenant_config.get("bot_scope") or ""

    personality, anti_hallucination = await asyncio.gather(
        _get_active_template(tenant_id),
        _get_system_template("Reglas anti-alucinación"),
    )

    if not personality:
        logger.warning("no_active_personality tenant_id=%s", tenant_id)
        return {
            "answer": "Este asistente no tiene una personalidad configurada. Contactá al administrador de tu organización.",
            "sources": [],
            "intent": None,
            "from_cache": False,
            "latency_ms": 0,
        }

    # Emergency fallback if anti-hallucination template missing from DB
    if not anti_hallucination:
        logger.error("anti_hallucination_template_missing tenant_id=%s — using emergency fallback", tenant_id)
        anti_hallucination = _FALLBACK_ANTI_HALLUCINATION

    # ── Step 5: Build context — drop chunks below relevance threshold ──────────
    context_parts: list[str] = []
    sources: list[dict] = []
    low_confidence_fallback = False

    all_chunks = list(qdrant_chunks or [])

    for chunk in all_chunks:
        if chunk.score < min_score:
            logger.debug(
                "chunk_below_threshold chunk_id=%s score=%.3f min=%.3f",
                chunk.chunk_id, chunk.score, min_score,
            )
            continue
        doc_name = chunk.metadata.get("filename", "")
        chunk_text = f"Fuente: {doc_name}\n{chunk.text}" if doc_name else chunk.text
        context_parts.append(chunk_text)
        sources.append({
            "chunk_id": chunk.chunk_id,
            "document_id": chunk.document_id,
            "document_title": chunk.metadata.get("filename", chunk.document_id),
            "content_excerpt": chunk.text[:200],
            "score": round(chunk.score, 4),
        })

    # Adaptive fallback: if nothing passed the threshold but results exist,
    # include the top-2 chunks with a low-confidence warning so the LLM can
    # give a cautious partial answer instead of a hard "no information" reply.
    if not context_parts and all_chunks:
        best_score = all_chunks[0].score
        logger.info(
            "low_confidence_fallback tenant_id=%s best_score=%.3f min_score=%.3f",
            tenant_id, best_score, min_score,
        )
        low_confidence_fallback = True
        for chunk in all_chunks[:settings.low_confidence_fallback_chunks]:
            doc_name = chunk.metadata.get("filename", "")
            chunk_text = f"Fuente: {doc_name}\n{chunk.text}" if doc_name else chunk.text
            context_parts.append(chunk_text)
            sources.append({
                "chunk_id": chunk.chunk_id,
                "document_id": chunk.document_id,
                "document_title": chunk.metadata.get("filename", chunk.document_id),
                "content_excerpt": chunk.text[:200],
                "score": round(chunk.score, 4),
                "low_confidence": True,
            })

    # Re-order passed chunks: group by document (most relevant doc first),
    # then sort each group by chunk_index so the LLM reads in document order.
    if context_parts and not low_confidence_fallback:
        # Rebuild from sources list (already populated above) using the scored chunks
        passed_chunks = [
            c for c in all_chunks
            if any(s["chunk_id"] == c.chunk_id for s in sources)
        ]
        # Sort by pre-Neo4j relevance score (TEI reranker / Qdrant cosine) so the
        # most semantically relevant chunk leads context, regardless of its position
        # in the document. chunk_index is a tiebreaker for chunks with equal scores.
        # We use _pre_neo4j_score instead of c.score because Neo4j boosted many chunks
        # to 1.0, erasing the fine-grained relevance signal from the reranker.
        # Primary: keyword overlap (surfaces exact-term matches when reranker off).
        # Secondary: raw semantic score before Neo4j 1.0 boost.
        # Tiebreaker: document order.
        kw_scores = {
            c.chunk_id: _keyword_overlap(normalized_question, c.text)
            for c in passed_chunks
        }
        passed_chunks.sort(
            key=lambda c: (
                -kw_scores.get(c.chunk_id, 0.0),
                -c.metadata.get("_pre_neo4j_score", c.score),
                c.metadata.get("chunk_index", 0),
            )
        )
        context_parts = []
        sources = []
        included_ids: set[str] = set()
        for chunk in passed_chunks[:15]:
            doc_name = chunk.metadata.get("filename", "")
            chunk_text = f"Fuente: {doc_name}\n{chunk.text}" if doc_name else chunk.text
            context_parts.append(chunk_text)
            sources.append({
                "chunk_id": chunk.chunk_id,
                "document_id": chunk.document_id,
                "document_title": chunk.metadata.get("filename", chunk.document_id),
                "content_excerpt": chunk.text[:200],
                "score": round(chunk.score, 4),
            })
            included_ids.add(chunk.chunk_id)

        # Semantic safety net: always include top-3 chunks by raw semantic score
        # not already in context. Prevents min_score from silently filtering the
        # most relevant chunk when it has no Neo4j entity link.
        by_semantic = sorted(
            all_chunks,
            key=lambda c: -c.metadata.get("_pre_neo4j_score", c.score),
        )
        extras_added = 0
        for chunk in by_semantic:
            if chunk.chunk_id in included_ids or extras_added >= 3:
                continue
            if len(context_parts) >= 18:
                break
            doc_name = chunk.metadata.get("filename", "")
            chunk_text = f"Fuente: {doc_name}\n{chunk.text}" if doc_name else chunk.text
            context_parts.append(chunk_text)
            sources.append({
                "chunk_id": chunk.chunk_id,
                "document_id": chunk.document_id,
                "document_title": chunk.metadata.get("filename", chunk.document_id),
                "content_excerpt": chunk.text[:200],
                "score": round(chunk.score, 4),
            })
            included_ids.add(chunk.chunk_id)
            extras_added += 1

    if not context_parts:
        logger.info(
            "no_relevant_context tenant_id=%s best_score=%.3f min_score=%.3f",
            tenant_id,
            max((c.score for c in all_chunks), default=0.0),
            min_score,
        )

    # ── Step 6: Choose model based on complexity ───────────────────────────────
    from services.groq_client import classify_complexity, complete

    complexity = classify_complexity(normalized_question, len(entity_names))

    # ── Step 7: Assemble system prompt and user message ───────────────────────
    # Architecture: system = personality + org context + anti-hallucination rules + retrieved context
    #               user   = bare question (isolated from instructions)
    #
    # Putting everything in system gives the LLM a single coherent ground truth.
    # The user turn is kept clean so conversation history stays readable.

    ambiguity_note = ""
    if is_ambiguous and second_label and intent_result:
        ambiguity_note = (
            f"La consulta del usuario podría referirse a '{intent_result.label}' "
            f"o a '{second_label}'. Considerá ambos contextos al responder."
        )

    if context_parts and low_confidence_fallback:
        context_block = (
            "ADVERTENCIA: La información disponible tiene baja relevancia para esta consulta. "
            "Usala solo si es claramente pertinente; si no, indicá que no encontraste información suficiente.\n\n"
            "Contexto disponible (baja confianza):\n" + "\n\n---\n\n".join(context_parts[:2])
        )
    elif context_parts:
        context_block = "Contexto disponible:\n" + "\n\n---\n\n".join(context_parts[:settings.max_context_chunks])
    else:
        context_block = "(No hay información documental disponible para esta consulta.)"

    system_parts = [personality.strip()]
    if bot_description:
        system_parts.append(f"=== SOBRE ESTA ORGANIZACIÓN ===\n{bot_description}")
    if bot_scope:
        system_parts.append(
            f"=== ALCANCE TEMÁTICO ===\n"
            f"Solo respondés sobre: {bot_scope}\n\n"
            f"Si la pregunta no tiene relación con estos temas, respondé exactamente:\n"
            f"\"Ese tema está fuera de mi área de conocimiento. "
            f"Solo puedo ayudarte con consultas sobre {bot_scope}. "
            f"¿Hay algo de eso en lo que pueda ayudarte?\"\n"
            f"No des información fuera del alcance aunque la conozcas."
        )
    if ambiguity_note:
        system_parts.append(ambiguity_note)
    system_parts.append(anti_hallucination.strip())
    system_parts.append(context_block)
    system_parts.append(f"Respondé en {language}.")

    system_prompt = "\n\n".join(system_parts)
    sanitized_q   = _sanitize_input(question)

    # Build message list with extractive history compression.
    # Last 6 turns → proper message objects (full fidelity).
    # Older turns (7-20) → compact summary block injected into system prompt.
    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
    if conversation_history:
        history = list(conversation_history)
        recent_n = settings.history_recent_turns
        recent = history[-recent_n:]
        older  = history[:-recent_n] if len(history) > recent_n else []

        if older:
            role_map_label = {"user": "Usuario", "bot": "Asistente"}
            summary_lines = []
            for sender, content in older:
                label = role_map_label.get(sender, sender)
                n = settings.history_summary_chars
                excerpt = content[:n].replace("\n", " ")
                if len(content) > n:
                    excerpt += "…"
                summary_lines.append(f"- {label}: {excerpt}")
            summary_block = (
                "=== CONTEXTO DE CONVERSACIÓN ANTERIOR ===\n"
                + "\n".join(summary_lines)
            )
            messages[0]["content"] = summary_block + "\n\n" + messages[0]["content"]

        role_map = {"user": "user", "bot": "assistant"}
        max_chars = settings.history_message_max_chars
        for sender, content in recent:
            role = role_map.get(sender)
            if role:
                messages.append({"role": role, "content": content[:max_chars]})

    messages.append({"role": "user", "content": sanitized_q})

    try:
        answer = await complete(
            messages=messages,
            complexity=complexity,
            tenant_id=tenant_id,
        )
    except (APITimeoutError, RateLimitError, APIError, httpx.HTTPError) as exc:
        # APITimeoutError/RateLimitError/APIError come from the `groq` SDK.
        # httpx.HTTPError covers OpenAI (called via raw httpx in groq_client.complete)
        # and includes TimeoutException, ConnectError, HTTPStatusError (429/500/etc).
        latency_ms = int(time.monotonic() * 1000) - start_ms
        logger.error("llm_failed_after_retries tenant_id=%s provider=%s error=%s latency_ms=%d",
                     tenant_id, settings.llm_provider, exc, latency_ms)
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
        "low_confidence": low_confidence_fallback,
    }

    # ── Step 7: Cache the response ────────────────────────────────────────────
    # Skip cache cuando la respuesta es el template "no tengo información" o
    # cuando NO hay sources Y la respuesta es larga (no es conversacional).
    # Cachear esos casos envenena el cache: una query que falló por contención
    # transitoria devolvería template-vacío a todas las queries similares
    # posteriores. Saludos cortos (<60 chars) sí se cachean.
    _no_info_marker = "No tengo información sobre ese tema en los documentos"
    is_no_info = _no_info_marker in (answer or "")
    is_long_no_sources = not sources and len(answer or "") > 60
    if not is_no_info and not is_long_no_sources:
        await _set_cache(question_hash, tenant_id, response)
        if settings.semantic_cache_enabled and query_vector is not None:
            asyncio.create_task(
                _update_semantic_cache(query_vector, question_hash, tenant_id)
            )
    else:
        logger.debug("cache_skip_empty_response tenant_id=%s", tenant_id)

    # ── Step 8: Log async (non-blocking) ──────────────────────────────────────
    asyncio.create_task(
        _log_usage_event_app(tenant_id, "query", 1)
    )
    asyncio.create_task(
        _log_query(
            question_hash=question_hash,
            question_text=question[:500],
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

    # ── Feature value metrics ─────────────────────────────────────────────────
    neo4j_contributed = bool(neo4j_records) and any(
        c.score == 1.0 and c.metadata.get("_pre_neo4j_score", -1) != 1.0
        for c in (qdrant_chunks or [])
    )
    logger.info(
        "query_complete tenant_id=%s latency_ms=%d complexity=%s intent=%s "
        "sources=%d neo4j_contributed=%s rewriter_expanded=%s low_confidence=%s",
        tenant_id, latency_ms, complexity, response["intent_label"],
        len(sources), neo4j_contributed, rewriter_expanded, low_confidence_fallback,
    )
    return response


_SHORT_QUERY_WORDS = 5   # queries with ≤ this many words are candidates for enrichment
_STOPWORDS = frozenset({
    "el", "la", "los", "las", "un", "una", "unos", "unas",
    "de", "del", "en", "a", "al", "y", "o", "que", "se",
    "es", "son", "hay", "para", "por", "con", "sin", "no",
    "sí", "si", "me", "te", "le", "nos", "lo", "también",
    "cuánto", "cuántos", "cuánta", "cuántas",
    "cómo", "cuál", "cuáles", "qué", "cuándo", "dónde",
    "quanto", "como", "cual", "cuales", "que", "cuando", "donde",
})


def _enrich_query_with_history(
    query: str,
    history: list[tuple[str, str]] | None,
) -> str:
    """Return a retrieval-enriched version of a short/elliptical query.

    If the query is short (≤ 5 words) and there is conversation history,
    extract content keywords from the last user turn and last bot turn and
    append them so the embedding captures the conversational context.

    Examples:
        "¿y para el primer año?" + history about vacaciones
        → "¿y para el primer año? vacaciones días hábiles"

        "¿cuánto?" + history about salario básico
        → "¿cuánto? salario básico"

    The original `query` is returned unchanged if:
        - it has more than 5 words (already specific enough)
        - there is no history
        - keyword extraction yields nothing new
    """
    if not history:
        return query

    words = query.split()
    if len(words) > _SHORT_QUERY_WORDS:
        return query

    # Collect keywords from the last user question + last bot answer
    keyword_tokens: list[str] = []

    last_user = next(
        (content for role, content in reversed(history) if role == "user"),
        None,
    )
    last_bot = next(
        (content for role, content in reversed(history) if role == "bot"),
        None,
    )

    for text in filter(None, [last_user, last_bot]):
        # Take the first 30 words, drop stopwords and punctuation
        for token in text.split()[:30]:
            clean = token.strip("¿?¡!.,;:\"'()[]").lower()
            if len(clean) > 3 and clean not in _STOPWORDS:
                keyword_tokens.append(clean)

    if not keyword_tokens:
        return query

    # Deduplicate preserving order, skip tokens already in the query
    query_lower = query.lower()
    seen: set[str] = set()
    extras: list[str] = []
    for tok in keyword_tokens:
        if tok not in seen and tok not in query_lower:
            seen.add(tok)
            extras.append(tok)
        if len(extras) >= 6:   # cap at 6 extra tokens
            break

    if not extras:
        return query

    return query + " " + " ".join(extras)


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
    question_text: str,
    tenant_id: str,
    user_id: str | None,
    intent_label: str | None,
    intent_confidence: float | None,
    latency_ms: int,
    from_cache: bool = False,
) -> None:
    """Persist query log to consultas_log and trigger auto-learning when applicable.

    Auto-learning (per CLAUDE.md):
      - confidence >= 95% AND intent exists → add to intencion_ejemplos (cap 30%)
      - if cap exceeded → set auto_learning_blocked=TRUE instead
    Non-fatal on failure.
    """
    try:
        from core.database import get_pg_session
        from sqlalchemy import text

        auto_learning_blocked = False

        async with get_pg_session(tenant_id) as session:
            # ── Auto-learning: high-confidence non-cache queries ──────────────
            if (
                intent_label
                and intent_confidence is not None
                and intent_confidence >= settings.intent_confidence_high
                and not from_cache
                and question_text
            ):
                auto_learning_blocked = await _maybe_auto_learn(
                    session, tenant_id, intent_label, question_hash, question_text
                )

            await session.execute(
                text(
                    "INSERT INTO consultas_log "
                    "(user_id, question_hash, question_text, intent_label, intent_confidence, "
                    "latency_ms, from_cache, auto_learning_blocked) "
                    "VALUES (:user_id, :question_hash, :question_text, :intent_label, "
                    ":intent_confidence, :latency_ms, :from_cache, :auto_learning_blocked)"
                ),
                {
                    "user_id": user_id,
                    "question_hash": question_hash,
                    "question_text": question_text,
                    "intent_label": intent_label,
                    "intent_confidence": intent_confidence,
                    "latency_ms": latency_ms,
                    "from_cache": from_cache,
                    "auto_learning_blocked": auto_learning_blocked,
                },
            )
    except Exception as exc:
        logger.warning("query_log_failed tenant_id=%s error=%s", tenant_id, exc)


async def _maybe_auto_learn(
    session,
    tenant_id: str,
    intent_label: str,
    question_hash: str,
    question_text: str,
) -> bool:
    """Add example to intencion_ejemplos if under the 30% auto-learn cap.

    Returns True if the cap was exceeded (auto_learning_blocked).
    """
    from sqlalchemy import text

    # Fetch intention stats: example_count, auto_learned_count
    row = await session.execute(
        text(
            "SELECT id, example_count, auto_learned_count "
            "FROM intenciones WHERE label = :label AND is_active = TRUE"
        ),
        {"label": intent_label},
    )
    intention = row.mappings().fetchone()
    if not intention:
        return False  # Intention doesn't exist yet — skip

    example_count = intention["example_count"] or 0
    auto_learned = intention["auto_learned_count"] or 0
    cap = settings.intent_auto_learn_cap  # 0.30

    # Check if this exact query_hash already exists as an example
    dup = await session.execute(
        text(
            "SELECT 1 FROM intencion_ejemplos "
            "WHERE intencion_id = :iid AND question_hash = :qh LIMIT 1"
        ),
        {"iid": str(intention["id"]), "qh": question_hash},
    )
    if dup.fetchone():
        return False  # Already learned — not blocked

    # Enforce 30% cap: auto_learned / (example_count + auto_learned) <= 30%
    total = example_count + auto_learned
    if total > 0 and auto_learned / total >= cap:
        logger.debug(
            "auto_learn_cap_exceeded tenant=%s label=%s auto=%d total=%d",
            tenant_id, intent_label, auto_learned, total,
        )
        return True  # Blocked — caller sets auto_learning_blocked=TRUE in log

    # Under cap — insert example
    import uuid as _uuid
    await session.execute(
        text(
            "INSERT INTO intencion_ejemplos "
            "(id, intencion_id, question_hash, question_text, is_auto_learned, is_approved) "
            "VALUES (:id, :iid, :qh, :qt, TRUE, TRUE)"
        ),
        {
            "id": str(_uuid.uuid4()),
            "iid": str(intention["id"]),
            "qh": question_hash,
            "qt": question_text,
        },
    )
    # Increment auto_learned_count
    await session.execute(
        text(
            "UPDATE intenciones "
            "SET auto_learned_count = auto_learned_count + 1, updated_at = NOW() "
            "WHERE id = :id"
        ),
        {"id": str(intention["id"])},
    )
    logger.debug(
        "auto_learned tenant=%s label=%s auto=%d total=%d",
        tenant_id, intent_label, auto_learned + 1, total + 1,
    )
    return False


async def _log_usage_event_app(tenant_id: str, event_type: str, value: int) -> None:
    """Log a usage event using the app's shared PG connection pool (not NullPool)."""
    try:
        from core.database import get_pg_session
        from sqlalchemy import text
        async with get_pg_session() as session:  # global schema — no tenant_id
            await session.execute(
                text(
                    "INSERT INTO usage_events (tenant_id, event_type, value) "
                    "VALUES (:tenant_id, :event_type, :value)"
                ),
                {"tenant_id": tenant_id, "event_type": event_type, "value": value},
            )
    except Exception as exc:
        logger.warning("usage_event_log_failed tenant_id=%s error=%s", tenant_id, exc)


async def _empty_list() -> list:
    return []


async def _get_active_template(tenant_id: str) -> str | None:
    """Return the active personality prompt for this tenant, Redis-cached for 5 min.

    Returns the contenido of the active assigned personality template, or None if
    no personality is assigned and active. Caller must handle the None case.
    """
    redis = get_redis_cache()
    cache_key = f"{tenant_id}:active_template"

    try:
        raw = await redis.get(cache_key)
        if raw is not None:
            return raw.decode() if raw else None
    except Exception:
        pass

    try:
        from core.database import get_pg_session
        from sqlalchemy import text
        async with get_pg_session(None) as session:
            result = await session.execute(text("""
                SELECT t.contenido
                FROM tenant_prompt_assignments a
                JOIN system_prompt_templates t ON t.id = a.template_id
                WHERE a.tenant_id = :tid AND a.is_active = TRUE
                  AND t.is_active = TRUE AND t.is_system = FALSE
                LIMIT 1
            """), {"tid": tenant_id})
            row = result.fetchone()
    except Exception as exc:
        logger.warning("active_template_load_failed tenant_id=%s error=%s", tenant_id, exc)
        return None

    contenido = row[0] if row else None
    try:
        await redis.setex(cache_key, 300, contenido or "")
    except Exception:
        pass

    return contenido


# Emergency fallback — only used when "Reglas anti-alucinación" DB template is unreachable.
# Kept in sync with migration 006_prompts_v2.py.
_FALLBACK_ANTI_HALLUCINATION = (
    "REGLAS DE RESPUESTA — se aplican sin excepción en cada mensaje:\n\n"
    "1. CONTEXTO + HISTORIAL DE LA CONVERSACIÓN: Tus fuentes válidas son DOS y solo dos: "
    "(a) el bloque 'Contexto disponible' del turno actual, y (b) los datos que VOS COMO ASISTENTE "
    "ya mencionaste en turnos anteriores de ESTA conversación. La conversación es continua — "
    "si en un turno anterior dijiste un dato concreto, podés volver a usarlo. "
    "NUNCA uses tu conocimiento general / entrenamiento previo: si un dato no aparece en (a) ni (b), "
    "no es una fuente válida.\n\n"
    "2. COINCIDENCIA SEMÁNTICA: Aceptá sinónimos cuando el referente sea claramente el mismo "
    "(ej: empleado/trabajador, sucursal/sede). No rechaces información válida por diferencia de palabras.\n\n"
    "3. SIN INFERENCIAS: El dato debe estar explícitamente presente en el Contexto o en mensajes previos "
    "tuyos de esta conversación. No lo construyas combinando fragmentos ni completando con lógica.\n\n"
    "4. INFORMACIÓN PARCIAL: Si encontrás datos relevantes pero incompletos, respondé con lo que tenés "
    "y aclará qué parte no encontraste. No inventes el resto.\n\n"
    "5. DOCUMENTOS EN CONFLICTO: Si dos fuentes se contradicen, mencioná ambas versiones y "
    "recomendá consultar con el área responsable.\n\n"
    "6. SIN INFORMACIÓN: Si el dato no aparece NI en el Contexto NI en algún mensaje anterior tuyo "
    "en esta conversación, respondé: "
    "'No encontré esa información en los documentos disponibles. "
    "Te recomiendo consultar directamente con el área correspondiente.'\n\n"
    "7. NUNCA INVENTES: Nombres, fechas, números, montos, contactos, artículos o pasos de proceso "
    "deben estar en el Contexto o en mensajes previos tuyos. Inventar un dato concreto es el error más grave."
)


_SYSTEM_TEMPLATE_CACHE_TTL = 300  # 5 min


async def _get_system_template(nombre: str) -> str | None:
    """Return contenido of a system template by exact nombre, Redis-cached for 5 min.

    Used by ingest and clustering to read their prompts from DB instead of hardcoded defaults.
    Returns None if not found — callers fall back to their own hardcoded emergency default.
    """
    redis = get_redis_cache()
    cache_key = f"platform:system_template:{nombre}"

    try:
        raw = await redis.get(cache_key)
        if raw is not None:
            return raw.decode() or None
    except Exception:
        pass

    contenido: str | None = None
    try:
        from core.database import get_pg_session
        from sqlalchemy import text
        async with get_pg_session(None) as session:
            result = await session.execute(text("""
                SELECT contenido FROM system_prompt_templates
                WHERE nombre = :nombre AND is_system = TRUE AND is_active = TRUE
                LIMIT 1
            """), {"nombre": nombre})
            row = result.fetchone()
            contenido = row[0] if row else None
    except Exception as exc:
        logger.warning("system_template_load_failed nombre=%s error=%s", nombre, exc)

    try:
        await redis.setex(cache_key, _SYSTEM_TEMPLATE_CACHE_TTL, contenido or "")
    except Exception:
        pass

    return contenido


async def _check_semantic_cache(query_vector: list[float], tenant_id: str) -> dict | None:
    """Search the tenant's query-cache Qdrant collection for a semantically similar question.

    Returns the Redis-cached response for the nearest match, or None on miss/error.
    Similarity threshold is settings.semantic_cache_threshold (default 0.93).
    """
    from core.database import get_qdrant_client
    collection = f"{tenant_id}_query_cache"
    try:
        qdrant = get_qdrant_client()
        results = await qdrant.search(
            collection_name=collection,
            query_vector=query_vector,
            limit=1,
            score_threshold=settings.semantic_cache_threshold,
            with_payload=True,
        )
        if not results:
            return None
        matched_hash = results[0].payload.get("question_hash")
        if not matched_hash:
            return None
        logger.debug(
            "semantic_cache_candidate hash=%s score=%.4f",
            matched_hash, results[0].score,
        )
        return await _check_cache(matched_hash, tenant_id)
    except Exception as exc:
        logger.debug("semantic_cache_check_failed tenant_id=%s error=%s", tenant_id, exc)
        return None


async def _update_semantic_cache(
    query_vector: list[float],
    question_hash: str,
    tenant_id: str,
) -> None:
    """Upsert the query embedding into the tenant's query-cache Qdrant collection.

    Creates the collection lazily on first write (1024 dims, cosine distance).
    Silently swallows errors — semantic cache is best-effort.
    """
    import time
    import uuid
    from core.database import get_qdrant_client
    from qdrant_client.models import Distance, PointStruct, VectorParams

    collection = f"{tenant_id}_query_cache"
    qdrant = get_qdrant_client()

    try:
        await qdrant.upsert(
            collection_name=collection,
            points=[
                PointStruct(
                    id=str(uuid.uuid5(uuid.NAMESPACE_DNS, question_hash)),
                    vector=query_vector,
                    payload={"question_hash": question_hash, "cached_at": int(time.time())},
                )
            ],
        )
    except Exception as exc:
        # Collection may not exist yet — create it and retry once
        if "doesn't exist" in str(exc) or "Not found" in str(exc):
            try:
                await qdrant.create_collection(
                    collection_name=collection,
                    vectors_config=VectorParams(size=1024, distance=Distance.COSINE),
                )
                await qdrant.upsert(
                    collection_name=collection,
                    points=[
                        PointStruct(
                            id=str(uuid.uuid5(uuid.NAMESPACE_DNS, question_hash)),
                            vector=query_vector,
                            payload={"question_hash": question_hash, "cached_at": int(time.time())},
                        )
                    ],
                )
            except Exception as exc2:
                logger.warning("semantic_cache_write_failed tenant_id=%s error=%s", tenant_id, exc2)
        else:
            logger.debug("semantic_cache_upsert_failed tenant_id=%s error=%s", tenant_id, exc)


async def _get_tenant_config(tenant_id: str) -> dict:
    """Load bot config for the tenant. Redis-cached for 5 minutes."""
    redis = get_redis_cache()
    cache_key = f"{tenant_id}:bot_config"

    try:
        raw = await redis.get(cache_key)
        if raw:
            return json.loads(raw)
    except Exception:
        pass

    try:
        from core.database import get_pg_session
        from sqlalchemy import text
        # tenants table is in the global (public) schema
        async with get_pg_session() as session:
            result = await session.execute(
                text(
                    "SELECT bot_description, bot_scope, min_retrieval_score, "
                    "prompt_quality_gate, prompt_cluster_label "
                    "FROM tenants WHERE id = :tid"
                ),
                {"tid": tenant_id},
            )
            row = result.mappings().fetchone()
    except Exception as exc:
        logger.warning("tenant_config_load_failed tenant_id=%s error=%s", tenant_id, exc)
        row = None

    config = {
        "bot_description":      row["bot_description"]      if row else None,
        "bot_scope":            row["bot_scope"]             if row else None,
        "min_retrieval_score":  float(row["min_retrieval_score"]) if row and row["min_retrieval_score"] is not None else 0.55,
        "prompt_quality_gate":  row["prompt_quality_gate"]   if row else None,
        "prompt_cluster_label": row["prompt_cluster_label"]  if row else None,
    }

    try:
        await redis.setex(cache_key, 300, json.dumps(config))  # 5-min TTL
    except Exception:
        pass

    return config
