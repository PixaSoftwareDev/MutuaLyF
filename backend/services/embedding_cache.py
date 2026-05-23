"""Redis cache for query embeddings.

Problem: embed_query() takes 200-500ms on CPU. For repeated or similar queries
(same question asked by different users), we can cache the embedding vector.

Cache key: SHA-256 of the normalized query text
TTL: 24h (embeddings don't change unless the model changes)
Storage: Redis DB 1 (same as response cache) with prefix 'emb:'

This is a best-effort cache — misses fall back to computing the embedding.
"""

import hashlib
import json
import logging

logger = logging.getLogger(__name__)

_EMB_PREFIX = "emb:"
_EMB_TTL    = 86_400  # 24 hours
_HIT_COUNT  = 0
_MISS_COUNT = 0


def _cache_key(text: str) -> str:
    normalized = text.strip().lower()
    return f"{_EMB_PREFIX}{hashlib.sha256(normalized.encode()).hexdigest()}"


async def get_cached_embedding(text: str) -> list[float] | None:
    """Try to retrieve a cached embedding. Returns None on cache miss or error."""
    global _HIT_COUNT, _MISS_COUNT
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        raw = await redis.get(_cache_key(text))
        if raw:
            _HIT_COUNT += 1
            logger.debug("embedding_cache_hit text_len=%d total_hits=%d", len(text), _HIT_COUNT)
            return json.loads(raw)
        _MISS_COUNT += 1
    except Exception as exc:
        logger.debug("embedding_cache_read_error error=%s", exc)
    return None


async def set_cached_embedding(text: str, vector: list[float]) -> None:
    """Store an embedding in Redis with 24h TTL."""
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        await redis.setex(_cache_key(text), _EMB_TTL, json.dumps(vector))
    except Exception as exc:
        logger.debug("embedding_cache_write_error error=%s", exc)


async def embed_query_cached(text: str) -> list[float] | None:
    """Embed query with Redis cache. Falls back to fresh embedding on miss.

    Usa aembed_query (httpx.AsyncClient nativo) en vez de embed_query+executor.
    El cambio elimina la dependencia del thread pool de asyncio que serializaba
    los embeds bajo carga (16 threads default → cuello bajo 20+ requests).
    """
    cached = await get_cached_embedding(text)
    if cached is not None:
        return cached

    from services.embeddings import aembed_query
    vector = await aembed_query(text)

    if vector is not None:
        await set_cached_embedding(text, vector)

    return vector


