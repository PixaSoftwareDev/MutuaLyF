"""RAG retrieval: embed query → Qdrant search → rerank → return top-k chunks.

Etapa 3 improvements:
  - Independent timeouts per source (Qdrant, reranker)
  - doc_type-aware result filtering (skipped chunks from non-autonomous filtering)
  - Tracing spans for each retrieval stage
  - Parallel embedding + metadata enrichment
"""

import asyncio
import logging
from dataclasses import dataclass
from functools import lru_cache

from qdrant_client.models import ScoredPoint

from core.config import settings
from core.database import get_qdrant_client
from services.embedding_cache import embed_query_cached

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# PyTorch threading config — debe correr ANTES de cualquier op de torch.
# torch.set_num_interop_threads() solo se puede llamar al inicio. En Docker el
# default es os.cpu_count()=16 pero el cgroup nos limita a 6 → oversubscription.
# Auditoria 2026-05-20 confirmo: con 10 threads default, rerank de 10 pares
# tarda 12s; con 6 threads, 2s. Alineamos al cgroup limit del backend.
# ─────────────────────────────────────────────────────────────────────────────
try:
    import torch as _torch
    _torch.set_num_threads(6)
    try:
        _torch.set_num_interop_threads(1)
    except RuntimeError:
        # Solo se puede setear UNA vez, antes de cualquier op.
        # Si otro modulo ya hizo torch ops, queda con el default.
        pass
    logger.info(
        "torch_threads_configured intra=%d interop=%d",
        _torch.get_num_threads(),
        _torch.get_num_interop_threads(),
    )
except ImportError:
    pass

# Per-source timeouts (independent — Qdrant and reranker don't block each other)
_QDRANT_TIMEOUT_S  = settings.db_timeout_ms / 1000       # default 500ms
_RERANKER_TIMEOUT_S = settings.reranker_timeout_ms / 1000  # default 5000ms (was 300ms, raised in .env)


@dataclass
class RetrievedChunk:
    chunk_id:            str
    document_id:         str
    text:                str           # parent text after expansion; child text for legacy flat chunks
    score:               float
    quality_gate_status: str
    metadata:            dict
    parent_id:           str | None = None  # None for legacy flat chunks

    @property
    def doc_type(self) -> str:
        return self.metadata.get("doc_type", "unknown")

    @property
    def strategy(self) -> str:
        return self.metadata.get("strategy", "fixed")


@lru_cache(maxsize=1)
def _load_reranker():
    if not settings.reranker_enabled:
        logger.info("reranker_disabled via RERANKER_ENABLED=false")
        return None
    try:
        from sentence_transformers import CrossEncoder
        logger.info("reranker_loading model=%s", settings.reranker_model)
        model = CrossEncoder(settings.reranker_model)
        logger.info("reranker_loaded model=%s", settings.reranker_model)
        return model
    except ImportError:
        logger.warning("cross_encoder_not_installed reranker_disabled")
        return None
    except Exception as exc:
        logger.error("reranker_load_failed error=%s", exc)
        return None


