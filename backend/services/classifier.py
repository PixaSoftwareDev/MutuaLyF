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

logger = logging.getLogger(__name__)


class IntentResult:
    def __init__(
        self,
        label: str | None,
        confidence: float,
        band: str,
        *,
        is_ambiguous: bool = False,
        second_label: str | None = None,
        second_confidence: float = 0.0,
    ) -> None:
        self.label = label
        self.confidence = confidence
        self.band = band  # 'high' | 'mid' | 'low' | 'unknown'
        self.is_ambiguous = is_ambiguous
        self.second_label = second_label
        self.second_confidence = second_confidence


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
                limit=2,
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

    # Second match (may be absent if collection has < 2 points)
    second_label: str | None = None
    second_confidence: float = 0.0
    if len(results) >= 2:
        second = results[1]
        second_confidence = float(second.score)
        second_label = second.payload.get("label") if second.payload else None

    if confidence >= settings.intent_confidence_high:
        band = _BAND_HIGH
    elif confidence >= settings.intent_confidence_mid:
        band = _BAND_MID
    else:
        band = _BAND_LOW

    # Ambiguity: top-1 is reasonable but top-2 is very close
    _AMBIGUITY_GAP = 0.08
    is_ambiguous = (
        confidence >= settings.intent_confidence_mid
        and second_label is not None
        and (confidence - second_confidence) < _AMBIGUITY_GAP
    )

    logger.debug(
        "classifier_result tenant_id=%s label=%s confidence=%.3f band=%s "
        "is_ambiguous=%s second_label=%s second_confidence=%.3f",
        tenant_id, label, confidence, band,
        is_ambiguous, second_label, second_confidence,
    )
    return IntentResult(
        label=label,
        confidence=confidence,
        band=band,
        is_ambiguous=is_ambiguous,
        second_label=second_label,
        second_confidence=second_confidence,
    )
