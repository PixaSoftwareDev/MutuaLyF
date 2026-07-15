"""Intent classifier using embedding similarity against known intents.

Flow:
  1. Embed the incoming query
  2. Search {tenant_id}_intenciones collection in Qdrant
  3. Return best match with confidence score
  4. Apply confidence thresholds from settings
"""

import asyncio
import logging
import time

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

# Peso del boost léxico en el re-rank. Chico a propósito: solo inclina empates
# cercanos (turno/horario difieren ~0.02-0.05 en coseno), no tapa al embedding.
_KW_WEIGHT = 0.15

# Memo in-process por (tenant, query): el router de conectores y el orquestador
# clasifican el MISMO turno uno detrás del otro; sin esto cada mensaje del
# widget paga dos búsquedas en Qdrant. TTL corto: las intenciones cambian por
# acción del admin, 20s de staleness no afectan.
_MEMO_TTL_S = 20.0
_MEMO_MAX = 512
_memo: dict[tuple[str, str], tuple[float, "IntentResult"]] = {}


def _memo_get(key: tuple[str, str]) -> "IntentResult | None":
    hit = _memo.get(key)
    if hit is None:
        return None
    if (time.monotonic() - hit[0]) >= _MEMO_TTL_S:
        _memo.pop(key, None)
        return None
    return hit[1]


def _memo_put(key: tuple[str, str], result: "IntentResult") -> None:
    if len(_memo) >= _MEMO_MAX:
        for k in list(_memo)[: _MEMO_MAX // 4]:  # dict preserva orden de inserción
            _memo.pop(k, None)
    _memo[key] = (time.monotonic(), result)


async def classify_intent(query: str, tenant_id: str) -> IntentResult:
    """Classify a query against the tenant's known intents.

    Returns an IntentResult with the closest matching label and confidence.
    If no intents exist yet or Qdrant fails, returns band='unknown'.
    """
    memo_key = (tenant_id, query)
    memoized = _memo_get(memo_key)
    if memoized is not None:
        return memoized

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
                limit=6,   # top-K para re-rankear por keywords
                with_payload=True,
            )
    except Exception as exc:
        logger.warning("classifier_search_failed tenant_id=%s error=%s", tenant_id, exc)
        return IntentResult(label=None, confidence=0.0, band=_BAND_UNKNOWN)

    if not results:
        return IntentResult(label=None, confidence=0.0, band=_BAND_UNKNOWN)

    # ── Re-rank léxico: coseno + boost de keywords ─────────────────────────────
    # e5 confunde turno/horario (coseno casi idéntico). La señal léxica del label
    # desempata los casos cercanos sin afectar los que ganan por coseno amplio.
    # Se reporta el COSENO del elegido como confianza (semántica de umbral intacta).
    # Dedup por label: los top-K de Qdrant son EJEMPLOS, y varios puntos de la
    # misma intención no son ambigüedad — se compite entre labels distintos,
    # cada uno representado por su mejor punto.
    from services.intent_keywords import keyword_signal

    best_by_label: dict[str, tuple[float, float, float]] = {}
    for r in results:
        lbl = r.payload.get("label") if r.payload else None
        if not lbl:
            continue
        cos = float(r.score)
        sig = keyword_signal(query, lbl)
        combined = cos + _KW_WEIGHT * sig
        prev = best_by_label.get(lbl)
        if prev is None or combined > prev[0]:
            best_by_label[lbl] = (combined, cos, sig)
    if not best_by_label:
        return IntentResult(label=None, confidence=0.0, band=_BAND_UNKNOWN)

    ranked = sorted(
        ((c, cos, lbl, sig) for lbl, (c, cos, sig) in best_by_label.items()),
        key=lambda x: x[0], reverse=True,
    )

    combined_top, confidence, label, top_sig = ranked[0]

    second_label: str | None = None
    second_confidence: float = 0.0
    combined_second: float = 0.0
    if len(ranked) >= 2:
        combined_second, second_confidence, second_label, _ = ranked[1]

    cos_top1_label = results[0].payload.get("label") if results[0].payload else None
    if label != cos_top1_label:
        logger.info("classifier_rerank tenant_id=%s cos_top1=%s → keyword_pick=%s sig=%.2f",
                    tenant_id, cos_top1_label, label, top_sig)

    if confidence >= settings.intent_confidence_high:
        band = _BAND_HIGH
    elif confidence >= settings.intent_confidence_mid:
        band = _BAND_MID
    else:
        band = _BAND_LOW

    # Ambiguity: top-1 is reasonable but top-2 is very close.
    # El margen se mide en la MISMA escala que ordena (score combinado), nunca
    # en coseno crudo: si el re-rank léxico invierte el orden, el coseno del
    # runner-up puede superar al del ganador y un margen de cosenos daría
    # negativo → is_ambiguous=True por construcción, justo en los casos que el
    # re-rank resuelve bien.
    _AMBIGUITY_GAP = 0.08
    is_ambiguous = (
        confidence >= settings.intent_confidence_mid
        and second_label is not None
        and (combined_top - combined_second) < _AMBIGUITY_GAP
    )

    logger.debug(
        "classifier_result tenant_id=%s label=%s confidence=%.3f band=%s "
        "is_ambiguous=%s second_label=%s second_confidence=%.3f",
        tenant_id, label, confidence, band,
        is_ambiguous, second_label, second_confidence,
    )
    result = IntentResult(
        label=label,
        confidence=confidence,
        band=band,
        is_ambiguous=is_ambiguous,
        second_label=second_label,
        second_confidence=second_confidence,
    )
    # Solo se memoizan clasificaciones exitosas (los returns tempranos por error
    # de Qdrant/embedding no llegan acá y se reintentan en la próxima llamada).
    _memo_put(memo_key, result)
    return result
