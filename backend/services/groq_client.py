"""Groq API client with model routing and retry logic."""

import asyncio
import logging
from typing import Any

from groq import AsyncGroq, APIError, APITimeoutError, RateLimitError
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
    before_sleep_log,
)

from core.config import settings

logger = logging.getLogger(__name__)

_groq_client: AsyncGroq | None = None

# Global semaphore: max concurrent Groq requests across queries + quality gate.
# Prevents quality gate batch from starving user-facing queries.
# 4 total: 3 for user queries (orchestrator) + 1 reserved for quality gate.
_GROQ_SEMAPHORE: asyncio.Semaphore | None = None
_GROQ_MAX_CONCURRENT = 4
_QUALITY_GATE_MAX_CONCURRENT = 1  # Quality gate takes max 1 slot to avoid starving queries


def _get_groq_semaphore() -> asyncio.Semaphore:
    global _GROQ_SEMAPHORE
    if _GROQ_SEMAPHORE is None:
        _GROQ_SEMAPHORE = asyncio.Semaphore(_GROQ_MAX_CONCURRENT)
    return _GROQ_SEMAPHORE


def get_groq_client() -> AsyncGroq:
    global _groq_client
    if _groq_client is None:
        _groq_client = AsyncGroq(api_key=settings.groq_api_key)
    return _groq_client


class QueryComplexity:
    """Threshold for routing queries to fast vs. reasoning model."""
    SIMPLE = "simple"
    COMPLEX = "complex"


def classify_complexity(question: str, entity_count: int = 0) -> str:
    """Decide model tier based on question length and entity density.

    Heuristic: multi-sentence questions or many entities go to the reasoning model.
    The orchestrator can override this with a more sophisticated classifier.
    """
    word_count = len(question.split())
    # Mid-sentence "?" = complex (e.g., "What is X? And also Y?")
    # Spanish "¿" at start counts as complex only if the question is long enough
    has_mid_question = "?" in question[:-1]
    has_spanish_complex = question.startswith("¿") and word_count > 12
    if word_count > 25 or entity_count >= 3 or has_mid_question or has_spanish_complex:
        return QueryComplexity.COMPLEX
    return QueryComplexity.SIMPLE


def _model_for_complexity(complexity: str) -> str:
    """Return the Groq model ID for the given complexity tier.

    Always reads from settings — never hardcodes model IDs.
    """
    if complexity == QueryComplexity.COMPLEX:
        return settings.groq_model_reasoning
    return settings.groq_model_fast


@retry(
    retry=retry_if_exception_type((APITimeoutError, RateLimitError)),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    before_sleep=before_sleep_log(logger, logging.WARNING),
    reraise=True,
)
async def complete(
    messages: list[dict[str, str]],
    complexity: str = QueryComplexity.SIMPLE,
    temperature: float = 0.0,
    max_tokens: int = 1024,
) -> str:
    """Send a chat completion request to Groq.

    Args:
        messages: List of role/content dicts. User input must be pre-sanitized.
        complexity: Routes to fast or reasoning model.
        temperature: Generation temperature.
        max_tokens: Maximum tokens in the response.

    Returns:
        The model's response text.
    """
    model = _model_for_complexity(complexity)
    timeout = (
        settings.llm_reasoning_timeout_ms / 1000
        if complexity == QueryComplexity.COMPLEX
        else settings.llm_fast_timeout_ms / 1000
    )

    logger.debug("groq_request model=%s message_count=%d", model, len(messages))

    client = get_groq_client()
    async with _get_groq_semaphore():
        response = await client.chat.completions.create(
            model=model,
            messages=messages,  # type: ignore[arg-type]
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
        )

    content = response.choices[0].message.content or ""
    logger.debug("groq_response model=%s tokens=%d", model, response.usage.total_tokens if response.usage else 0)
    from core.metrics import GROQ_REQUESTS_TOTAL
    GROQ_REQUESTS_TOTAL.labels(model=model, status="success").inc()
    return content


async def suggest_cluster_label(sample_queries: list[str]) -> str:
    """Ask Groq to propose a short intent name for a cluster of similar queries.

    Returns a 2-5 word label in snake_case, or empty string on failure.
    """
    queries_text = "\n".join(f"- {q}" for q in sample_queries[:8])
    try:
        raw = await complete(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Eres un asistente que nombra intenciones de usuario para un chatbot corporativo. "
                        "Dado un grupo de consultas similares, devuelve UN nombre corto (2-5 palabras) en español "
                        "que describa la intención común, en formato snake_case. "
                        'Responde SOLO con el nombre, sin comillas ni explicaciones. Ejemplo: "consulta_vacaciones"'
                    ),
                },
                {
                    "role": "user",
                    "content": f"Consultas del grupo:\n{queries_text}\n\nNombre de la intención:",
                },
            ],
            complexity=QueryComplexity.SIMPLE,
            temperature=0.2,
            max_tokens=20,
        )
        label = raw.strip().strip('"').strip("'").lower().replace(" ", "_")
        # Sanitize to alphanumeric + underscore only
        label = "".join(c for c in label if c.isalnum() or c == "_")
        return label[:60] if label else ""
    except Exception as exc:
        logger.warning("suggest_cluster_label_failed error=%s", exc)
        return ""


async def complete_quality_gate(chunk_text: str, tenant_id: str) -> dict[str, Any]:
    """Validate a chunk's factual coherence via Groq.

    Returns a dict with keys: is_coherent (bool), reason (str).
    On API failure, returns a sentinel that triggers the pending/retry flow.
    """
    # Input is placed in a variable — never interpolated directly into the system prompt
    system_prompt = (
        "You are a document quality evaluator for institutional knowledge bases. "
        "Determine if the provided text chunk contains useful information that could answer "
        "questions from employees or members of an organization. "
        "Mark as coherent (true) if the chunk contains ANY of: policies, procedures, contact info, "
        "names and roles, schedules, benefits, or operational guidelines — even if it's part of a larger document. "
        "Mark as incoherent (false) ONLY if the chunk is pure noise: page numbers, repeated headers, "
        "garbled text, or completely empty content. "
        "Respond ONLY with valid JSON: {\"is_coherent\": true/false, \"reason\": \"one sentence\"}."
    )
    user_content = chunk_text[:2000]  # Truncate to avoid token overflow

    try:
        raw = await complete(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            complexity=QueryComplexity.SIMPLE,
            temperature=0.0,
            max_tokens=100,
        )
        import json
        result = json.loads(raw.strip())
        return {
            "is_coherent": bool(result.get("is_coherent", True)),
            "reason": str(result.get("reason", "")),
            "error": None,
        }
    except (APIError, APITimeoutError, RateLimitError) as exc:
        logger.warning("quality_gate_groq_failure tenant_id=%s error=%s", tenant_id, exc)
        from core.metrics import GROQ_REQUESTS_TOTAL
        status = "rate_limit" if isinstance(exc, RateLimitError) else "timeout" if isinstance(exc, APITimeoutError) else "error"
        GROQ_REQUESTS_TOTAL.labels(model=settings.groq_model_fast, status=status).inc()
        return {"is_coherent": None, "reason": None, "error": str(exc)}
    except Exception as exc:
        # JSON parse failed — treat as Groq-unavailable so quality_gate marks it PENDING and retries
        logger.warning("quality_gate_parse_failure tenant_id=%s error=%s", tenant_id, exc)
        return {"is_coherent": None, "reason": None, "error": str(exc)}
