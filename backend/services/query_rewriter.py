"""Query rewriting con contexto conversacional.

Resuelve dos problemas clásicos del RAG:

  1. VOCABULARY MISMATCH
     User: "dirección de la mutual"
     Chunk: "Sede central: Av. Brigadier López 567, Santa Fe"
     Sin la palabra "dirección" en el chunk, el embedding del query no matchea.

  2. REFORMULACIONES Y FOLLOW-UPS
     Turno 1 user: "¿qué es mutualyf?"
     Turno 1 bot:  "La Mutual Provincial de Luz y Fuerza de Santa Fe..."
     Turno 2 user: "¿dónde está emplazada?"
     ↑ esta query aislada no tiene contexto suficiente para el RAG.

Solución (patrón estándar — LangChain MultiQueryRetriever, LlamaIndex HyDE):

  Antes del retrieval, un LLM rápido recibe (query + last 2-3 turns) y devuelve
  1 main rewrite + N variants. El orchestrator hace retrieval con cada una y
  fusiona resultados con RRF.

Cache: Redis DB 1, TTL 24h, key = SHA-256(normalized query + recent history fingerprint).

Fallback: si el LLM call falla o timeoutea, devolvemos la query original →
degraded mode sin romper el flujo.
"""

import asyncio
import hashlib
import json
import logging
import re
from dataclasses import dataclass

from core.config import settings
from core.database import get_redis_cache
from services.groq_client import complete, QueryComplexity

logger = logging.getLogger(__name__)


@dataclass
class RewriteResult:
    """Resultado del rewriting: la query principal + variants para multi-query retrieval."""
    main: str
    variants: list[str]
    used_cache: bool = False
    fallback: bool = False  # True si el LLM falló y devolvimos solo la query original
    skipped: bool = False   # True si la heurística decidió no rewriter (query ya específica)

    @property
    def all_queries(self) -> list[str]:
        """Lista completa de queries para el retrieval — main + variants (dedup)."""
        seen: set[str] = set()
        out: list[str] = []
        for q in [self.main, *self.variants]:
            q = q.strip()
            key = q.lower()
            if q and key not in seen:
                seen.add(key)
                out.append(q)
        return out


# Pronombres interrogativos en español + inglés + portugués — cualquier query que
# empiece con uno de estos suele tener vocabulary mismatch (la palabra concreta
# no aparece literalmente en el texto del chunk objetivo).
_INTERROGATIVE_STARTS = {
    # Español
    "que", "qué", "quien", "quién", "quienes", "quiénes",
    "donde", "dónde", "cuando", "cuándo", "cuanto", "cuánto",
    "cuanta", "cuánta", "cuantos", "cuántos", "cuantas", "cuántas",
    "como", "cómo", "cual", "cuál", "cuales", "cuáles",
    "por", "para",  # "por qué" / "para qué"
    # Inglés
    "what", "where", "when", "who", "whom", "how", "why", "which",
    # Portugués
    "o", "onde", "quando", "quem", "como", "qual", "quanto",
}


def should_rewrite(query: str) -> bool:
    """Decide si vale la pena correr el rewriter para esta query.

    Heurística (orden de evaluación):
      1. Query vacía → False (nada que reescribir)
      2. Query muy larga (>max_query_words) → False (ya es específica)
      3. Query corta (≤short_threshold palabras) → True (vocabulary mismatch típico)
      4. Empieza con pronombre interrogativo → True (questions abstractas)
      5. Otro caso → False (skip, ya tiene suficiente contexto)

    Beneficio: queries detalladas evitan los 500-2500ms del LLM call extra.
    Queries cortas/ambiguas siguen recibiendo el rewriting que aporta recall.
    """
    if not query or not query.strip():
        return False
    words = query.strip().split()
    if len(words) > settings.query_rewriting_max_query_words:
        return False
    if len(words) <= settings.query_rewriting_short_threshold:
        return True
    # Limpiar primera palabra: lowercase + strip puntuación
    first = words[0].lower().strip("¿?¡!.,;:\"'()[]")
    if first in _INTERROGATIVE_STARTS:
        return True
    return False


