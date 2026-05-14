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
        # Log cache hits too — needed for accurate usage billing and HDBSCAN training data.
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

    # Detect ambiguity from classifier result
    is_ambiguous = intent_result is not None and getattr(intent_result, "is_ambiguous", False)
    second_label = getattr(intent_result, "second_label", None) if intent_result else None

    retrieval_task = retrieve(question, tenant_id)
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
        # Boost already-retrieved chunks that Neo4j confirms contain named entities
        qdrant_list = list(qdrant_chunks or [])
        for chunk in qdrant_list:
            if chunk.chunk_id in neo4j_chunk_ids:
                chunk.score = 1.0
        # Fetch chunks that Qdrant didn't retrieve at all
        existing_ids = {c.chunk_id for c in qdrant_list}
        new_ids = [cid for cid in neo4j_chunk_ids if cid not in existing_ids]
        if new_ids:
            entity_chunks = await retrieve_by_ids(new_ids, tenant_id)
            qdrant_list.extend(entity_chunks)
        if neo4j_chunk_ids:
            logger.info(
                "neo4j_entity_boost tenant_id=%s entity_chunk_ids=%d new_fetched=%d",
                tenant_id, len(neo4j_chunk_ids), len(new_ids),
            )
        qdrant_chunks = qdrant_list

    # ── Step 4: Load tenant bot config + active prompt template (both cached) ──
    tenant_config = await _get_tenant_config(tenant_id)
    min_score: float = tenant_config.get("min_retrieval_score", 0.77)
    bot_scope: str   = tenant_config.get("bot_scope") or ""

    # Active template overrides prompt_query if set
    active_template = await _get_active_template(tenant_id)
    prompt_query: str | None = active_template or tenant_config.get("prompt_query") or None

    # ── Step 5: Build context — drop chunks below relevance threshold ──────────
    context_parts: list[str] = []
    sources: list[dict] = []

    for chunk in (qdrant_chunks or []):
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

    # No relevant context found — let the LLM decide how to respond.
    # It may be a greeting, thanks, or genuine no-info case; the prompt handles each.
    if not context_parts:
        logger.info(
            "no_relevant_context tenant_id=%s best_score=%.3f min_score=%.3f",
            tenant_id,
            max((c.score for c in (qdrant_chunks or [])), default=0.0),
            min_score,
        )
        context_parts = []  # LLM will use empty context and decide via MODO CONVERSACIONAL

    context = "\n\n---\n\n".join(context_parts[:5])  # Top 5 chunks in context

    # ── Step 6: Choose model based on complexity ───────────────────────────────
    from services.groq_client import QueryComplexity, classify_complexity, complete

    entity_count = len(entity_names)
    complexity = classify_complexity(question, entity_count)

    # ── Step 7: Generate answer with isolated user input ──────────────────────
    ambiguity_note = ""
    if is_ambiguous and second_label and intent_result:
        ambiguity_note = (
            f"\nLa consulta del usuario podría referirse a '{intent_result.label}' "
            f"o a '{second_label}'. Considerá ambos contextos al responder."
        )

    if prompt_query:
        scope_rule = f"\nAlcance: {bot_scope}" if bot_scope else ""
        base_prompt = prompt_query.strip() + scope_rule
    else:
        # No prompt available at all — last resort bare instruction
        base_prompt = "Respondé únicamente con información del contexto proporcionado."

    system_prompt = f"{base_prompt}{ambiguity_note}\nResponde en {language}."
    # User input is in a separate message — never interpolated into the system prompt
    ctx_block = context if context else "(vacío — sin documentos relevantes para esta consulta)"
    user_message = (
        f"INSTRUCCION CRITICA — ANTES DE RESPONDER VERIFICÁ ESTO:\n"
        f"1. La respuesta debe aparecer LITERALMENTE en el Contexto de abajo. No inferir, no completar, no agregar datos propios.\n"
        f"2. Si el dato específico que pregunta el usuario (ej: días de licencia por paternidad, monto de reintegro, etc.) "
        f"no aparece TEXTUALMENTE en el Contexto, respondé: "
        f"'No encontré esa información en los documentos de la organización. "
        f"Te sugiero consultar directamente con el área correspondiente o con Recursos Humanos.'\n"
        f"3. Que el Contexto mencione un tema RELACIONADO (ej: licencias en general) NO autoriza a agregar datos específicos "
        f"que no estén escritos. Solo usá lo que está textualmente.\n\n"
        f"Contexto:\n{ctx_block}\n\nPregunta del usuario: {_sanitize_input(question)}"
    )

    # Build message list: system + up to 6 prior turns + current user message
    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
    if conversation_history:
        role_map = {"user": "user", "bot": "assistant"}
        for sender, content in conversation_history[-6:]:
            role = role_map.get(sender)
            if role:
                messages.append({"role": role, "content": content[:500]})
    messages.append({"role": "user", "content": user_message})

    try:
        answer = await complete(
            messages=messages,
            complexity=complexity,
            tenant_id=tenant_id,
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
    """Return the prompt for this tenant, Redis-cached for 5 min.

    Priority:
      1. Active template assigned to the tenant
      2. Global default template (is_default=TRUE in system_prompt_templates)
      3. None → caller falls back to tenant's prompt_query config field
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
            # 1. Tenant-specific assignment
            result = await session.execute(text("""
                SELECT t.contenido
                FROM tenant_prompt_assignments a
                JOIN system_prompt_templates t ON t.id = a.template_id
                WHERE a.tenant_id = :tid AND a.is_active = TRUE AND t.is_active = TRUE
                LIMIT 1
            """), {"tid": tenant_id})
            row = result.fetchone()

            # 2. Global default (no assignment for this tenant)
            if not row:
                result = await session.execute(text("""
                    SELECT contenido FROM system_prompt_templates
                    WHERE is_default = TRUE AND is_active = TRUE
                    LIMIT 1
                """))
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
                    "prompt_query, prompt_quality_gate, prompt_cluster_label "
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
        "min_retrieval_score":  float(row["min_retrieval_score"]) if row and row["min_retrieval_score"] is not None else 0.73,
        "prompt_query":         row["prompt_query"]          if row else None,
        "prompt_quality_gate":  row["prompt_quality_gate"]   if row else None,
        "prompt_cluster_label": row["prompt_cluster_label"]  if row else None,
    }

    try:
        await redis.setex(cache_key, 300, json.dumps(config))  # 5-min TTL
    except Exception:
        pass

    return config
