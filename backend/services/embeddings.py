"""Embedding service with provider switch (local | openai).

local:  multilingual-e5-large via sentence-transformers (~1.5GB RAM, CPU-bound).
openai: text-embedding-3-small via API (libera RAM del backend, ~80ms/embed).

Both providers normalize to EMBEDDING_DIM=1024 for compatibility with the
existing Qdrant collection. Switching providers requires re-embedding all
existing chunks (vectors are not semantically interchangeable across models).

NEVER use bge-large-en-v1.5 — English-only, incompatible with Spanish corpus.
"""

import logging
from functools import lru_cache

import httpx

from core.config import settings

logger = logging.getLogger(__name__)

EMBEDDING_DIM = 1024  # multilingual-e5-large nativo. OpenAI usa dimensions param.

# ── OpenAI client (sync, reusable) ────────────────────────────────────────────
# httpx.Client sync mantiene la API sync de este módulo (los callers usan
# loop.run_in_executor para no bloquear). Lazy-init para no crear conexión
# si nunca se llama.
_openai_sync_client: httpx.Client | None = None
_tei_sync_client: httpx.Client | None = None

# Async clients para el query path (hot path). Per-event-loop init para soportar
# Celery workers que crean event loops nuevos en cada task. Sin esto, el client
# httpx queda atado a un loop ya cerrado y rompe la siguiente request.
import asyncio as _asyncio
_openai_async_client: httpx.AsyncClient | None = None
_openai_async_client_loop: _asyncio.AbstractEventLoop | None = None
_tei_async_client: httpx.AsyncClient | None = None
_tei_async_client_loop: _asyncio.AbstractEventLoop | None = None


def _current_loop() -> _asyncio.AbstractEventLoop | None:
    try:
        return _asyncio.get_running_loop()
    except RuntimeError:
        return None


def _get_openai_sync_client() -> httpx.Client:
    """Sync client para callers legacy (Celery workers en background)."""
    global _openai_sync_client
    if _openai_sync_client is None:
        _openai_sync_client = httpx.Client(
            base_url="https://api.openai.com/v1",
            headers={"Authorization": f"Bearer {settings.openai_api_key}"},
            timeout=15.0,
            limits=httpx.Limits(
                max_connections=settings.http_pool_max_connections,
                max_keepalive_connections=settings.http_pool_max_keepalive,
            ),
        )
    return _openai_sync_client


def _get_tei_sync_client() -> httpx.Client:
    """Sync client TEI para callers legacy."""
    global _tei_sync_client
    if _tei_sync_client is None:
        _tei_sync_client = httpx.Client(
            base_url=settings.tei_embedding_url,
            timeout=settings.tei_timeout_ms / 1000,
            limits=httpx.Limits(
                max_connections=settings.http_pool_max_connections,
                max_keepalive_connections=settings.http_pool_max_keepalive,
            ),
        )
    return _tei_sync_client


def _get_openai_async_client() -> httpx.AsyncClient:
    """Async client OpenAI para el query path. Per-event-loop init."""
    global _openai_async_client, _openai_async_client_loop
    loop = _current_loop()
    if _openai_async_client is None or loop is not _openai_async_client_loop:
        _openai_async_client = httpx.AsyncClient(
            base_url="https://api.openai.com/v1",
            headers={"Authorization": f"Bearer {settings.openai_api_key}"},
            timeout=15.0,
            limits=httpx.Limits(
                max_connections=settings.http_pool_max_connections,
                max_keepalive_connections=settings.http_pool_max_keepalive,
            ),
        )
        _openai_async_client_loop = loop
    return _openai_async_client


def _get_tei_async_client() -> httpx.AsyncClient:
    """Async client TEI para el query path. Per-event-loop init."""
    global _tei_async_client, _tei_async_client_loop
    loop = _current_loop()
    if _tei_async_client is None or loop is not _tei_async_client_loop:
        _tei_async_client = httpx.AsyncClient(
            base_url=settings.tei_embedding_url,
            timeout=settings.tei_timeout_ms / 1000,
            limits=httpx.Limits(
                max_connections=settings.http_pool_max_connections,
                max_keepalive_connections=settings.http_pool_max_keepalive,
            ),
        )
        _tei_async_client_loop = loop
    return _tei_async_client


def _provider() -> str:
    return (settings.embedding_provider or "local").lower()


