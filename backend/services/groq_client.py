"""Groq API client with model routing and retry logic."""

import asyncio
import logging
from typing import Any

# Texto canónico en services/prompt_registry.py (es la versión curada que
# vivía en la fila DB "Validador de documentos", eliminada en migración 046).
from services.prompt_registry import default as _prompt_default

DEFAULT_PROMPT_QUALITY_GATE = _prompt_default("quality_gate")

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
    timeout_s: float | None = None,
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
    # timeout_s explícito (p.ej. tareas largas como el análisis de un PDF de
    # documentación) tiene prioridad; si no, se deriva de la complejidad.
    timeout = timeout_s if timeout_s is not None else (
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


def _parse_tool_pick(msg: dict) -> dict | None:
    """Extrae la PRIMERA tool call del message del LLM (forma normalizada dict).

    Returns {"name": str, "arguments": dict} o None si el modelo respondió texto.
    """
    import json as _json

    tool_calls = msg.get("tool_calls") or []
    if not tool_calls:
        return None
    fn = tool_calls[0].get("function") or {}
    name = fn.get("name")
    if not name:
        return None
    raw_args = fn.get("arguments") or "{}"
    try:
        args = raw_args if isinstance(raw_args, dict) else _json.loads(raw_args)
    except (TypeError, ValueError):
        args = {}
    return {"name": name, "arguments": args if isinstance(args, dict) else {}}


@retry(
    retry=retry_if_exception(_is_retryable_llm_error),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    before_sleep=before_sleep_log(logger, logging.WARNING),
    reraise=True,
)
async def complete_with_tools(
    messages: list[dict[str, str]],
    tools: list[dict],
    *,
    complexity: str = QueryComplexity.SIMPLE,
    temperature: float = 0.0,
    max_tokens: int = 1024,
    tenant_id: str | None = None,
    timeout_s: float | None = None,
) -> tuple[str, dict | None]:
    """Chat completion CON function-calling (`tool_choice="auto"`).

    La primitiva del ruteo unificado: una sola llamada donde el modelo decide
    entre generar la respuesta o pedir una tool. También la usa select_tool
    (decisión de tool sola, para la rama hard-fallback del orquestador y el eval).

    Returns:
        (texto, tool_pick): si el modelo eligió tool, tool_pick={"name","arguments"}
        y texto puede ser "". Si respondió texto, tool_pick=None.
    """
    provider = (settings.llm_provider or "groq").lower()
    default_timeout = (
        settings.llm_reasoning_timeout_ms / 1000
        if complexity == QueryComplexity.COMPLEX
        else settings.llm_fast_timeout_ms / 1000
    )
    timeout = timeout_s if timeout_s is not None else default_timeout

    if provider == "openai":
        model = settings.openai_model
        client = _get_openai_http_client()
        async with _get_groq_semaphore():
            r = await client.post(
                "/chat/completions",
                json={
                    "model": model,
                    "messages": messages,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                    "tools": tools,
                    "tool_choice": "auto",
                },
                # Sin timeout_s explícito, mismo piso de 30s que complete(): es la
                # llamada de respuesta. Con timeout_s (router 2a), corta agresivo.
                timeout=timeout if timeout_s is not None else max(timeout, 30.0),
            )
            r.raise_for_status()
            data = r.json()
        msg = data["choices"][0]["message"]
        content = msg.get("content") or ""
        total_tokens = (data.get("usage") or {}).get("total_tokens", 0)
    else:
        model = _model_for_complexity(complexity)
        client = get_groq_client()
        async with _get_groq_semaphore():
            response = await client.chat.completions.create(
                model=model,
                messages=messages,  # type: ignore[arg-type]
                temperature=temperature,
                max_tokens=max_tokens,
                tools=tools,  # type: ignore[arg-type]
                tool_choice="auto",
                timeout=timeout,
            )
        # Normalizar a la misma forma dict que el path openai.
        _m = response.choices[0].message
        msg = {
            "tool_calls": [
                {"function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                for tc in (_m.tool_calls or [])
            ]
        }
        content = _m.content or ""
        total_tokens = response.usage.total_tokens if response.usage else 0

    if tenant_id and total_tokens > 0:
        try:
            asyncio.create_task(_log_llm_tokens(tenant_id, total_tokens))
        except RuntimeError:
            pass

    pick = _parse_tool_pick(msg)
    if pick:
        logger.info("tool_pick provider=%s tool=%s args=%s", provider, pick["name"], pick["arguments"])
    return content, pick


async def select_tool(
    messages: list[dict[str, str]],
    tools: list[dict],
    *,
    tenant_id: str | None = None,
) -> dict | None:
    """Solo la decisión de tool (modo 2a / hard-fallback): ofrece `tools` y devuelve
    la elegida o None. Wrapper de complete_with_tools con timeout AJUSTADO: corre en
    el hot path ANTES del RAG; si el proveedor se cuelga, mejor cortar a los pocos
    segundos y caer al RAG (fail-open) que bloquear el turno 30s.
    """
    _, pick = await complete_with_tools(
        messages, tools,
        max_tokens=512,
        tenant_id=tenant_id,
        timeout_s=max(settings.llm_fast_timeout_ms / 1000, 6.0),
    )
    return pick


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


async def complete_quality_gate(chunk_text: str, tenant_id: str, custom_prompt: str | None = None) -> dict[str, Any]:
    """Validate a chunk's factual coherence via Groq.

    Returns a dict with keys: is_coherent (bool), reason (str).
    On API failure, returns a sentinel that triggers the pending/retry flow.
    """
    # Precedencia: override por tenant (config) > override global del panel
    # (registro, fila "Validador de documentos") > default del código.
    if custom_prompt:
        system_prompt = custom_prompt.strip()
    else:
        from services.prompt_registry import get_text
        system_prompt = await get_text("quality_gate")
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
