"""RAG retrieval: embed query → Qdrant search → rerank → return top-k chunks."""

import asyncio
import logging
from dataclasses import dataclass
from functools import lru_cache

from qdrant_client.models import ScoredPoint

from core.config import settings
from core.database import get_qdrant_client
from services.embeddings import embed_query

logger = logging.getLogger(__name__)


@dataclass
class RetrievedChunk:
    chunk_id: str
    document_id: str
    text: str
    score: float
    quality_gate_status: str
    metadata: dict


@lru_cache(maxsize=1)
def _load_reranker():
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
    """Embed query, search Qdrant, rerank results.

    Args:
        query: User's natural language question.
        tenant_id: Tenant scope for the search.
        top_k: Number of candidates to fetch from Qdrant before reranking.
        rerank_top_k: Number of results to return after reranking.

    Returns:
        List of RetrievedChunk ordered by relevance (best first).
    """
    loop = asyncio.get_running_loop()

    # CPU-bound — must not block the event loop
    query_vector = await loop.run_in_executor(None, embed_query, query)
    if query_vector is None:
        logger.error("retrieve_embed_failed query_len=%d", len(query))
        return []

    collection = f"{tenant_id}_docs"
    qdrant = get_qdrant_client()

    try:
        async with asyncio.timeout(settings.db_timeout_ms / 1000):
            results: list[ScoredPoint] = await qdrant.search(
                collection_name=collection,
                query_vector=query_vector,
                limit=top_k,
                with_payload=True,
            )
    except asyncio.TimeoutError:
        logger.warning("qdrant_search_timeout tenant_id=%s", tenant_id)
        return []
    except Exception as exc:
        logger.error("qdrant_search_failed tenant_id=%s error=%s", tenant_id, exc)
        return []

    if not results:
        return []

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

    # CPU-bound — run in executor to avoid blocking the event loop
    reranked = await loop.run_in_executor(None, _rerank, query, chunks, rerank_top_k)
    logger.debug("retrieve_done tenant_id=%s candidates=%d reranked=%d", tenant_id, len(chunks), len(reranked))
    return reranked


def _rerank(query: str, chunks: list[RetrievedChunk], top_k: int) -> list[RetrievedChunk]:
    """Rerank chunks using bge-reranker-large. Falls back to Qdrant scores on failure."""
    reranker = _load_reranker()
    if reranker is None:
        return chunks[:top_k]

    try:
        pairs = [(query, chunk.text) for chunk in chunks]
        scores: list[float] = reranker.predict(pairs).tolist()
        scored = sorted(zip(scores, chunks), key=lambda x: x[0], reverse=True)
        return [chunk for _, chunk in scored[:top_k]]
    except Exception as exc:
        logger.error("rerank_failed error=%s falling_back_to_qdrant_scores", exc)
        return chunks[:top_k]