# ── Prompt template (genérico, multi-tenant, multi-idioma) ─────────────────
# Sin ejemplos sectoriales hardcodeados — el contexto de la organización
# se inyecta dinámicamente vía bot_description cuando está disponible.

_REWRITE_SYSTEM_PROMPT = """\
Sos un módulo de reformulación de queries para un sistema de búsqueda semántica
sobre documentos institucionales.

Tu tarea: dado una consulta del usuario y el historial de la conversación, devolver:
1. Una versión REESCRITA y ENRIQUECIDA de la consulta, agregando contexto del
   historial si la consulta es elíptica (ej: "¿dónde está?" sin contexto
   → "¿dónde está la sede de la organización?").
2. Hasta {n} VARIANTES con sinónimos y formas alternativas de expresar la misma
   intención. Cada variante debe ser autosuficiente, sin pronombres ni referencias ambiguas.

Reglas:
- Mantené el idioma de la consulta original.
- No inventes datos que no estén en la consulta ni en el historial.
- No respondas la pregunta, solo reformulala.
- Si la consulta ya es específica y autosuficiente (>20 palabras), la main = query original.
- Para las variantes: usá sinónimos naturales del dominio de la organización descrita abajo.{org_context}

Formato de salida: JSON exacto, sin texto adicional, sin markdown:
{{"main": "...", "variants": ["...", "..."]}}
"""

_ORG_CONTEXT_BLOCK = "\n\nContexto de la organización (usalo para generar sinónimos relevantes):\n{bot_description}"


def _build_history_block(history: list[tuple[str, str]] | None, max_turns: int = 3) -> str:
    """Construye un bloque corto con los últimos N turnos para dar contexto al rewriter."""
    if not history:
        return "(sin historial previo)"
    recent = history[-max_turns:]
    lines = []
    role_label = {"user": "Usuario", "bot": "Asistente"}
    for sender, content in recent:
        label = role_label.get(sender, sender)
        excerpt = content[:300].replace("\n", " ")
        if len(content) > 300:
            excerpt += "…"
        lines.append(f"{label}: {excerpt}")
    return "\n".join(lines)


def _cache_key(query: str, history: list[tuple[str, str]] | None) -> str:
    """Key de cache: hash de (query + fingerprint del history reciente)."""
    normalized = query.strip().lower()
    history_str = ""
    if history:
        # Fingerprint = últimos 2 turnos (suficiente para identificar contexto)
        for sender, content in history[-2:]:
            history_str += f"{sender}:{content[:200]}|"
    payload = f"{normalized}||{history_str}"
    return f"qrw:{hashlib.sha256(payload.encode()).hexdigest()}"


async def _get_cached(query: str, history: list[tuple[str, str]] | None) -> RewriteResult | None:
    try:
        redis = get_redis_cache()
        raw = await redis.get(_cache_key(query, history))
        if raw:
            data = json.loads(raw)
            return RewriteResult(
                main=data["main"],
                variants=data.get("variants", []),
                used_cache=True,
            )
    except Exception as exc:
        logger.debug("query_rewrite_cache_read_failed error=%s", exc)
    return None


async def _set_cached(query: str, history: list[tuple[str, str]] | None, result: RewriteResult) -> None:
    try:
        redis = get_redis_cache()
        payload = json.dumps({"main": result.main, "variants": result.variants})
        await redis.setex(_cache_key(query, history), settings.query_rewriting_cache_ttl, payload)
    except Exception as exc:
        logger.debug("query_rewrite_cache_write_failed error=%s", exc)


