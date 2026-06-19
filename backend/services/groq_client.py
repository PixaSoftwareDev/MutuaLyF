"""Groq API client with model routing and retry logic."""

import asyncio
import logging
from typing import Any

# Emergency fallbacks — only used when DB templates are unreachable.
# Kept in sync with migration 006_prompts_v2.py.

DEFAULT_PROMPT_QUALITY_GATE = (
    "Sos un filtro de ruido para fragmentos de documentos. Tu única tarea es detectar "
    "si el fragmento tiene información que un lector humano pueda aprovechar. "
    "No importa el tema — técnico, legal, institucional, operativo, lo que sea. "
    "APROBÁ (true) si contiene texto coherente con información factual, descriptiva o instructiva, "
    "nombres, fechas, cifras, contactos, roles, procesos, definiciones, normativas o procedimientos. "
    "RECHAZÁ (false) SOLO si es ruido puro: solo números de página, solo encabezados/pies repetidos, "
    "texto ilegible por OCR fallido, contenido vacío, o entradas de índice sin descripción. "
    "EN CASO DE DUDA: aprobá. "
    'Respondé ÚNICAMENTE con JSON válido: {"is_coherent": true/false, "confidence": 0.0-1.0, "reason": "una oración en español"}.'
)

DEFAULT_PROMPT_CLUSTER_LABEL = (
    "Tu tarea: generar el nombre de una intención de usuario para un chatbot institucional. "
    "Analizá el grupo de consultas y generá UN nombre corto en snake_case (2-4 palabras, sin tildes). "
    "Describí la necesidad específica, no el tema genérico. "
    "Ejemplos buenos: solicitar_certificado, consulta_horario, tramite_jubilacion. "
    "Ejemplos malos: consulta, pregunta, informacion, otro. "
    "Respondé SOLO con el nombre en snake_case, sin comillas ni explicaciones."
)

import httpx
from groq import AsyncGroq, APIError, APITimeoutError, RateLimitError
from tenacity import (
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
    before_sleep_log,
)

from core.config import settings

logger = logging.getLogger(__name__)

_groq_client: AsyncGroq | None = None
_groq_client_loop: asyncio.AbstractEventLoop | None = None
_openai_http_client: httpx.AsyncClient | None = None
_openai_http_client_loop: asyncio.AbstractEventLoop | None = None

# Global semaphore: max concurrent LLM requests POR WORKER uvicorn.
# Lee de settings.llm_max_concurrent_per_worker (default 50).
# - OpenAI Tier 1 paid (500 RPM = ~8 RPS): 50 por worker × 4 workers = 200 max
#   concurrent. Bien debajo del rate limit real.
# - OpenAI Tier 2+ (5000 RPM): subir a 100-200.
# - Groq free tier (30 RPM): bajar a 4-7.
# El semaforo es por event loop (per-worker), no global cross-process.
# Name kept as _GROQ_* for historical compatibility — applies to cualquier provider.
_GROQ_SEMAPHORE: asyncio.Semaphore | None = None
_GROQ_SEMAPHORE_LOOP: asyncio.AbstractEventLoop | None = None
_QUALITY_GATE_MAX_CONCURRENT = 1  # Quality gate takes max 1 slot to avoid starving queries


def _current_loop() -> asyncio.AbstractEventLoop | None:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None


def _get_openai_http_client() -> httpx.AsyncClient:
    global _openai_http_client, _openai_http_client_loop
    loop = _current_loop()
    if _openai_http_client is None or loop is not _openai_http_client_loop:
        # Pool grande: bajo carga, 4 workers x 50 concurrentes pueden hacer
        # cientos de calls en flight. Default httpx (100/20) es chico.
        _openai_http_client = httpx.AsyncClient(
            base_url="https://api.openai.com/v1",
            headers={"Authorization": f"Bearer {settings.openai_api_key}"},
            timeout=30.0,
            limits=httpx.Limits(
                max_connections=settings.http_pool_max_connections,
                max_keepalive_connections=settings.http_pool_max_keepalive,
            ),
        )
        _openai_http_client_loop = loop
    return _openai_http_client


def _get_groq_semaphore() -> asyncio.Semaphore:
    global _GROQ_SEMAPHORE, _GROQ_SEMAPHORE_LOOP
    loop = _current_loop()
    if _GROQ_SEMAPHORE is None or loop is not _GROQ_SEMAPHORE_LOOP:
        _GROQ_SEMAPHORE = asyncio.Semaphore(settings.llm_max_concurrent_per_worker)
        _GROQ_SEMAPHORE_LOOP = loop
    return _GROQ_SEMAPHORE


def get_groq_client() -> AsyncGroq:
    global _groq_client, _groq_client_loop
    loop = _current_loop()
    if _groq_client is None or loop is not _groq_client_loop:
        _groq_client = AsyncGroq(api_key=settings.groq_api_key)
        _groq_client_loop = loop
    return _groq_client


class QueryComplexity:
    """Threshold for routing queries to fast vs. reasoning model."""
    SIMPLE = "simple"
    COMPLEX = "complex"


def classify_complexity(question: str, entity_count: int = 0) -> str:
    """Decide model tier por SEÑALES DE COMPLEJIDAD REAL, no por puntuación.

    Antes: cualquier "?" en el medio mandaba al modelo lento (3x) aunque fuera
    trivial, y la complejidad en español requería un "¿" literal que en mobile
    nadie escribe → preguntas complejas iban al modelo rápido. Ahora:
      - Consulta larga (> 20 palabras) → razonamiento.
      - Multi-pregunta genuina (2+ signos "?") → razonamiento.
      - Muchas entidades nombradas → razonamiento (cuando NLU esté activo).
    """
    word_count = len(question.split())
    is_long = word_count > 20
    is_multi_question = question.count("?") >= 2
    if is_long or is_multi_question or entity_count >= 3:
        return QueryComplexity.COMPLEX
    return QueryComplexity.SIMPLE


def _model_for_complexity(complexity: str) -> str:
    """Return the Groq model ID for the given complexity tier.

    Always reads from settings — never hardcodes model IDs.
    """
    if complexity == QueryComplexity.COMPLEX:
        return settings.groq_model_reasoning
    return settings.groq_model_fast


def _is_retryable_llm_error(exc: BaseException) -> bool:
    """¿El error del LLM justifica reintentar? Cubre AMBOS providers:
      - groq SDK: APITimeoutError, RateLimitError.
      - OpenAI (httpx crudo): timeouts / errores de conexión, y HTTP 429/5xx.
    Los 4xx definitivos (401 token inválido, 400 request malo) NO se reintentan
    — reintentarlos sería inútil y solo agregaría latencia."""
    if isinstance(exc, (APITimeoutError, RateLimitError, httpx.TimeoutException, httpx.ConnectError)):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in (429, 500, 502, 503, 504)
    return False


@retry(
    retry=retry_if_exception(_is_retryable_llm_error),
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
        try:
            import asyncio as _asyncio
            _asyncio.create_task(_log_llm_tokens(tenant_id, total_tokens))
        except RuntimeError:
            # No running event loop (e.g. Celery worker context) — skip fire-and-forget log
            pass

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
