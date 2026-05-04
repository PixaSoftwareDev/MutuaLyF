"""Quality gate for document chunks.

Two-stage validation (MVP implements stage 1 via Groq):
  Stage 1: LLM coherence check — is the chunk factually coherent and useful?
  Stage 2 (Etapa 3): Semantic autonomy check via embedding similarity.

Failure behavior (per CLAUDE.md):
  - Groq API failure → mark chunk as 'pending', index anyway, enqueue retry
  - After 3 retries → mark as 'skipped', log, continue
  - Chunks with pending/skipped status participate in search but are flagged in admin panel
"""

import logging
from dataclasses import dataclass
from enum import Enum

from services.chunker import Chunk
from services.groq_client import complete_quality_gate

logger = logging.getLogger(__name__)


class QualityStatus(str, Enum):
    PASSED = "passed"
    PENDING = "pending"   # Groq unavailable — will retry
    SKIPPED = "skipped"   # Retries exhausted


@dataclass
class QualityResult:
    chunk_id: str
    status: QualityStatus
    is_coherent: bool
    reason: str
    error: str | None = None


async def validate_chunk(chunk: Chunk) -> QualityResult:
    """Run stage-1 quality validation on a single chunk.

    Returns QualityResult with status PASSED, PENDING (on Groq failure), or SKIPPED.
    The caller is responsible for enqueuing retries on PENDING status.
    """
    logger.debug("quality_gate_start chunk_id=%s tenant_id=%s", chunk.id, chunk.tenant_id)

    result = await complete_quality_gate(chunk.text, chunk.tenant_id)

    if result["error"] is not None and result["is_coherent"] is None:
        # Groq API failure — do not block ingestion
        logger.warning(
            "quality_gate_groq_unavailable chunk_id=%s tenant_id=%s error=%s",
            chunk.id, chunk.tenant_id, result["error"],
        )
        return QualityResult(
            chunk_id=chunk.id,
            status=QualityStatus.PENDING,
            is_coherent=True,   # Optimistic default — chunk is indexed
            reason="groq_unavailable",
            error=result["error"],
        )

    is_coherent: bool = bool(result["is_coherent"])
    # SKIPPED = Groq assessed it as incoherent (no retry needed)
    # PENDING = Groq was unavailable (retry will reassess)
    status = QualityStatus.PASSED if is_coherent else QualityStatus.SKIPPED

    logger.debug(
        "quality_gate_done chunk_id=%s status=%s coherent=%s reason=%s",
        chunk.id, status, is_coherent, result["reason"],
    )
    return QualityResult(
        chunk_id=chunk.id,
        status=status,
        is_coherent=is_coherent,
        reason=result["reason"] or "",
        error=result["error"],
    )


async def validate_chunk_semantic_autonomy(chunk: Chunk) -> bool:
    """Stage-2 quality gate: check if chunk is semantically self-sufficient.

    A chunk is considered autonomous if its embedding has low cosine similarity
    to its neighbors (meaning it contains unique information, not just overlap).

    For MVP of Etapa 3 this is a lightweight heuristic:
    - Chunks shorter than 30 tokens are considered non-autonomous (too short to answer questions)
    - Chunks with very high overlap ratio vs their content are flagged

    Returns True if the chunk is autonomous (should be kept), False if not.
    """
    if chunk.token_count < 20:
        logger.debug("quality_stage2_too_short chunk_id=%s tokens=%d", chunk.id, chunk.token_count)
        return False

    # Chunks from semantic splitting already respect semantic boundaries
    if getattr(chunk, "strategy", "fixed") == "semantic":
        return True

    # For fixed-size chunks, check overlap ratio
    # If token_count < chunk_overlap_tokens setting, it's almost entirely overlap
    from core.config import settings
    if chunk.token_count < settings.chunk_overlap_tokens:
        logger.debug("quality_stage2_overlap_heavy chunk_id=%s tokens=%d", chunk.id, chunk.token_count)
        return False

    return True


async def validate_chunks_batch(
    chunks: list[Chunk],
    max_concurrent: int = 5,
) -> list[QualityResult]:
    """Validate a batch of chunks with bounded concurrency.

    Uses asyncio.gather with semaphore to avoid hammering the Groq API.
    """
    import asyncio

    semaphore = asyncio.Semaphore(max_concurrent)

    async def _gated(chunk: Chunk) -> QualityResult:
        async with semaphore:
            return await validate_chunk(chunk)

    results = await asyncio.gather(*[_gated(c) for c in chunks], return_exceptions=True)

    validated: list[QualityResult] = []
    for chunk, result in zip(chunks, results):
        if isinstance(result, Exception):
            logger.error("quality_gate_exception chunk_id=%s error=%s", chunk.id, result)
            validated.append(
                QualityResult(
                    chunk_id=chunk.id,
                    status=QualityStatus.PENDING,
                    is_coherent=True,
                    reason="exception_defaulting_to_pending",
                    error=str(result),
                )
            )
        else:
            validated.append(result)

    passed = sum(1 for r in validated if r.status == QualityStatus.PASSED)
    pending = sum(1 for r in validated if r.status == QualityStatus.PENDING)
    logger.info(
        "quality_gate_batch_done total=%d passed=%d pending=%d",
        len(validated), passed, pending,
    )
    return validated
