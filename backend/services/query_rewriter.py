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


# Arranques de continuación conversacional — señal de que la consulta depende
# del turno anterior ("y los horarios?", "pero cómo lo pido", "bien, y después?").
# Propiedad del ESPAÑOL, no del dominio: el gate NUNCA debe contener vocabulario
# de negocio (regla multi-tenant — lo específico del cliente vive en su corpus).
_CONTINUATION_STARTS = {
    "y", "e", "pero", "entonces", "bien", "bueno", "ok", "dale", "ademas",
    "además", "tambien", "también", "igual", "aparte", "ahora", "despues",
    "después", "no", "si", "sí", "ah", "ah,", "listo", "perfecto",
}

# Anáforas/deixis — referencias a algo dicho antes que la búsqueda sola no
# resuelve ("eso cuánto cuesta", "ahí mismo atienden?", "y el anterior?").
# Solo formas de alta precisión: los clíticos ultra comunes ("lo", "le") NO van
# porque aparecen en consultas autosuficientes ("lo que necesito para afiliarme").
_DEIXIS_WORDS = {
    "eso", "esa", "ese", "esto", "aquel", "aquella", "aquello",
    "ahí", "ahi", "allí", "alli", "allá", "alla",
    "mismo", "misma", "anterior", "anteriores", "dicho", "dicha",
    "él", "ella", "ellos", "ellas", "ésta", "éste", "ése", "ésa",
}


def _gate_reason(query: str, has_history: bool = False) -> str | None:
    """Motivo por el que la consulta merece rewriting, o None para saltearlo.

    Heurística (orden de evaluación):
      1. Query vacía → skip
      2. Query muy larga (>max_query_words) → skip (ya es específica)
      3. Query corta (≤short_threshold palabras) → "corta" (vocabulary mismatch
         típico; calibrado 2026-05)
      4. Empieza con pronombre interrogativo → "interrogativa"
      5. Con historial y arranca con conector de continuación → "continuacion"
      6. Con historial y contiene anáfora/deixis → "anafora"
      7. Otro caso → skip

    Hasta el 2026-08-20 la regla con historial era "reescribir SIEMPRE": dentro
    de una conversación, TODA consulta pagaba el LLM del rewriter + la búsqueda
    de su variante (~2 s en serie) aunque fuera autosuficiente ("Quisiera
    conocer qué debo presentar para el plan materno"). Medido en prod ese día:
    3,7-4,6 s por consulta contra 2-3 s sin rewriter. Las reglas 5-6 conservan
    la ganancia real del multi-turno (repreguntas elípticas, A/B 17/08:
    85→90%) sin cobrarle el peaje a las consultas que no la necesitan.
    """
    if not query or not query.strip():
        return None
    words = query.strip().split()
    if len(words) > settings.query_rewriting_max_query_words:
        return None
    if len(words) <= settings.query_rewriting_short_threshold:
        return "corta"
    # Primera palabra REAL: tokenizar con puntuación incluida — los afiliados
    # escriben "Bien,una vez que nazca..." (sin espacio tras la coma).
    tokens = [t.lower() for t in re.split(r"[\s,;:.!?¿¡\"'()\[\]]+", query.strip()) if t]
    if not tokens:
        return None
    if tokens[0] in _INTERROGATIVE_STARTS:
        return "interrogativa"
    if has_history:
        if tokens[0] in _CONTINUATION_STARTS:
            return "continuacion"
        if set(tokens) & _DEIXIS_WORDS:
            return "anafora"
    return None


def should_rewrite(query: str, has_history: bool = False) -> bool:
    """Decide si vale la pena correr el rewriter para esta query."""
    return _gate_reason(query, has_history) is not None


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
- Las palabras que no reconozcas (apellidos, nombres propios, siglas, marcas)
  copialas EXACTAMENTE como están — NUNCA las "corrijas" a una palabra parecida
  ni las reemplaces por un término genérico. Ante la duda, la palabra queda igual.
- Si la consulta ya es específica y autosuficiente (>20 palabras), la main = query original.
- Para las variantes: usá sinónimos naturales del ámbito de la consulta; si abajo
  hay contexto de la organización, aprovechalo para elegirlos.{org_context}

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
    # Con historial se reescribe siempre: la consulta puede depender del contexto.
    reason = _gate_reason(query, has_history=bool(history))
    if reason is None:
        # info (no debug): en prod auditamos qué porcentaje se saltea y si
        # alguna decisión del gate fue mala (comparando con la conversación).
        logger.info("query_rewrite_gate decision=skip words=%d query=%r",
                    len(query.split()), query[:60])
        return RewriteResult(main=query, variants=[], skipped=True)
    logger.info("query_rewrite_gate decision=rewrite reason=%s query=%r",
                reason, query[:60])

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
    # Override-aware (prompt_registry "query_rewriter"). El template usa
    # placeholders {n}/{org_context}: si un override editado a mano los rompe,
    # el format falla y caemos al default del código — nunca al error.
    from services.prompt_registry import get_text
    _tpl = await get_text("query_rewriter")
    try:
        system_prompt = _tpl.format(n=n_variants, org_context=org_context)
    except (KeyError, IndexError, ValueError):
        logger.warning("query_rewriter_override_bad_placeholders — usando default del código")
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