async def retrieve(
    query: str,
    tenant_id: str,
    top_k: int = settings.retrieval_top_k,
    rerank_top_k: int = settings.rerank_top_k,
) -> list[RetrievedChunk]:
    """Embed query, search Qdrant with independent timeout, rerank results.

    Each stage has its own timeout — a slow reranker doesn't block Qdrant results.
    Falls back gracefully at each stage.
    """
    from core.tracing import get_tracer
    tracer = get_tracer()

    loop = asyncio.get_running_loop()

    # ── 1. Embed query (CPU-bound, non-blocking) ──────────────────────────────
    with tracer.start_as_current_span("retrieval.embed") as span:
        span.set_attribute("tenant_id", tenant_id)
        query_vector = await embed_query_cached(query)

    if query_vector is None:
        logger.error("retrieve_embed_failed query_len=%d", len(query))
        return []

    # ── 2. Qdrant search with independent timeout ─────────────────────────────
    collection = f"{tenant_id}_docs"
    qdrant = get_qdrant_client()

    with tracer.start_as_current_span("retrieval.qdrant_search") as span:
        span.set_attribute("collection", collection)
        span.set_attribute("top_k", top_k)
        try:
            async with asyncio.timeout(_QDRANT_TIMEOUT_S):
                results: list[ScoredPoint] = await qdrant.search(
                    collection_name=collection,
                    query_vector=query_vector,
                    limit=top_k,
                    with_payload=True,
                )
        except asyncio.TimeoutError:
            logger.warning(
                "qdrant_search_timeout tenant_id=%s timeout_s=%.1f",
                tenant_id, _QDRANT_TIMEOUT_S,
            )
            span.set_attribute("timeout", True)
            return []
        except Exception as exc:
            logger.error("qdrant_search_failed tenant_id=%s error=%s", tenant_id, exc)
            return []

    if not results:
        return []

    # ── 3. Build chunk list with parent_id from Qdrant payload ──────────────
    chunks = [
        RetrievedChunk(
            chunk_id=str(point.id),
            document_id=point.payload.get("document_id", ""),
            text=point.payload.get("text", ""),
            score=float(point.score),
            quality_gate_status=point.payload.get("quality_gate_status", "unknown"),
            metadata={k: v for k, v in point.payload.items() if k not in ("text", "document_id")},
            parent_id=point.payload.get("parent_id"),
        )
        for point in results
    ]

    # Skipped chunks participate in search but get a score penalty
    for chunk in chunks:
        if chunk.quality_gate_status == "skipped":
            chunk.score *= settings.skipped_chunk_score_penalty

    # ── 4. Parent expansion (Small-to-Big) ───────────────────────────────────
    # Replace each child's short text with its full parent text from PG.
    # Flat chunks (parent_id=None) pass through unchanged.
    with tracer.start_as_current_span("retrieval.parent_expand") as span:
        parent_ids = list({c.parent_id for c in chunks if c.parent_id})
        span.set_attribute("parents_to_fetch", len(parent_ids))

        if parent_ids:
            parent_texts = await _fetch_parent_texts(parent_ids, tenant_id)

            # Deduplicate: keep highest-scored child per parent, expand its text.
            best_per_parent: dict[str, RetrievedChunk] = {}
            flat_chunks: list[RetrievedChunk] = []

            for c in chunks:
                if c.parent_id:
                    prev = best_per_parent.get(c.parent_id)
                    if prev is None or c.score > prev.score:
                        best_per_parent[c.parent_id] = c
                else:
                    flat_chunks.append(c)

            expanded: list[RetrievedChunk] = []
            for pid, chunk in best_per_parent.items():
                if pid in parent_texts:
                    chunk.text = parent_texts[pid]
                expanded.append(chunk)

            chunks = flat_chunks + expanded
            span.set_attribute("after_dedup", len(chunks))

    # ── 5. BM25 keyword search + RRF merge ───────────────────────────────────
    with tracer.start_as_current_span("retrieval.bm25_rrf") as span:
        try:
            bm25_hits = await _bm25_search(query, tenant_id, limit=settings.bm25_limit)
            span.set_attribute("bm25_hits", len(bm25_hits))
            if bm25_hits:
                chunks = _rrf_merge(chunks, bm25_hits)
                span.set_attribute("after_rrf", len(chunks))
        except Exception as exc:
            logger.warning("bm25_search_failed tenant_id=%s error=%s", tenant_id, exc)

    # ── 6. Rerank with independent timeout ───────────────────────────────────
    # Skip si hay pocos candidatos: rerankear 1-4 elementos no agrega calidad
    # significativa (Qdrant ya los ordeno por similitud) y agrega ~2s en CPU.
    # Cuando se carguen 5+ docs relevantes el reranker se activa automaticamente.
    with tracer.start_as_current_span("retrieval.rerank") as span:
        span.set_attribute("candidates", len(chunks))
        if len(chunks) < settings.reranker_min_candidates:
            logger.debug(
                "rerank_skipped reason=few_candidates count=%d min=%d",
                len(chunks), settings.reranker_min_candidates,
            )
            span.set_attribute("skipped", "few_candidates")
            reranked = sorted(chunks, key=lambda c: c.score, reverse=True)[:rerank_top_k]
        else:
            try:
                async with asyncio.timeout(_RERANKER_TIMEOUT_S):
                    reranked = await loop.run_in_executor(None, _rerank, query, chunks, rerank_top_k)
                span.set_attribute("reranked", len(reranked))
            except asyncio.TimeoutError:
                logger.warning(
                    "reranker_timeout tenant_id=%s timeout_s=%.1f fallback=qdrant_scores",
                    tenant_id, _RERANKER_TIMEOUT_S,
                )
                span.set_attribute("timeout", True)
                reranked = sorted(chunks, key=lambda c: c.score, reverse=True)[:rerank_top_k]

    logger.debug(
        "retrieve_done tenant_id=%s candidates=%d reranked=%d",
        tenant_id, len(chunks), len(reranked),
    )
    return reranked


