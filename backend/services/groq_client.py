"""Groq API client with model routing and retry logic."""

import asyncio
import logging
from typing import Any

# ── Default prompts (used when tenant has no custom prompt configured) ─────────

DEFAULT_PROMPT_QUERY = (
    "Eres un asistente de conocimiento institucional. Tu única fuente de información son los documentos "
    "de la organización proporcionados en el contexto. NUNCA uses conocimiento propio o general.\n\n"
    "MODO CONVERSACIONAL: Si el usuario saluda, agradece o hace un comentario informal "
    "(ej: 'hola', 'gracias', '¿cómo estás?', 'buen día'), respondé de forma breve y amigable "
    "e invitalo a hacer su consulta. En este modo ignorá el contexto.\n\n"
    "MODO CONSULTA: Para cualquier pregunta concreta, aplicá estas reglas sin excepción:\n"
    "1. Usá ÚNICAMENTE la información del contexto proporcionado. Está terminantemente prohibido "
    "usar conocimiento propio, general o externo — aunque sepas la respuesta.\n"
    "2. Si el contexto no contiene información para responder la pregunta, respondé exactamente: "
    "'No tengo información sobre ese tema en los documentos de la organización.'\n"
    "3. Respondé DIRECTO y CONCISO. Para datos puntuales (número, fecha, nombre), una sola oración.\n"
    "4. No repitas la pregunta ni agregues aclaraciones obvias.\n"
    "5. Si el contexto está vacío, la respuesta es siempre la de la regla 2."
)

DEFAULT_PROMPT_QUALITY_GATE = (
    "Eres un evaluador de calidad de fragmentos de documentos institucionales. "
    "Determiná si el fragmento de texto contiene información útil que pueda responder "
    "preguntas de empleados o miembros de una organización. "
    "Marcá como coherente (true) si el fragmento contiene CUALQUIERA de: políticas, procedimientos, "
    "datos de contacto, nombres y roles, horarios, beneficios o normativas operativas — "
    "aunque sea parte de un documento más largo. "
    "Marcá como incoherente (false) SOLO si el fragmento es ruido puro: números de página, "
    "encabezados repetidos, texto ilegible o contenido completamente vacío. "
    "Evaluá también tu confianza en la decisión de 0.0 (completamente inseguro) a 1.0 (absolutamente seguro). "
    "Confianza alta (>0.85): el fragmento es claramente útil o claramente basura. "
    "Confianza baja (0.4-0.7): contenido ambiguo, contexto parcial o caso límite. "
    'Respondé ÚNICAMENTE con JSON válido: {"is_coherent": true/false, "confidence": 0.0-1.0, "reason": "una oración en español"}.'
)

DEFAULT_PROMPT_CLUSTER_LABEL = (
    "Eres un asistente que nombra intenciones de usuario para un chatbot corporativo. "
    "Dado un grupo de consultas similares, devuelve UN nombre corto (2-5 palabras) en español "
    "que describa la intención común, en formato snake_case. "
    'Responde SOLO con el nombre, sin comillas ni explicaciones. Ejemplo: "consulta_vacaciones"'
)

import httpx
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
_openai_http_client: httpx.AsyncClient | None = None


