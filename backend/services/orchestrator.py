"""Query orchestrator: decides model, data sources, and assembles the final response.

Execution flow:
  1. Check Redis cache → return immediately on hit
  2. Retrieve from Qdrant (always) + Neo4j (only if entities found)
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

async def _try_tool_pick(question: str, tool_schemas: list[dict], tenant_id: str) -> dict | None:
    """Decisión de tool SOLA (para la rama hard_fallback del modo unificado).

    Usa el prompt del router de conectores; el texto que genere el modelo se
    descarta (solo importa si eligió tool) → sin riesgo de alucinación. Fail-open
    a None ante cualquier error: el fallback determinístico sigue su curso.
    """
    try:
        from services.groq_client import select_tool
        from services.prompt_registry import get_text
        msgs = [
            {"role": "system", "content": await get_text("tool_router")},
            {"role": "user", "content": (question or "")[:1000]},
        ]
        return await select_tool(msgs, tool_schemas, tenant_id=tenant_id)
    except Exception as exc:
        logger.warning("tool_pick_on_fallback_failed tenant_id=%s error=%s", tenant_id, exc)
        return None


async def handle_query(
    question: str,
    tenant_id: str,
    user_id: str | None = None,
    language: str = "es",
    conversation_history: list[tuple[str, str]] | None = None,
    tool_schemas: list[dict] | None = None,
    tool_domains: list[str] | None = None,
) -> dict[str, Any]:
    """Main entry point for a user query.

    Args:
        question: Raw user question (will be sanitized before LLM use).
        tenant_id: Tenant scope.
        user_id: Optional user ID for audit logging.
        language: Response language hint.
        tool_schemas: Function schemas de conectores (modo unificado 2b). Si el LLM
            elige una tool en vez de responder, se devuelve {"tool_call": {...}}
            con answer=None y el CALLER (capa widget) la ejecuta — por acá pasa la
            DECISIÓN, nunca el resultado de la tool (datos personales no entran al
            cache compartido). Nota: los hits de cache exacto/semántico se sirven
            ANTES de considerar tools; una respuesta RAG cacheada previa puede
            opacar una consulta de tool similar (edge aceptado: intellix registra
            0 hits históricos; revisar si aparece en telemetría).

    Returns:
        Dict with keys: answer, sources, intent_label, intent_confidence, from_cache,
        latency_ms — y opcionalmente tool_call (solo modo unificado).
    """
    from core.tracing import get_tracer
    tracer = get_tracer()

    start_ms = int(time.monotonic() * 1000)

    # ── Step 0: Query normalization (acronym expansion) ────────────────────────
    # Normalizamos PRIMERO para que la clave de cache, el retrieval y los embeddings
    # usen la forma canónica: "RRHH" y "Recursos Humanos" comparten cache. El texto
    # original se conserva para mostrar.
    from services.query_normalizer import normalize_query
    normalized_question = normalize_query(question)
    if normalized_question != question:
        logger.debug(
            "query_normalized original=%r normalized=%r",
            question[:80], normalized_question[:80],
        )

    # La clave de cache se computa sobre la query NORMALIZADA. Antes se hacía sobre la
    # cruda, una línea ANTES de normalizar, así que las siglas nunca compartían cache.
    question_hash = _hash_question(normalized_question)

    with tracer.start_as_current_span("query.handle") as span:
        span.set_attribute("tenant_id", tenant_id)
        span.set_attribute("question_hash", question_hash)

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
        # La consulta servida desde cache TAMBIÉN consume cuota y cuenta en las
        # métricas de "consultas del mes" (antes solo se registraba el usage_event en
        # el camino que tocaba el LLM, así que la cuota subcontaba el tráfico real).
        asyncio.ensure_future(_log_usage_event_app(tenant_id, "query", 1))
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

    # ── Lanzamiento temprano del rewriter (paralelización 2026-08-17) ──────────
    # La reescritura LLM (~0,5-1s) no depende del embedding ni de la búsqueda —
    # pero corría DESPUÉS del embedding y ANTES de la búsqueda, en fila (diagnóstico
    # 13/08: tres esperas de red encadenadas, 2,8-3,9s). Arranca acá y se solapa
    # con el cache semántico y con la búsqueda de la consulta original. Si el
    # cache semántico pega, se cancela (costo: una llamada barata desperdiciada
    # en un hit — hoy los hits semánticos son excepcionales en prod).
    tenant_config = await _get_tenant_config(tenant_id)  # Redis-cached, <5ms
    bot_description: str = tenant_config.get("bot_description") or ""
    rewrite_task: asyncio.Task | None = None
    if settings.query_rewriting_enabled:
        from services.query_rewriter import rewrite_query
        rewrite_task = asyncio.create_task(rewrite_query(
            normalized_question,
            conversation_history,
            bot_description=bot_description or None,
        ))

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
                if rewrite_task is not None:
                    rewrite_task.cancel()
                latency_ms = int(time.monotonic() * 1000) - start_ms
                logger.info("semantic_cache_hit tenant_id=%s latency_ms=%d", tenant_id, latency_ms)
                from core.metrics import CACHE_HITS_TOTAL, QUERIES_TOTAL, QUERY_DURATION
                CACHE_HITS_TOTAL.labels(tenant_id=tenant_id).inc()
                QUERIES_TOTAL.labels(tenant_id=tenant_id, complexity="cached", from_cache="true").inc()
                QUERY_DURATION.labels(tenant_id=tenant_id, complexity="cached").observe(latency_ms)
                sem_cached["from_cache"] = True
                sem_cached["latency_ms"] = latency_ms
                asyncio.ensure_future(_log_usage_event_app(tenant_id, "query", 1))
                asyncio.ensure_future(_log_query(
                    tenant_id=tenant_id,
                    user_id=user_id,
                    question_text=question[:500],
                    question_hash=question_hash,
                    intent_label=None,
                    intent_confidence=None,
                    latency_ms=latency_ms,
                    from_cache=True,
                ))
                return sem_cached

    # ── Step 2: (eliminado) clasificación de intenciones ──────────────────────
    # El clasificador coseno se quitó del camino de consulta (decisión 2026-07-21:
    # las intenciones no aportan al RAG y el ruteo de tools ya es por LLM
    # tool-calling). intent_label/intent_confidence quedan como None en la
    # respuesta y en consultas_log para no romper contratos existentes.

    # ── Step 3: Retrieval con transformación de la consulta ────────────────────
    # UN SOLO dueño de la contextualización: el rewriter LLM recibe la consulta
    # LIMPIA + historial y decide qué contexto aplica (sabe distinguir un cambio
    # de tema). El enriquecedor de keywords (_enrich_query_with_history) queda
    # SOLO como red de seguridad cuando el rewriter no está (flag off / LLM caído):
    # es ciego al cambio de tema — encadenarlo ANTES del rewriter arrastraba el
    # tema anterior a la consulta y traía el chunk equivocado (caso real 13/08,
    # reproducido en la suite: conv_02_t2/t3, conv_07, conv_08).
    #
    # Paralelización (2026-08-17): la búsqueda con la consulta original NO espera
    # al rewriter — la original se busca SIEMPRE tal cual (ver nota abajo), así que
    # arranca de inmediato; cuando el rewriter devuelve su variante, se busca solo
    # esa y ambos rankings se fusionan con la misma RRF de retrieve_multi_query.
    # Si el rewriter falla o tarda, la búsqueda original ya está hecha: la
    # resiliencia mejora respecto del camino en fila.
    from services.retrieval import retrieve, fuse_rankings

    # Pregunta contra la que se evalúa el trust gate (léxico + juez). Por
    # defecto la normalizada; si el rewriter produjo una versión autosuficiente,
    # se reemplaza más abajo — el gate debe juzgar lo que el retrieval sirvió.
    judge_question = normalized_question

    if rewrite_task is not None:
        orig_task = asyncio.create_task(retrieve(normalized_question, tenant_id))
        try:
            rewrite_result = await rewrite_task
        except Exception as exc:  # noqa: BLE001 — cancelación/errores no cubiertos por el rewriter
            logger.warning("query_rewrite_task_failed error=%s", exc)
            from services.query_rewriter import RewriteResult
            rewrite_result = RewriteResult(main=normalized_question, variants=[], fallback=True)

        # SIEMPRE la query original primero. El rewriter a veces la reescribe a algo
        # más largo/ruidoso (ej. le agrega el nombre completo de la organización) que
        # DILUYE el embedding y degrada el retrieval: "¿qué cardiólogos atienden?"
        # (cosine 0.52, perfecto) se volvía "¿qué cardiólogos... en la Mutual Provincial
        # de Luz y Fuerza...?" (0.03, basura). La original directa suele ser la que mejor
        # matchea; el RRF combina su resultado con el de las variantes. Robustez genérica.
        _orig = normalized_question.strip().lower()
        extra_queries = [
            q for q in rewrite_result.all_queries if q.strip().lower() != _orig
        ]
        if rewrite_result.fallback:
            # LLM caído/timeout → red de seguridad: keywords del historial como
            # búsqueda ADICIONAL (la original limpia ya está corriendo igual).
            transform_path = "enricher_fallback"
            _enriched = _enrich_query_with_history(normalized_question, conversation_history)
            extra_queries = [_enriched] if _enriched.strip().lower() != _orig else []
        else:
            transform_path = "skipped" if rewrite_result.skipped else "rewriter"
        rewriter_expanded = not rewrite_result.skipped and not rewrite_result.fallback and bool(extra_queries)
        # El trust gate debe juzgar la pregunta AUTOSUFICIENTE, no la elíptica:
        # con "y los sábados atienden?" el juez no puede conectar los fragmentos
        # de dermatología aunque el retrieval (que sí buscó la reescrita) los
        # haya traído — rechazaba con "no se menciona sábados" (caso real
        # 2026-08-22). La reescrita es la pregunta que el retrieval sirvió.
        if rewriter_expanded and rewrite_result.main.strip():
            judge_question = rewrite_result.main.strip()
        if rewrite_result.skipped:
            logger.debug("query_rewrite_skipped_heuristic query=%r", normalized_question[:80])
        elif rewrite_result.used_cache:
            logger.debug("query_rewrite_used_cache n_extra=%d", len(extra_queries))
        elif rewrite_result.fallback:
            logger.warning("query_rewrite_fallback_to_original query=%r", normalized_question[:80])
        else:
            logger.info(
                "query_rewrite_applied original=%r main=%r variants=%d expanded=%s",
                normalized_question[:60], rewrite_result.main[:80],
                len(rewrite_result.variants), rewriter_expanded,
            )

        if extra_queries:
            # Variantes con top_k reducido — misma proporción que usaba
            # retrieve_multi_query para las sub-queries.
            _n = 1 + len(extra_queries)
            _sub_top_k = max(settings.retrieval_top_k // _n + 10, 20)
            _sub_rerank = max(settings.rerank_top_k // _n + 5, 10)
            results = await asyncio.gather(
                orig_task,
                *(retrieve(q, tenant_id, top_k=_sub_top_k, rerank_top_k=_sub_rerank)
                  for q in extra_queries),
                return_exceptions=True,
            )
            rankings = []
            for idx, r in enumerate(results):
                if isinstance(r, Exception):
                    logger.warning("retrieve_branch_failed idx=%d error=%s", idx, r)
                    continue
                rankings.append(r)
            qdrant_chunks = fuse_rankings(
                rankings, top_k=max(settings.rerank_top_k, 20),
            )[:settings.rerank_top_k]
            if not rankings:
                logger.error("retrieval_failed tenant_id=%s error=all_branches_failed", tenant_id)
        else:
            try:
                qdrant_chunks = await orig_task
            except Exception as exc:  # noqa: BLE001 — sin retrieval igual respondemos (degradado)
                logger.error("retrieval_failed tenant_id=%s error=%s", tenant_id, exc)
                qdrant_chunks = []
    else:
        # Sin rewriter, el enriquecedor es la única contextualización disponible.
        retrieval_question = _enrich_query_with_history(normalized_question, conversation_history)
        transform_path = "enricher_only" if retrieval_question != normalized_question else "none"
        rewriter_expanded = False
        try:
            qdrant_chunks = await retrieve(retrieval_question, tenant_id)
        except Exception as exc:  # noqa: BLE001 — sin retrieval igual respondemos (degradado)
            logger.error("retrieval_failed tenant_id=%s error=%s", tenant_id, exc)
            qdrant_chunks = []

    # Instrumentación del camino elegido (auditable en prod, estilo trust_gate).
    logger.info(
        "query_transform tenant_id=%s path=%s has_history=%s q_words=%d",
        tenant_id, transform_path, bool(conversation_history), len(normalized_question.split()),
    )

    # ── Step 4: Load remaining configs + personality template ────────────────────
    # tenant_config already loaded above (before rewriter). Extract remaining fields.
    min_score: float = tenant_config.get("min_retrieval_score", 0.55)
    bot_scope: str   = tenant_config.get("bot_scope") or ""

    # Módulos de prompt por tema: el texto default vive en prompt_registry
    # (código); la DB solo aporta overrides del super-admin si existen.
    from services.prompt_registry import BUILDER_SLUGS, get_texts

    personality, module_templates = await asyncio.gather(
        _get_active_template(tenant_id),
        get_texts(BUILDER_SLUGS),
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

    # ── Step 5: Build context — drop chunks below relevance threshold ──────────
    context_parts: list[str] = []
    sources: list[dict] = []
    low_confidence_fallback = False
    hard_fallback = False   # corte duro anti-alucinación: best_score < piso → no LLM

    all_chunks = list(qdrant_chunks or [])

    for chunk in all_chunks:
        # Relevancia robusta a la escala del score. Usamos el MÁXIMO entre el score
        # post-pipeline (RRF/reranker, que puede quedar en escala chica ~0.01 si el
        # reranker no corrió) y el cosine original de Qdrant (escala estable ~0.5+).
        # Sin esto, un chunk semánticamente muy relevante (cosine 0.6) era descartado
        # por tener RRF 0.016 < min_score 0.55 — esto rompía listados/enumeraciones
        # donde cada miembro de la categoría tiene cosine alto pero RRF bajo, dejando
        # respuestas incompletas o falsos "no encontré". Genérico para cualquier tenant.
        relevance = max(chunk.score, chunk.metadata.get("_cosine_score", 0.0))
        if relevance < min_score:
            logger.debug(
                "chunk_below_threshold chunk_id=%s score=%.3f cosine=%.3f min=%.3f",
                chunk.chunk_id, chunk.score, chunk.metadata.get("_cosine_score", 0.0), min_score,
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

    # Fallback de dos bandas cuando nada superó el umbral pero hay resultados:
    #  - best_score < piso (hard_fallback_min_score): material demasiado irrelevante
    #    → CORTE DURO. No se manda al LLM; se responde un mensaje determinístico de
    #    "no info" (cero alucinación). Esto ataca el 13.7% de alucinación del report.
    #  - piso ≤ best_score < min_score: confianza media → incluir top-N con
    #    advertencia para una respuesta cauta (comportamiento previo).
    if not context_parts and all_chunks:
        best_score = all_chunks[0].score
        if best_score < settings.hard_fallback_min_score:
            hard_fallback = True
            logger.info(
                "hard_fallback tenant_id=%s best_score=%.3f piso=%.3f",
                tenant_id, best_score, settings.hard_fallback_min_score,
            )
        else:
            low_confidence_fallback = True
            logger.info(
                "low_confidence_fallback tenant_id=%s best_score=%.3f min_score=%.3f",
                tenant_id, best_score, min_score,
            )
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
        # Orden: primero solapamiento de keywords (rescata matches exactos cuando
        # el reranker está apagado), después score semántico (reranker/coseno),
        # y orden del documento como desempate.
        kw_scores = {
            c.chunk_id: _keyword_overlap(normalized_question, c.text)
            for c in passed_chunks
        }
        passed_chunks.sort(
            key=lambda c: (
                -kw_scores.get(c.chunk_id, 0.0),
                -c.score,
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

        # Red de seguridad semántica: sumar siempre los top-3 por score crudo que
        # no hayan entrado, para que min_score no filtre el chunk más relevante.
        by_semantic = sorted(all_chunks, key=lambda c: -c.score)
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

    # ── Step 5b: Trust gate — ¿el contexto RESPONDE o solo se parece? ─────────
    # Si nada responde, activa la rama determinística de no-info (hard_fallback)
    # en vez de dejar que el LLM invente. Si responde a medias, filtra el
    # contexto y fuerza la respuesta parcial honesta. Fail-open ante errores.
    # Ver services/trust_gate.py (validado en staging 2026-07-23, 33/33).
    if (
        settings.trust_gate_enabled
        and context_parts and not hard_fallback and not low_confidence_fallback
    ):
        try:
            from services.trust_gate import coverage_note, evaluate_coverage
            _tg = await evaluate_coverage(judge_question, context_parts, tenant_id)
            # F2a (plan de calidad): scores crudos junto al veredicto — cada
            # consulta real acumula datos para calibrar la señal de confianza
            # única (best_rrf vs best_cosine vs lex vs veredicto del juez).
            _best_rrf = max((c.score for c in all_chunks), default=0.0)
            _best_cos = max(
                (c.metadata.get("_cosine_score", 0.0) for c in all_chunks), default=0.0
            )
            logger.info(
                "trust_gate tenant_id=%s action=%s judge=%s lex=%.2f best_rrf=%.3f best_cos=%.3f reason=%s",
                tenant_id, _tg["action"], _tg["judge_used"], _tg["lex_coverage"],
                _best_rrf, _best_cos, _tg["reason"],
            )
            if _tg["action"] == "refuse":
                hard_fallback = True
                context_parts, sources = [], []
            elif _tg.get("kept"):
                # NO filtrar el contexto a los chunks aprobados: las preguntas
                # de síntesis necesitan combinar varios y el filtro las rompía
                # (medido: síntesis 92%→58% con filtro). El veredicto decide
                # responder/rechazar; la nota maneja la cobertura parcial.
                if _tg.get("missing"):
                    context_parts.append(coverage_note(_tg["missing"]))
        except Exception as exc:  # noqa: BLE001 — el gate nunca tira la consulta
            logger.warning("trust_gate_error tenant_id=%s error=%s", tenant_id, exc)

    # ── Step 6: Choose model based on complexity ───────────────────────────────
    from services.groq_client import classify_complexity, complete

    complexity = classify_complexity(normalized_question)

    # ── Step 7: Assemble system prompt por módulos temáticos ──────────────────
    # prompt_builder compone el system con solo los módulos que el turno
    # necesita (ver services/prompt_builder.py). La política de alcance y
    # fuentes se genera ahí, consciente de las tools activas — un solo dueño,
    # sin las contradicciones del ensamblado monolítico (la personalidad ya no
    # opina de alcance; bot_scope entra como tema extra, no como tercer guion).
    from services.prompt_builder import PromptInputs, build_system_prompt

    if context_parts and low_confidence_fallback:
        context_block = (
            "ADVERTENCIA: La información disponible tiene baja relevancia para esta consulta. "
            "Usala solo si es claramente pertinente; si no, indicá que no encontraste información suficiente.\n\n"
            "Contexto disponible (baja confianza):\n"
            + "\n\n---\n\n".join(context_parts[:settings.low_confidence_fallback_chunks])
        )
    elif context_parts:
        context_block = "Contexto disponible:\n" + "\n\n---\n\n".join(context_parts[:settings.max_context_chunks])
    else:
        context_block = "(No hay información documental disponible para esta consulta.)"

    # Datos verificados (resuelve contradicciones de campos: dirección/teléfono)
    facts_note = await _canonical_facts_note(tenant_id, question)

    system_prompt, prompt_modules = build_system_prompt(PromptInputs(
        personality=personality,
        question=normalized_question,
        bot_description=bot_description,
        bot_scope=bot_scope,
        context_block=context_block,
        context_text="\n".join(context_parts),
        has_context=bool(context_parts),
        facts_note=facts_note,
        has_tools=bool(tool_schemas),
        tool_domains=tool_domains or [],
        language=language,
        templates=module_templates,
    ))
    # El hash identifica la VERSIÓN exacta del prompt que vio el modelo — con
    # overrides editables en DB, "qué texto corría cuando respondió esto" deja
    # de ser reconstruible sin esto.
    _prompt_hash = hashlib.md5(system_prompt.encode()).hexdigest()[:10]
    logger.info(
        "prompt_composed tenant_id=%s modules=%s chars=%d hash=%s",
        tenant_id, ",".join(prompt_modules), len(system_prompt), _prompt_hash,
    )
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
                excerpt = _sanitize_input(content)[:n].replace("\n", " ")
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
                messages.append({"role": role, "content": _sanitize_input(content)[:max_chars]})

    messages.append({"role": "user", "content": sanitized_q})

    # El corte duro asume que toda consulta de score bajo PIDE información —
    # un saludo no pide nada y no tiene qué alucinar. "hola, que tal?" caía
    # acá (vía judge_refuse del trust gate) y respondía "No encontré esa
    # información" en vez de saludar (visto 2026-07-28). Chitchat → LLM con
    # el prompt podado de small talk (~2k tokens): responde como persona.
    from services.prompt_builder import is_chitchat
    if hard_fallback and is_chitchat(normalized_question):
        logger.info("hard_fallback_bypass_chitchat tenant_id=%s", tenant_id)
        hard_fallback = False

    if hard_fallback:
        # Corte duro: respuesta determinística con el contacto del tenant, sin LLM.
        # Imposible alucinar porque no hay generación. Reusa el contact_info del
        # config del handoff (mismo campo que el mensaje de "no hay operadores").
        #
        # PERO: con tools presentes, este es EXACTAMENTE el camino donde caen las
        # consultas de datos vivos ("¿qué oportunidades tenemos?" no tiene docs →
        # score bajo). Antes de rendirnos, una llamada de SOLO-decisión (el texto
        # se descarta → cero riesgo de alucinación): si el LLM elige tool, el
        # caller la ejecuta; si no, sigue el mensaje determinístico de siempre.
        if tool_schemas:
            pick = await _try_tool_pick(question, tool_schemas, tenant_id)
            if pick:
                latency_ms = int(time.monotonic() * 1000) - start_ms
                logger.info("unified_tool_pick_on_fallback tenant_id=%s tool=%s", tenant_id, pick["name"])
                return {
                    "answer": None,
                    "tool_call": pick,
                    "sources": [],
                    "intent_label": None,
                    "intent_confidence": None,
                    "from_cache": False,
                    "latency_ms": latency_ms,
                }
        from services.handoff import _get_handoff_config, build_no_info_message
        handoff_cfg = await _get_handoff_config(tenant_id)
        answer = build_no_info_message(handoff_cfg)
        latency_ms = int(time.monotonic() * 1000) - start_ms
        return {
            "answer": answer,
            "sources": [],
            "intent_label": None,
            "intent_confidence": None,
            "from_cache": False,
            "latency_ms": latency_ms,
            "low_confidence": True,
        }

    try:
        if tool_schemas:
            # Modo unificado (2b): UNA llamada decide tool-vs-respuesta. Cero hops
            # extra en turnos RAG; si elige tool, la salida es corta (más rápida
            # que generar respuesta) y el caller ejecuta.
            from services.groq_client import complete_with_tools
            answer, tool_pick = await complete_with_tools(
                messages=messages,
                tools=tool_schemas,
                complexity=complexity,
                tenant_id=tenant_id,
            )
            if tool_pick:
                latency_ms = int(time.monotonic() * 1000) - start_ms
                return {
                    "answer": None,
                    "tool_call": tool_pick,
                    "sources": [],
                    "intent_label": None,
                    "intent_confidence": None,
                    "from_cache": False,
                    "latency_ms": latency_ms,
                }
        else:
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
            "intent_label": None,
            "intent_confidence": None,
            "from_cache": False,
            "latency_ms": latency_ms,
        }

    latency_ms = int(time.monotonic() * 1000) - start_ms

    response = {
        "answer": answer,
        "sources": sources,
        "intent_label": None,
        "intent_confidence": None,
        "from_cache": False,
        "latency_ms": latency_ms,
        "low_confidence": low_confidence_fallback,
    }

    # ── Step 7: Cache the response ────────────────────────────────────────────
    # Skip cache cuando la respuesta es de baja confianza / fuera de alcance.
    # Cachear esos casos envenena el cache (congela un "no sé" transitorio y lo
    # sirve repetido) Y rompe el conteo de handoff: una consulta fuera de alcance
    # repetida volvería del cache sin recorrer evaluate_handoff con sources frescas.
    # La señal autoritativa es del RAG (low_confidence_fallback / sin sources de
    # confianza), no string matching — genérico, sin keywords.
    # Saludos cortos (<60 chars) con respuesta normal sí se cachean.
    # El LLM, cuando no encuentra info (regla 6 del prompt anti-alucinación), responde
    # "No encontré esa información...". El marker viejo ("No tengo información sobre ese
    # tema...") NUNCA coincidía → esas respuestas de "no sé" se cacheaban por error y se
    # servían repetidas. Alineado con el texto real que emite el bot.
    _no_info_markers = [
        "No encontré esa información",
        "fuera de mi área de conocimiento",  # guion único de rechazo (prompt_builder)
        "Eso se escapa de lo que puedo ayudarte",  # guion legacy del "Asistente cordial"
    ]
    is_no_info = any(m in (answer or "") for m in _no_info_markers)
    is_long_no_sources = not sources and len(answer or "") > 60
    if not is_no_info and not is_long_no_sources and not low_confidence_fallback and sources:
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

    logger.info(
        "query_complete tenant_id=%s latency_ms=%d complexity=%s intent=%s "
        "sources=%d rewriter_expanded=%s low_confidence=%s",
        tenant_id, latency_ms, complexity, response["intent_label"],
        len(sources), rewriter_expanded, low_confidence_fallback,
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
    """Persist query log to consultas_log. Non-fatal on failure.

    intent_label/intent_confidence quedan por compatibilidad de schema (columnas
    nullable); el clasificador de intenciones ya no corre en el camino de consulta.
    """
    from core.database import get_pg_session
    from sqlalchemy import text
    from core.text_utils import repair_mojibake

    # Reparar doble-encoding antes de persistir: el texto alimenta el panel de
    # conversaciones y los análisis sobre consultas_log.
    question_text = repair_mojibake(question_text) or question_text

    try:
        async with get_pg_session(tenant_id) as session:
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
                    "auto_learning_blocked": False,
                },
            )
    except Exception as exc:
        logger.warning("query_log_failed tenant_id=%s error=%s", tenant_id, exc)


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
            # ORDER BY determinístico: si hay más de una asignación activa (estado
            # inconsistente), gana SIEMPRE la más reciente. Sin orden, Postgres
            # devolvía cualquiera y el bot cambiaba de personalidad (y de guion
            # de rechazo) al azar en cada expiración del cache.
            result = await session.execute(text("""
                SELECT t.contenido, t.nombre
                FROM tenant_prompt_assignments a
                JOIN system_prompt_templates t ON t.id = a.template_id
                WHERE a.tenant_id = :tid AND a.is_active = TRUE
                  AND t.is_active = TRUE AND t.is_system = FALSE
                ORDER BY a.assigned_at DESC
            """), {"tid": tenant_id})
            rows = result.fetchall()
    except Exception as exc:
        logger.warning("active_template_load_failed tenant_id=%s error=%s", tenant_id, exc)
        return None

    if len(rows) > 1:
        logger.warning(
            "multiple_active_personalities tenant_id=%s count=%d using=%s",
            tenant_id, len(rows), rows[0][1],
        )
    contenido = rows[0][0] if rows else None
    try:
        await redis.setex(cache_key, 300, contenido or "")
    except Exception:
        pass

    return contenido


# El fallback de reglas anti-alucinación vive ahora en services/prompt_builder
# (GROUNDING_FALLBACK y los casos límite), módulo por módulo.


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


# Pregunta de dirección en general (¿pregunta por una ubicación?)
_ADDRESS_TRIGGERS = ["direcc", "dónde", "donde", "ubica", "queda", "domicilio", "llegar", "sede"]
# Keywords de la consulta → sujeto de la dirección (consciente de entidad).
_SUBJECT_QUERY_KW = {
    "centro_medico": ["centro medico", "medico", "medica", "especialidad", "atienden",
                      "turno", "consultorio", "profesional"],
    "sede": ["sede", "mutual", "oficina", "administrativa", "autorizacion",
             "afiliac", "contacto principal", "tramite", "casa central"],
}
_SUBJECT_LABEL = {
    "centro_medico": "del Centro Médico",
    "sede": "de la Sede administrativa de la mutual",
    "general": "",
}


async def _canonical_facts_note(tenant_id: str, question: str) -> str:
    """Inyecta la dirección verificada del sujeto correcto (centro médico vs sede).

    Un tenant puede tener varias ubicaciones legítimas (mutualyf: centro médico en
    Junín 2956, sede administrativa en Junín 2961). NO se resuelve por mayoría
    global — se elige según el sujeto de la consulta. Si es ambigua, se aclaran
    ambas para que el modelo no adivine.

    El chequeo de triggers (string puro, ~µs) va ANTES del GET a Redis: la
    mayoría de las consultas no preguntan direcciones y no deben pagar el
    round-trip por nada.
    """
    import unicodedata

    q = "".join(c for c in unicodedata.normalize("NFD", question.lower())
                if unicodedata.category(c) != "Mn")
    if not any(t in q for t in _ADDRESS_TRIGGERS):
        return ""

    try:
        from services.contradiction_detector import get_canonical_facts
        facts = await get_canonical_facts(tenant_id)
    except Exception:
        return ""
    if not facts:
        return ""

    # facts de dirección por sujeto: {"centro_medico": "Junín 2956", "sede": "Junín 2961"}
    addr = {k.split(":", 1)[1]: v["value"] for k, v in facts.items()
            if k.startswith("direccion:") and v.get("value")}
    if not addr:
        return ""

    matched = [s for s, kws in _SUBJECT_QUERY_KW.items()
               if s in addr and any(k in q for k in kws)]

    if len(matched) == 1:
        subj = matched[0]
        return (f"=== DATO VERIFICADO ===\nLa dirección {_SUBJECT_LABEL[subj]} es "
                f"{addr[subj]}. Usá este valor; si el contexto muestra otra numeración "
                f"para lo mismo, es un error de digitalización.")

    if len(addr) >= 2:
        # Ambigua o múltiples sujetos → aclarar que son ubicaciones distintas.
        lines = [f"- Dirección {_SUBJECT_LABEL.get(s, '')}: {v}" for s, v in addr.items()]
        return ("=== DATOS VERIFICADOS (ubicaciones) ===\n"
                "Esta organización tiene ubicaciones distintas — no las confundas:\n"
                + "\n".join(lines))

    # Un solo sujeto conocido: inyectarlo.
    subj, value = next(iter(addr.items()))
    return f"=== DATO VERIFICADO ===\nLa dirección {_SUBJECT_LABEL.get(subj, '')} es {value}."


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
        # Default 0.45 (antes 0.55): 0.55 era muy alto para queries cortas — el cosine
        # de e5 rara vez lo supera aunque el chunk sea correcto, y se descartaba. El
        # reranker + el corte duro (0.35) son la red fina. Configurable por tenant.
        "min_retrieval_score":  float(row["min_retrieval_score"]) if row and row["min_retrieval_score"] is not None else 0.45,
        "prompt_quality_gate":  row["prompt_quality_gate"]   if row else None,
        "prompt_cluster_label": row["prompt_cluster_label"]  if row else None,
    }

    try:
        await redis.setex(cache_key, 300, json.dumps(config))  # 5-min TTL
    except Exception:
        pass

    return config
