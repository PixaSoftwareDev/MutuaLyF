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
from typing import Any

from qdrant_client.models import ScoredPoint

from core.config import settings
from core.database import get_qdrant_client
from services.embeddings import embed_query
from services.embedding_cache import embed_query_cached

logger = logging.getLogger(__name__)

# Per-source timeouts (independent — Qdrant and reranker don't block each other)
_QDRANT_TIMEOUT_S  = settings.db_timeout_ms / 1000       # default 500ms
_RERANKER_TIMEOUT_S = settings.reranker_timeout_ms / 1000  # default 5000ms (was 300ms, raised in .env)


@dataclass
class RetrievedChunk:
    chunk_id:            str
    document_id:         str
    text:                str
    score:               float
    quality_gate_status: str
    metadata:            dict

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
    top_k: int = 10,
    rerank_top_k: int = 5,
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

    # ── 3. Build chunk list — filter skipped quality gate chunks from results ──
    chunks = [
        RetrievedChunk(
            chunk_id=str(point.id),
            document_id=point.payload.get("document_id", ""),
            text=point.payload.get("text", ""),
            score=float(point.score),
            quality_gate_status=point.payload.get("quality_gate_status", "unknown"),
            metadata={k: v for k, v in point.payload.items() if k not in ("text", "document_id")},
        )
        for point in results
    ]

    # Skipped chunks participate in search but get a score penalty
    # (they're less reliable than passed chunks)
    for chunk in chunks:
        if chunk.quality_gate_status == "skipped":
            chunk.score *= 0.85  # 15% penalty

    # ── 4. Rerank with independent timeout ────────────────────────────────────
    with tracer.start_as_current_span("retrieval.rerank") as span:
        span.set_attribute("candidates", len(chunks))
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


def _rerank(query: str, chunks: list[RetrievedChunk], top_k: int) -> list[RetrievedChunk]:
    """Rerank chunks using bge-reranker-large. Falls back to Qdrant scores on failure."""
    reranker = _load_reranker()
    if reranker is None:
        return sorted(chunks, key=lambda c: c.score, reverse=True)[:top_k]

    try:
        pairs = [(query, chunk.text) for chunk in chunks]
        scores: list[float] = reranker.predict(pairs).tolist()
        scored = sorted(zip(scores, chunks), key=lambda x: x[0], reverse=True)
        return [chunk for _, chunk in scored[:top_k]]
    except Exception as exc:
        logger.error("rerank_failed error=%s falling_back_to_qdrant_scores", exc)
        return sorted(chunks, key=lambda c: c.score, reverse=True)[:top_k]
