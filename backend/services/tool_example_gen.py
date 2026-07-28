"""Ejemplos de consulta AUTOGENERADOS para las tools de conectores.

El campo `examples` de cada tool es la palanca principal del ruteo contra
sinónimos y fraseos indirectos (ver _tool_description): frases concretas
contra las que el LLM matchea la consulta mejor que contra una descripción
abstracta. El problema: nadie las cargaba — pedírselas al admin es carga
humana propensa a error (decisión explícita: el admin nunca redacta), y el
flywheel de consultas reales tiene cold-start ("quiero ver algo bueno esta
noche" rebotaba porque ninguna tool tenía ejemplos, 2026-07-28).

Este módulo cierra el cold-start: al APLICAR operaciones del discovery se
generan ejemplos por LLM — incluyendo deliberadamente fraseos coloquiales,
declaraciones de intención e indirectas SIN el vocabulario de la operación.
El admin puede podarlos en el panel; el flywheel (tool_example_candidates)
los refina después con uso real. Best-effort SIEMPRE: si el LLM falla, las
tools quedan sin ejemplos como hasta hoy — nunca rompe el apply.

Plan: docs/PLAN_AMBIGUEDAD_RECONOCIMIENTO §2 (pieza 1).
"""

from __future__ import annotations

import json
import logging
import re

logger = logging.getLogger(__name__)

_MAX_TOOLS_PER_CALL = 12   # lote razonable: catálogo grande → varias llamadas
_EXAMPLES_PER_TOOL = 6

_SYSTEM = """Sos el curador del catálogo de operaciones de un asistente conversacional de una organización (cualquier rubro).
Te paso operaciones (slug, nombre, descripción) y contexto de la organización.
Para CADA operación generá {n} consultas de ejemplo que un usuario real escribiría en el chat y que se responden con ESA operación:
- 2 directas (piden el dato por su nombre)
- 2 coloquiales rioplatenses (informales, con jerga natural)
- 1 declaración de intención («quiero…», «me interesa…», «necesito…»)
- 1 INDIRECTA: el pedido de fondo dicho por alguien que NO conoce el sistema, SIN usar las palabras del nombre de la operación (ej. para una operación de películas populares: «quiero ver algo bueno esta noche»)

Reglas:
- Cortas (3 a 12 palabras), sin comillas, sin numerar.
- Cada ejemplo debe distinguir esta operación de las otras del lote — nada genérico que aplique a cualquiera.
- No inventes operaciones ni ejemplos que esta operación no pueda responder.

Devolvé ÚNICAMENTE un JSON válido: {{"slug": ["ejemplo", ...], ...}} con TODOS los slugs que te pasé."""


def _parse_json_obj(raw: str) -> dict:
    text = (raw or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError(f"sin objeto JSON: {raw[:120]!r}")
    return json.loads(text[start:end + 1])


async def generate_examples(tenant_id: str, tools: list[dict]) -> dict[str, list[str]]:
    """slug → ejemplos generados. Solo para las tools recibidas; {} ante fallo."""
    from services.connector_discovery import _tenant_context
    from services.groq_client import complete

    out: dict[str, list[str]] = {}
    ctx = await _tenant_context(tenant_id)
    for i in range(0, len(tools), _MAX_TOOLS_PER_CALL):
        lote = tools[i:i + _MAX_TOOLS_PER_CALL]
        payload = json.dumps(
            [{"slug": t["slug"], "nombre": t.get("display_name") or t["slug"],
              "descripcion": (t.get("description") or "")[:400]} for t in lote],
            ensure_ascii=False,
        )
        try:
            raw = await complete(
                [{"role": "system", "content": _SYSTEM.format(n=_EXAMPLES_PER_TOOL) + ctx},
                 {"role": "user", "content": f"Operaciones:\n{payload}"}],
                temperature=0.4, max_tokens=1500, tenant_id=tenant_id,
            )
            data = _parse_json_obj(raw)
        except Exception as exc:  # noqa: BLE001 — best-effort siempre
            logger.warning("example_gen_failed tenant=%s lote=%d error=%s", tenant_id, i, exc)
            continue
        wanted = {t["slug"] for t in lote}
        for slug, exs in data.items():
            if slug in wanted and isinstance(exs, list):
                clean = [str(e).strip() for e in exs if str(e).strip()][:10]
                if clean:
                    out[slug] = clean
    return out


async def autofill_missing_examples(tenant_id: str, connector_id: str) -> dict[str, int]:
    """Genera y guarda ejemplos para las tools del conector que NO tienen.

    No pisa ejemplos existentes (curados por el admin o por el flywheel).
    Devuelve {slug: cantidad} de lo guardado. Best-effort por tool.
    """
    from services import connectors_dao as dao

    tools = await dao.list_tools(tenant_id, connector_id)
    faltantes = [t for t in tools if t.get("is_active") and not (t.get("examples") or [])]
    if not faltantes:
        return {}
    generated = await generate_examples(tenant_id, faltantes)
    saved: dict[str, int] = {}
    by_slug = {t["slug"]: t for t in faltantes}
    for slug, exs in generated.items():
        try:
            await dao.update_tool(tenant_id, by_slug[slug]["id"], {"examples": exs})
            saved[slug] = len(exs)
        except Exception as exc:  # noqa: BLE001
            logger.warning("example_save_failed tenant=%s slug=%s error=%s", tenant_id, slug, exc)
    if saved:
        dao.invalidate_tool_catalog(tenant_id)
        logger.info("examples_autofilled tenant=%s connector=%s tools=%d", tenant_id, connector_id, len(saved))
    return saved