def _get_openai_http_client() -> httpx.AsyncClient:
    global _openai_http_client
    if _openai_http_client is None:
        _openai_http_client = httpx.AsyncClient(
            base_url="https://api.openai.com/v1",
            headers={"Authorization": f"Bearer {settings.openai_api_key}"},
            timeout=30.0,
        )
    return _openai_http_client

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
    tenant_id: str | None = None,
) -> str:
    """Send a chat completion request to Groq.

    Args:
        messages: List of role/content dicts. User input must be pre-sanitized.
        complexity: Routes to fast or reasoning model.
        temperature: Generation temperature.
        max_tokens: Maximum tokens in the response.
        tenant_id: When provided, total tokens used are logged to usage_events for billing.

    Returns:
        The model's response text.
    """
    provider = (settings.llm_provider or "groq").lower()
    timeout = (
        settings.llm_reasoning_timeout_ms / 1000
        if complexity == QueryComplexity.COMPLEX
        else settings.llm_fast_timeout_ms / 1000
    )

    if provider == "openai":
        model = settings.openai_model
        logger.debug("openai_request model=%s message_count=%d", model, len(messages))
        client = _get_openai_http_client()
        async with _get_groq_semaphore():
            r = await client.post(
                "/chat/completions",
                json={
                    "model": model,
                    "messages": messages,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                },
                timeout=max(timeout, 30.0),
            )
            r.raise_for_status()
            data = r.json()
        content = data["choices"][0]["message"]["content"] or ""
        total_tokens = (data.get("usage") or {}).get("total_tokens", 0)
        logger.debug("openai_response model=%s tokens=%d", model, total_tokens)
        try:
            from core.metrics import GROQ_REQUESTS_TOTAL
            GROQ_REQUESTS_TOTAL.labels(model=model, status="success").inc()
        except Exception:
            pass
        if tenant_id and total_tokens > 0:
            import asyncio as _asyncio
            _asyncio.create_task(_log_llm_tokens(tenant_id, total_tokens))
        return content

    model = _model_for_complexity(complexity)
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
    total_tokens = response.usage.total_tokens if response.usage else 0
    logger.debug("groq_response model=%s tokens=%d", model, total_tokens)
    try:
        from core.metrics import GROQ_REQUESTS_TOTAL
        GROQ_REQUESTS_TOTAL.labels(model=model, status="success").inc()
    except Exception:
        pass

    if tenant_id and total_tokens > 0:
        import asyncio as _asyncio
        _asyncio.create_task(_log_llm_tokens(tenant_id, total_tokens))

    return content


async def _log_llm_tokens(tenant_id: str, tokens: int) -> None:
    """Fire-and-forget logger of LLM token usage to usage_events for billing."""
    try:
        from core.database import get_pg_session
        from sqlalchemy import text as _sa_text
        async with get_pg_session() as session:
            await session.execute(
                _sa_text(
                    "INSERT INTO usage_events (tenant_id, event_type, value) "
                    "VALUES (:tenant_id, 'llm_tokens', :value)"
                ),
                {"tenant_id": tenant_id, "value": tokens},
            )
    except Exception as exc:
        logger.warning("llm_tokens_log_failed tenant=%s tokens=%d error=%s", tenant_id, tokens, exc)


async def suggest_cluster_label(sample_queries: list[str], custom_prompt: str | None = None) -> str:
    """Ask Groq to propose a short intent name for a cluster of similar queries.

    Returns a 2-5 word label in snake_case, or empty string on failure.
    """
    queries_text = "\n".join(f"- {q}" for q in sample_queries[:8])
    system_content = custom_prompt.strip() if custom_prompt else DEFAULT_PROMPT_CLUSTER_LABEL
    try:
        raw = await complete(
            messages=[
                {
                    "role": "system",
                    "content": system_content,
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


async def complete_quality_gate(chunk_text: str, tenant_id: str, custom_prompt: str | None = None) -> dict[str, Any]:
    """Validate a chunk's factual coherence via Groq.

    Returns a dict with keys: is_coherent (bool), reason (str).
    On API failure, returns a sentinel that triggers the pending/retry flow.
    """
    system_prompt = custom_prompt.strip() if custom_prompt else DEFAULT_PROMPT_QUALITY_GATE
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
        raw_conf = result.get("confidence", 0.9)
        confidence = float(max(0.0, min(1.0, raw_conf)))
        return {
            "is_coherent": bool(result.get("is_coherent", True)),
            "confidence": confidence,
            "reason": str(result.get("reason", "")),
            "error": None,
        }
    except (APIError, APITimeoutError, RateLimitError) as exc:
        logger.warning("quality_gate_groq_failure tenant_id=%s error=%s", tenant_id, exc)
        try:
            from core.metrics import GROQ_REQUESTS_TOTAL
            _status = "rate_limit" if isinstance(exc, RateLimitError) else "timeout" if isinstance(exc, APITimeoutError) else "error"
            GROQ_REQUESTS_TOTAL.labels(model=settings.groq_model_fast, status=_status).inc()
        except Exception:
            pass
        return {"is_coherent": None, "reason": None, "error": str(exc)}
    except Exception as exc:
        # JSON parse failed — treat as Groq-unavailable so quality_gate marks it PENDING and retries
        logger.warning("quality_gate_parse_failure tenant_id=%s error=%s", tenant_id, exc)
        return {"is_coherent": None, "reason": None, "error": str(exc)}
