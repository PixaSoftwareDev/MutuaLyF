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


def _get_openai_sync_client() -> httpx.Client:
    global _openai_sync_client
    if _openai_sync_client is None:
        _openai_sync_client = httpx.Client(
            base_url="https://api.openai.com/v1",
            headers={"Authorization": f"Bearer {settings.openai_api_key}"},
            timeout=15.0,
        )
    return _openai_sync_client


def _is_openai() -> bool:
    return (settings.embedding_provider or "local").lower() == "openai"


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
    """Embed a single text. Routes to OpenAI or local based on settings.

    Local model expects 'query: ' or 'passage: ' prefix; callers add it via
    embed_query / embed_passage. OpenAI strips these prefixes internally.
    """
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


def embed_passage(passage: str) -> list[float] | None:
    """Embed a document passage. Adds the 'passage: ' prefix required by e5 (stripped for OpenAI)."""
    return embed_text(f"passage: {passage}")


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
