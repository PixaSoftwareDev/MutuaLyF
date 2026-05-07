"""Intent classifier using embedding similarity against known intents.

Flow:
  1. Embed the incoming query
  2. Search {tenant_id}_intenciones collection in Qdrant
  3. Return best match with confidence score
  4. Apply confidence thresholds from settings
"""

import asyncio
import logging

from core.config import settings
from core.database import get_qdrant_client
from services.embeddings import embed_query

logger = logging.getLogger(__name__)


class IntentResult:
    def __init__(self, label: str | None, confidence: float, band: str) -> None:
        self.label = label
        self.confidence = confidence
        self.band = band  # 'high' | 'mid' | 'low' | 'unknown'


_BAND_UNKNOWN = "unknown"
_BAND_LOW = "low"
_BAND_MID = "mid"
_BAND_HIGH = "high"


async def classify_intent(query: str, tenant_id: str) -> IntentResult:
    """Classify a query against the tenant's known intents.

    Returns an IntentResult with the closest matching label and confidence.
    If no intents exist yet or Qdrant fails, returns band='unknown'.
    """
    from services.embedding_cache import embed_query_cached
    # Uses Redis cache (24h TTL) — avoids re-embedding identical or similar queries
    vector = await embed_query_cached(query)
    if vector is None:
        return IntentResult(label=None, confidence=0.0, band=_BAND_UNKNOWN)

    collection = f"{tenant_id}_intenciones"
    qdrant = get_qdrant_client()

    try:
        async with asyncio.timeout(settings.classifier_timeout_ms / 1000):
            results = await qdrant.search(
                collection_name=collection,
                query_vector=vector,
                limit=1,
                with_payload=True,
            )
    except Exception as exc:
        logger.warning("classifier_search_failed tenant_id=%s error=%s", tenant_id, exc)
        return IntentResult(label=None, confidence=0.0, band=_BAND_UNKNOWN)

    if not results:
        return IntentResult(label=None, confidence=0.0, band=_BAND_UNKNOWN)

    best = results[0]
    confidence = float(best.score)
    label: str | None = best.payload.get("label") if best.payload else None

    if confidence >= settings.intent_confidence_high:
        band = _BAND_HIGH
    elif confidence >= settings.intent_confidence_mid:
        band = _BAND_MID
    else:
        band = _BAND_LOW

    logger.debug(
        "classifier_result tenant_id=%s label=%s confidence=%.3f band=%s",
        tenant_id, label, confidence, band,
    )
    return IntentResult(label=label, confidence=confidence, band=band)
