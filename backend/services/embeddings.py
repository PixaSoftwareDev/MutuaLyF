"""Embedding service using multilingual-e5-large.

Single model instance shared across RAG, classifier, and ingest pipeline.
NEVER use bge-large-en-v1.5 — English-only, incompatible with Spanish corpus.
"""

import logging
from functools import lru_cache
from typing import Any

import numpy as np

from core.config import settings

logger = logging.getLogger(__name__)

EMBEDDING_DIM = 1024  # multilingual-e5-large output dimension


@lru_cache(maxsize=1)
def _load_model():
    """Load sentence-transformers model once and cache. Thread-safe via GIL for inference."""
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


def embed_text(text: str) -> list[float] | None:
    """Embed a single text string.

    multilingual-e5-large expects the prefix 'query: ' for query texts
    and 'passage: ' for document chunks. See model card for details.

    Returns None if the model is unavailable.
    """
    model = _load_model()
    if model is None:
        return None

    try:
        # Prefix is handled by the caller via embed_query / embed_passage
        vector = model.encode(text, normalize_embeddings=True)
        return vector.tolist()
    except Exception as exc:
        logger.error("embed_text_failed error=%s", exc)
        return None


def embed_query(query: str) -> list[float] | None:
    """Embed a user query. Adds the 'query: ' prefix required by e5 models."""
    return embed_text(f"query: {query}")


def embed_passage(passage: str) -> list[float] | None:
    """Embed a document passage. Adds the 'passage: ' prefix required by e5 models."""
    return embed_text(f"passage: {passage}")


def embed_batch(texts: list[str], is_query: bool = False) -> list[list[float] | None]:
    """Embed a batch of texts efficiently using batch inference.

    Args:
        texts: List of raw strings (prefixes will be added automatically).
        is_query: If True, applies 'query: ' prefix; else 'passage: '.

    Returns:
        List of embedding vectors (or None on failure per item).
    """
    model = _load_model()
    if model is None:
        return [None] * len(texts)

    prefix = "query: " if is_query else "passage: "
    prefixed = [f"{prefix}{t}" for t in texts]

    try:
        vectors = model.encode(prefixed, normalize_embeddings=True, batch_size=32)
        return [v.tolist() for v in vectors]
    except Exception as exc:
        logger.error("embed_batch_failed error=%s", exc)
        return [None] * len(texts)