def _is_openai() -> bool:
    return _provider() == "openai"


def _is_tei() -> bool:
    return _provider() == "tei"


# ── Local model (lazy, skipped if provider=openai) ────────────────────────────
@lru_cache(maxsize=1)
def _load_model():
    """Load sentence-transformers model once and cache.

    Returns None when EMBEDDING_PROVIDER=openai (no need to occupy 1.5GB RAM).
    Callers that import _load_model for warmup also benefit from this skip.
    """
    if _is_openai():
        logger.info("embedding_provider=openai - skipping local model load (saves ~1.5GB RAM)")
        return None
    try:
        from sentence_transformers import SentenceTransformer
        logger.info("embedding_model_loading model=%s", settings.embedding_model)
        model = SentenceTransformer(settings.embedding_model)
        logger.info("embedding_model_loaded model=%s dim=%d", settings.embedding_model, EMBEDDING_DIM)
        return model
    except ImportError:
        logger.error("sentence_transformers_not_installed")
        return None
    except Exception as exc:
        logger.error("embedding_model_load_failed error=%s", exc)
        return None


# ── OpenAI embeddings ─────────────────────────────────────────────────────────
def _strip_e5_prefix(text: str) -> str:
    """OpenAI embeddings do not need the e5 'query:' / 'passage:' prefixes."""
    for prefix in ("query: ", "passage: "):
        if text.startswith(prefix):
            return text[len(prefix):]
    return text


def _embed_tei(texts: list[str]) -> list[list[float] | None]:
    """Send a batch of texts to TEI's /embed endpoint.

    TEI hace dynamic batching server-side: aunque mandemos requests separados,
    el server los junta en 1 batch si llegan dentro de la misma ventana. Igual
    enviamos batch para minimizar HTTP overhead.

    El modelo de TEI sirve los prefixes 'query: '/'passage: ' tal como vienen
    (mismo binario que sentence-transformers).
    """
    if not texts:
        return []
    client = _get_tei_sync_client()
    try:
        r = client.post("/embed", json={"inputs": texts, "normalize": True})
        r.raise_for_status()
        data = r.json()
        # TEI devuelve [[v1...], [v2...], ...]
        return data if isinstance(data, list) else [None] * len(texts)
    except Exception as exc:
        logger.error("embed_tei_failed count=%d error=%s", len(texts), exc)
        return [None] * len(texts)


def _embed_openai(texts: list[str]) -> list[list[float] | None]:
    """Send a batch of texts to OpenAI text-embedding-3-small.

    OpenAI accepts up to 2048 inputs per call. We strip e5 prefixes before sending.
    Returns list with same length as input; None per failed item (whole batch fails or none).
    """
    if not texts:
        return []
    client = _get_openai_sync_client()
    cleaned = [_strip_e5_prefix(t) for t in texts]
    try:
        r = client.post(
            "/embeddings",
            json={
                "model": settings.openai_embedding_model,
                "input": cleaned,
                "dimensions": EMBEDDING_DIM,
            },
        )
        r.raise_for_status()
        data = r.json()
        # OpenAI preserves order in data["data"][i].embedding
        return [item["embedding"] for item in data["data"]]
    except Exception as exc:
        logger.error("embed_openai_failed count=%d error=%s", len(texts), exc)
        return [None] * len(texts)


# ── Public API (unchanged signatures, sync) ───────────────────────────────────
def embed_text(text: str) -> list[float] | None:
    """Embed a single text. Routes to TEI, OpenAI or local based on settings.

    Local model expects 'query: ' or 'passage: ' prefix; callers add it via
    embed_query. OpenAI strips these prefixes internally. TEI usa los prefixes
    tal como vienen (mismo modelo que local).
    """
    if _is_tei():
        result = _embed_tei([text])
        if result and result[0] is not None:
            return result[0]
        # Fallback a OpenAI si TEI falla y openai_api_key esta seteada
        if settings.openai_api_key:
            logger.warning("embed_tei_failed_fallback_openai")
            result = _embed_openai([text])
            return result[0] if result else None
        return None

    if _is_openai():
        result = _embed_openai([text])
        return result[0] if result else None

    model = _load_model()
    if model is None:
        return None
    try:
        vector = model.encode(text, normalize_embeddings=True)
        return vector.tolist()
    except Exception as exc:
        logger.error("embed_text_failed error=%s", exc)
        return None


