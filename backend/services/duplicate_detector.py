"""Chunk-level near-duplicate detection.

Two strategies:
  1. Within-batch Jaccard: compare new chunks against each other using 5-gram fingerprints.
  2. Against-existing cosine+Jaccard: embed → Qdrant search → Jaccard confirmation.

These functions are called from the ingest pipeline after embedding and before Qdrant upsert.
They NEVER block ingestion — all errors are caught and logged.
"""

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


# ── Within-batch comparison ────────────────────────────────────────────────────

async def find_chunk_duplicates_in_batch(
    new_chunks: "list[Chunk]",
    tenant_id: str,
    threshold: float = _DEFAULT_JACCARD_THRESHOLD,
) -> list[tuple[int, int, float]]:
    """Compare new chunks against each other within the same ingest batch.

    Returns list of (idx_a, idx_b, jaccard_score) for pairs above threshold.
    Only compares pairs where both chunks have >= 15 words (skip tiny chunks).
    """
    # Build fingerprints only for chunks with enough words
    fingerprints: list[frozenset[str] | None] = []
    for chunk in new_chunks:
        words = chunk.text.split()
        if len(words) >= _MIN_WORDS_FOR_COMPARISON:
            fingerprints.append(compute_text_fingerprint(chunk.text))
        else:
            fingerprints.append(None)

    pairs: list[tuple[int, int, float]] = []
    n = len(new_chunks)
    for i in range(n):
        if fingerprints[i] is None:
            continue
        for j in range(i + 1, n):
            if fingerprints[j] is None:
                continue
            score = jaccard_similarity(fingerprints[i], fingerprints[j])
            if score >= threshold:
                pairs.append((i, j, score))
                logger.debug(
                    "batch_duplicate_found idx_a=%d idx_b=%d jaccard=%.3f tenant_id=%s",
                    i, j, score, tenant_id,
                )

    return pairs


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
    qdrant = qdrant_client
    results: list[dict] = []

    for chunk, vector in zip(new_chunks, vectors):
        if vector is None:
            continue
        words = chunk.text.split()
        if len(words) < _MIN_WORDS_FOR_COMPARISON:
            continue

        try:
            hits = await qdrant.search(
                collection_name=collection,
                query_vector=vector,
                limit=3,
                with_payload=True,
                score_threshold=_COSINE_PREFILTER_THRESHOLD,
            )
        except Exception as exc:
            logger.warning(
                "dup_qdrant_search_failed chunk_id=%s tenant_id=%s error=%s",
                chunk.id, tenant_id, exc,
            )
            continue

        fp_new = compute_text_fingerprint(chunk.text)

        for hit in hits:
            existing_text = hit.payload.get("text", "") if hit.payload else ""
            if not existing_text:
                continue
            existing_words = existing_text.split()
            if len(existing_words) < _MIN_WORDS_FOR_COMPARISON:
                continue

            fp_existing = compute_text_fingerprint(existing_text)
            jaccard = jaccard_similarity(fp_new, fp_existing)
            cosine = float(hit.score)
            existing_doc_id = hit.payload.get("document_id", "") if hit.payload else ""

            # Skip chunks from the same document (not cross-document duplicates)
            if existing_doc_id == chunk.document_id:
                continue

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