async def retrieve_by_ids(
    chunk_ids: list[str],
    tenant_id: str,
) -> list[RetrievedChunk]:
    """Fetch specific chunks from Qdrant by ID.

    Used to materialize Neo4j entity-graph results: Neo4j returns chunk_ids that
    contain a named entity; this function fetches the actual text from Qdrant so
    those chunks can be included in the LLM context.

    Chunks returned here get score=1.0 — entity-graph lookup is always highly
    relevant by definition (the entity was explicitly named in the query).
    """
    if not chunk_ids:
        return []

    collection = f"{tenant_id}_docs"
    qdrant = get_qdrant_client()

    try:
        async with asyncio.timeout(_QDRANT_TIMEOUT_S):
            points = await qdrant.retrieve(
                collection_name=collection,
                ids=chunk_ids,
                with_payload=True,
            )
    except asyncio.TimeoutError:
        logger.warning("retrieve_by_ids_timeout tenant_id=%s", tenant_id)
        return []
    except Exception as exc:
        logger.warning("retrieve_by_ids_failed tenant_id=%s error=%s", tenant_id, exc)
        return []

    return [
        RetrievedChunk(
            chunk_id=str(point.id),
            document_id=point.payload.get("document_id", ""),
            text=point.payload.get("text", ""),
            score=1.0,
            quality_gate_status=point.payload.get("quality_gate_status", "unknown"),
            metadata={k: v for k, v in point.payload.items() if k not in ("text", "document_id")},
        )
        for point in points
    ]


async def _fetch_parent_texts(parent_ids: list[str], tenant_id: str) -> dict[str, str]:
    """Fetch parent chunk texts from PostgreSQL in a single IN query."""
    from sqlalchemy import text as sa_text
    from core.database import get_worker_pg_session

    if not parent_ids:
        return {}

    try:
        async with get_worker_pg_session(tenant_id) as session:
            rows = await session.execute(
                sa_text("SELECT id, text FROM parent_chunks WHERE id = ANY(:ids)"),
                {"ids": parent_ids},
            )
            return {row.id: row.text for row in rows}
    except Exception as exc:
        logger.warning("fetch_parent_texts_failed tenant_id=%s error=%s", tenant_id, exc)
        return {}


async def _bm25_search(query: str, tenant_id: str, limit: int = 20) -> list[dict]:
    """Full-text BM25 search over parent_chunks via PostgreSQL tsvector."""
    from sqlalchemy import text as sa_text
    from core.database import get_worker_pg_session

    # Sanitize query for tsquery: keep only word chars and spaces, join with &
    words = [w for w in query.replace("'", " ").split() if len(w) > 1]
    if not words:
        return []
    tsquery = " & ".join(words)

    try:
        async with get_worker_pg_session(tenant_id) as session:
            rows = await session.execute(
                sa_text("""
                    SELECT id, document_id, text,
                           ts_rank_cd(ts_body, query) AS rank
                    FROM parent_chunks,
                         to_tsquery('spanish', :tsquery) query
                    WHERE ts_body @@ query
                    ORDER BY rank DESC
                    LIMIT :limit
                """),
                {"tsquery": tsquery, "limit": limit},
            )
            return [
                {
                    "parent_id": row.id,
                    "document_id": row.document_id,
                    "text": row.text,
                    "bm25_rank": float(row.rank),
                }
                for row in rows
            ]
    except Exception as exc:
        logger.warning("bm25_search_failed tenant_id=%s error=%s", tenant_id, exc)
        return []