def embed_query(query: str) -> list[float] | None:
    """Embed a user query. Adds the 'query: ' prefix required by e5 (stripped for OpenAI)."""
    return embed_text(f"query: {query}")


def embed_batch(texts: list[str], is_query: bool = False) -> list[list[float] | None]:
    """Embed a batch of texts efficiently.

    Args:
        texts: List of raw strings (prefixes will be added automatically).
        is_query: If True, applies 'query: ' prefix; else 'passage: '.

    Returns:
        List of embedding vectors (or None per item on failure).
    """
    if not texts:
        return []
    prefix = "query: " if is_query else "passage: "
    prefixed = [f"{prefix}{t}" for t in texts]

    if _is_tei():
        result = _embed_tei(prefixed)
        # Si TEI fallo completo y openai esta disponible, fallback a openai
        if all(v is None for v in result) and settings.openai_api_key:
            logger.warning("embed_batch_tei_failed_fallback_openai count=%d", len(prefixed))
            return _embed_openai(prefixed)
        return result

    if _is_openai():
        return _embed_openai(prefixed)

    model = _load_model()
    if model is None:
        return [None] * len(texts)
    try:
        vectors = model.encode(prefixed, normalize_embeddings=True, batch_size=32)
        return [v.tolist() for v in vectors]
    except Exception as exc:
        logger.error("embed_batch_failed error=%s", exc)
        return [None] * len(texts)


# ─────────────────────────────────────────────────────────────────────────────
# Async API (query hot path — sin executor wrapping → no consume thread pool)
#
# Para uso desde el query path, donde la concurrencia depende de tener I/O
# verdaderamente non-blocking. El thread pool default tiene ~16 threads;
# con 4 workers x 20 requests = 80 ops simultaneas, los embeds esperaban
# slot del executor → serializacion. Estas versiones llaman directo a
# httpx.AsyncClient sin executor.
#
# Background callers (intentions, clustering, ingest) siguen usando las
# versiones sync arriba — corren en Celery con asyncio.run, no se benefician
# de async aca.
# ─────────────────────────────────────────────────────────────────────────────


async def _aembed_tei(texts: list[str]) -> list[list[float] | None]:
    """Async version de _embed_tei."""
    if not texts:
        return []
    client = _get_tei_async_client()
    try:
        r = await client.post("/embed", json={"inputs": texts, "normalize": True})
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else [None] * len(texts)
    except Exception as exc:
        logger.error("aembed_tei_failed count=%d error=%s", len(texts), exc)
        return [None] * len(texts)


async def _aembed_openai(texts: list[str]) -> list[list[float] | None]:
    """Async version de _embed_openai — sin run_in_executor, libera el thread pool."""
    if not texts:
        return []
    client = _get_openai_async_client()
    cleaned = [_strip_e5_prefix(t) for t in texts]
    try:
        r = await client.post(
            "/embeddings",
            json={
                "model": settings.openai_embedding_model,
                "input": cleaned,
                "dimensions": EMBEDDING_DIM,
            },
        )
        r.raise_for_status()
        data = r.json()
        return [item["embedding"] for item in data["data"]]
    except Exception as exc:
        logger.error("aembed_openai_failed count=%d error=%s", len(texts), exc)
        return [None] * len(texts)


async def aembed_text(text: str) -> list[float] | None:
    """Async embed de un texto. Misma logica que embed_text pero non-blocking."""
    if _is_tei():
        result = await _aembed_tei([text])
        if result and result[0] is not None:
            return result[0]
        if settings.openai_api_key:
            logger.warning("aembed_tei_failed_fallback_openai")
            result = await _aembed_openai([text])
            return result[0] if result else None
        return None

    if _is_openai():
        result = await _aembed_openai([text])
        return result[0] if result else None

    # Fallback local: el modelo sentence-transformers es sync CPU-bound,
    # lo corremos en thread pool para no bloquear event loop. Solo si no
    # hay openai_api_key disponible (provider=local explicito).
    import asyncio as _asyncio_inner
    loop = _asyncio_inner.get_running_loop()
    return await loop.run_in_executor(None, embed_text, text)


async def aembed_query(query: str) -> list[float] | None:
    """Async embed de una query. Agrega prefijo 'query: ' (stripeado por OpenAI)."""
    return await aembed_text(f"query: {query}")
