"""Chunk-level near-duplicate detection (contra chunks EXISTENTES en Qdrant).

Estrategia: embed → Qdrant search (coseno) → confirmación por Jaccard de 5-gramas.
Se llama desde el pipeline de ingesta después del embedding y antes del upsert.
NUNCA bloquea la ingesta — todos los errores se capturan y loguean.
"""

import asyncio
import logging
import re
import unicodedata
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from services.chunker import Chunk

logger = logging.getLogger(__name__)

_MIN_WORDS_FOR_COMPARISON = 15
_DEFAULT_JACCARD_THRESHOLD = 0.85
_COSINE_PREFILTER_THRESHOLD = 0.88
# Búsquedas Qdrant concurrentes por documento. Antes eran secuenciales: un doc
# de 200 children pagaba 200 round-trips en serie dentro de la ingesta.
_SEARCH_CONCURRENCY = 8


# ── Text fingerprinting ────────────────────────────────────────────────────────

def compute_text_fingerprint(text: str) -> frozenset[str]:
    """Tokenize text into 5-grams of words for Jaccard comparison.

    Normalizes: lowercase, keep alphanum + spaces, split to words, then 5-grams.
    """
    # Decompose accented chars (á→a+combining_accent) then drop non-ASCII diacritics.
    # This keeps Spanish words intact: "información" → "informacion", not "informaci n".
    nfkd = unicodedata.normalize("NFKD", text.lower())
    ascii_text = nfkd.encode("ascii", errors="ignore").decode("ascii")
    normalized = re.sub(r"[^a-z0-9\s]", " ", ascii_text)
    words = normalized.split()
    if len(words) < 5:
        return frozenset(words)
    return frozenset(" ".join(words[i:i + 5]) for i in range(len(words) - 4))


def jaccard_similarity(set_a: frozenset[str], set_b: frozenset[str]) -> float:
    """Jaccard index between two frozensets. Returns 0.0 if both are empty."""
    if not set_a and not set_b:
        return 0.0
    intersection = len(set_a & set_b)
    union = len(set_a | set_b)
    return intersection / union if union > 0 else 0.0


# ── Against-existing comparison ───────────────────────────────────────────────

async def find_duplicates_against_existing(
    new_chunks: "list[Chunk]",
    tenant_id: str,
    vectors: list[list[float]],
    threshold: float = _DEFAULT_JACCARD_THRESHOLD,
    qdrant_client=None,
) -> list[dict]:
    """Compare new chunks against EXISTING chunks in Qdrant for this tenant.

    Strategy:
      1. For each new chunk, search Qdrant for top-3 similar existing chunks (cosine).
      2. For candidates with cosine > 0.88, compute Jaccard of text.
      3. Pairs above Jaccard threshold are reported. Pairs above cosine 0.88 but below
         Jaccard threshold are still recorded (cosine-only match, same meaning).

    Args:
        new_chunks: List of Chunk objects (from the current ingest batch).
        tenant_id: Tenant scope.
        vectors: Pre-computed embedding vectors aligned with new_chunks.
        threshold: Jaccard threshold for reporting a pair.
        qdrant_client: Injected Qdrant client (uses module singleton if None).

    Returns:
        List of dicts with keys: chunk_id_new, chunk_id_existing, doc_id_new,
        doc_id_existing, text_new, text_existing, jaccard, cosine.
    """
    if not new_chunks or not vectors:
        return []

    if qdrant_client is None:
        from core.database import get_qdrant_client
        qdrant_client = get_qdrant_client()

    collection = f"{tenant_id}_docs"
    candidates = [
        (chunk, vector)
        for chunk, vector in zip(new_chunks, vectors)
        if vector is not None and len(chunk.text.split()) >= _MIN_WORDS_FOR_COMPARISON
    ]
    if not candidates:
        return []

    sem = asyncio.Semaphore(_SEARCH_CONCURRENCY)

    async def _search(chunk, vector):
        async with sem:
            try:
                return await qdrant_client.search(
                    collection_name=collection,
                    query_vector=vector,
                    limit=3,
                    with_payload=True,
                    score_threshold=_COSINE_PREFILTER_THRESHOLD,
                )
            except Exception as exc:  # noqa: BLE001 — la dedup nunca bloquea la ingesta
                logger.warning(
                    "dup_qdrant_search_failed chunk_id=%s tenant_id=%s error=%s",
                    chunk.id, tenant_id, exc,
                )
                return []

    all_hits = await asyncio.gather(*[_search(c, v) for c, v in candidates])

    results: list[dict] = []
    for (chunk, _vector), hits in zip(candidates, all_hits):
        if not hits:
            continue
        fp_new = compute_text_fingerprint(chunk.text)

        for hit in hits:
            existing_text = hit.payload.get("text", "") if hit.payload else ""
            if not existing_text or len(existing_text.split()) < _MIN_WORDS_FOR_COMPARISON:
                continue

            existing_doc_id = hit.payload.get("document_id", "") if hit.payload else ""
            # Skip chunks from the same document (not cross-document duplicates)
            if existing_doc_id == chunk.document_id:
                continue

            jaccard = jaccard_similarity(fp_new, compute_text_fingerprint(existing_text))
            cosine = float(hit.score)
            # Report if high Jaccard (near-identical text) OR high cosine (same meaning)
            # cosine > 0.88 already guaranteed by score_threshold above
            if jaccard >= threshold or cosine >= _COSINE_PREFILTER_THRESHOLD:
                results.append({
                    "chunk_id_new": chunk.id,
                    "chunk_id_existing": str(hit.id),
                    "doc_id_new": chunk.document_id,
                    "doc_id_existing": existing_doc_id,
                    "text_new": chunk.text,
                    "text_existing": existing_text,
                    "jaccard": jaccard,
                    "cosine": cosine,
                })
                logger.debug(
                    "existing_duplicate_found chunk_id_new=%s chunk_id_existing=%s "
                    "jaccard=%.3f cosine=%.3f tenant_id=%s",
                    chunk.id, hit.id, jaccard, cosine, tenant_id,
                )

    return results