def _parse_llm_response(raw: str) -> dict | None:
    """Extrae JSON del response del LLM. Tolerante a markdown wrappers o texto extra."""
    # Intentar parseo directo
    try:
        return json.loads(raw.strip())
    except Exception:
        pass
    # Buscar el primer bloque {...} dentro del response
    match = re.search(r"\{[^{}]*?(\{[^{}]*\}[^{}]*?)*\}", raw, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except Exception:
            pass
    return None


async def rewrite_query(
    query: str,
    history: list[tuple[str, str]] | None = None,
    bot_description: str | None = None,
) -> RewriteResult:
    """Reescribe la query con contexto del historial + variantes para multi-query retrieval.

    Flow:
      1. Si feature flag off → devuelve query original
      2. Si query ya es muy específica (>N palabras) → devuelve query original
      3. Cache hit en Redis → devuelve cacheado
      4. LLM call con timeout → parsea JSON → cachea → devuelve
      5. Si LLM falla → fallback a query original (degraded mode)
    """
    query = (query or "").strip()
    if not query:
        return RewriteResult(main="", variants=[])

    if not settings.query_rewriting_enabled:
        return RewriteResult(main=query, variants=[])

    # Heurística condicional: solo activar rewriter cuando aporta valor.
    # Queries específicas (largas, sin pronombre interrogativo) ya tienen
    # suficiente contexto léxico para el RAG actual — no agregamos latencia.
    if not should_rewrite(query):
        logger.debug("query_rewrite_skipped (heuristic) query=%r words=%d",
                     query[:60], len(query.split()))
        return RewriteResult(main=query, variants=[], skipped=True)

    # Cache hit
    cached = await _get_cached(query, history)
    if cached is not None:
        logger.debug("query_rewrite_cache_hit query=%r", query[:60])
        return cached

    # LLM rewrite
    n_variants = settings.query_rewriting_num_variants
    org_context = (
        _ORG_CONTEXT_BLOCK.format(bot_description=bot_description[:400])
        if bot_description and bot_description.strip()
        else ""
    )
    system_prompt = _REWRITE_SYSTEM_PROMPT.format(n=n_variants, org_context=org_context)
    history_block = _build_history_block(history)
    user_msg = (
        f"Historial reciente:\n{history_block}\n\n"
        f"Consulta del usuario: {query}\n\n"
        f'Respondé SOLO con el JSON: {{"main": "...", "variants": ["...", "..."]}}'
    )

    timeout_s = settings.query_rewriting_timeout_ms / 1000
    try:
        raw = await asyncio.wait_for(
            complete(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_msg},
                ],
                complexity=QueryComplexity.SIMPLE,
                temperature=0.0,
                max_tokens=200,  # bajado de 300 — con 1 main + 1 variant alcanza
            ),
            timeout=timeout_s,
        )
    except asyncio.TimeoutError:
        logger.warning("query_rewrite_timeout query=%r timeout_s=%.1f", query[:60], timeout_s)
        return RewriteResult(main=query, variants=[], fallback=True)
    except Exception as exc:
        logger.warning("query_rewrite_llm_failed query=%r error=%s", query[:60], exc)
        return RewriteResult(main=query, variants=[], fallback=True)

    parsed = _parse_llm_response(raw)
    if not parsed or "main" not in parsed:
        logger.warning("query_rewrite_parse_failed query=%r raw=%r", query[:60], raw[:200])
        return RewriteResult(main=query, variants=[], fallback=True)

    result = RewriteResult(
        main=str(parsed.get("main") or query).strip(),
        variants=[str(v).strip() for v in (parsed.get("variants") or []) if str(v).strip()][:n_variants],
    )
    # Si por alguna razón el main vino vacío, fallback
    if not result.main:
        result.main = query

    # Cache the result fire-and-forget (no bloquea response)
    asyncio.create_task(_set_cached(query, history, result))

    logger.info(
        "query_rewrite_done query=%r main=%r variants=%d",
        query[:60], result.main[:80], len(result.variants),
    )
    return result