def _rrf_merge(
    semantic_chunks: list[RetrievedChunk],
    bm25_hits: list[dict],
    k: int | None = None,
) -> list[RetrievedChunk]:
    if k is None:
        k = settings.rrf_k
    """Reciprocal Rank Fusion: merge semantic + BM25 results by rank.

    RRF score = 1/(k + rank_semantic) + 1/(k + rank_bm25).
    BM25 results that match a semantic chunk boost it; new BM25-only
    results are added as new RetrievedChunks with their parent text.
    """
    # Map parent_id → (rrf_contribution, chunk) for semantic results
    rrf_scores: dict[str, float] = {}
    chunk_by_pid: dict[str, RetrievedChunk] = {}
    # Also index by chunk_id for flat chunks (parent_id=None)
    chunk_by_cid: dict[str, RetrievedChunk] = {}

    for rank, chunk in enumerate(semantic_chunks):
        key = chunk.parent_id or chunk.chunk_id
        score = 1.0 / (k + rank + 1)
        rrf_scores[key] = rrf_scores.get(key, 0.0) + score
        chunk_by_pid[key] = chunk
        chunk_by_cid[chunk.chunk_id] = chunk

    # Add BM25 rank contributions
    for rank, hit in enumerate(bm25_hits):
        pid = hit["parent_id"]
        bm25_score = 1.0 / (k + rank + 1)
        if pid in rrf_scores:
            rrf_scores[pid] += bm25_score
        else:
            # BM25-only hit — add as new chunk with parent text
            rrf_scores[pid] = bm25_score
            chunk_by_pid[pid] = RetrievedChunk(
                chunk_id=pid,
                document_id=hit["document_id"],
                text=hit["text"],
                score=0.0,
                quality_gate_status="unknown",
                metadata={"strategy": "bm25"},
                parent_id=pid,
            )

    # Apply RRF scores and return sorted
    for key, rrf in rrf_scores.items():
        if key in chunk_by_pid:
            chunk_by_pid[key].score = rrf

    return sorted(chunk_by_pid.values(), key=lambda c: c.score, reverse=True)


def _rerank(query: str, chunks: list[RetrievedChunk], top_k: int) -> list[RetrievedChunk]:
    """Rerank chunks using a CrossEncoder. Falls back to Qdrant scores on failure.

    Memory hygiene (critical — without these, the backend OOMs after ~5-10 queries):
      1. torch.no_grad() — disable autograd
      2. torch.inference_mode() — even stronger; disables view tracking
      3. del refs + gc.collect() after each predict — release tokenizer/output tensors
    """
    import gc

    reranker = _load_reranker()
    if reranker is None:
        return sorted(chunks, key=lambda c: c.score, reverse=True)[:top_k]

    try:
        import math
        import torch
        pairs = [(query, chunk.text) for chunk in chunks]
        with torch.inference_mode():
            raw_scores = reranker.predict(pairs, convert_to_tensor=False, show_progress_bar=False)
        # Materialize as plain Python list and drop any tensor reference.
        scores: list[float] = list(raw_scores) if not hasattr(raw_scores, "tolist") else raw_scores.tolist()
        # Normalize cross-encoder logits to [0,1] via sigmoid so the downstream
        # min_score filter (orchestrator.py) uses comparable values.
        # Without this, the orchestrator still saw the old Qdrant cosine score
        # and dropped chunks the reranker had ranked at the top.
        def _sigmoid(x: float) -> float:
            try:
                return 1.0 / (1.0 + math.exp(-x))
            except OverflowError:
                return 0.0 if x < 0 else 1.0
        normalized = [_sigmoid(s) for s in scores]
        for chunk, norm in zip(chunks, normalized):
            chunk.score = norm
        scored = sorted(zip(normalized, chunks), key=lambda x: x[0], reverse=True)
        result = [chunk for _, chunk in scored[:top_k]]
        # Drop intermediates and force GC: empty_cache is a no-op on CPU but
        # gc.collect() releases tokenizer state held by sentence-transformers.
        del raw_scores, pairs, scored, normalized
        gc.collect()
        return result
    except Exception as exc:
        logger.error("rerank_failed error=%s falling_back_to_qdrant_scores", exc)
        return sorted(chunks, key=lambda c: c.score, reverse=True)[:top_k]
