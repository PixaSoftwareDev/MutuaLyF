"""Harness de evaluación del ruteo a tools por LLM (connector_routing_mode=tool_calling).

Mide la CALIDAD DE LA DECISIÓN de select_tool contra un golden set de consultas
reales (capturadas de consultas_log de intellix en prod, 2026-07-21) más sintéticas
de cobertura. Evalúa el MISMO prompt y el MISMO builder de schemas que usa el
router (connector_router.TOOL_ROUTER_SYSTEM / _build_tool_schemas) — sin drift.

Métricas:
  - accuracy estricta (elige exactamente lo esperado)
  - dangerous_fp : esperaba None y disparó una tool NO aceptable (el error grave:
                   ejecutar una API sobre una consulta sin relación)
  - missed_pos   : esperaba tool y no disparó ninguna (cae a RAG → responde mal)
  - wrong_tool   : disparó una tool distinta a la esperada (y no aceptable)
  - soft_ok      : resultado dentro de `acceptable` (ambigüedad legítima, no error)
  - latencia     : avg / p50 / p95 / max de la llamada select_tool

Uso: docker compose -f docker-compose.local.yml exec backend python eval_tool_routing.py
     (o: docker exec local_backend python eval_tool_routing.py)
"""

import asyncio
import statistics
import sys
import time
import warnings

warnings.filterwarnings("ignore")

# ── Catálogo tipo-prod (los 6 tools CRM de intellix en prod). Las descripciones
# son la superficie de curación del ruteo: si el eval falla, se ajustan ACÁ y,
# cuando estén validadas, se llevan al display_name/description de connector_tools.
CATALOG = [
    {"slug": "clientes", "display_name":
        "Clientes y contactos EXTERNOS cargados en el CRM (empresas o personas a las "
        "que les vendemos). Buscar/listar datos de contacto de un cliente.",
     "params_schema": {}, "identity_kind": "afiliado", "is_read_only": True},
    {"slug": "cuentas_por_cobrar", "display_name":
        "Cuentas por cobrar del CRM: facturas y cobros pendientes que los clientes "
        "nos deben.",
     "params_schema": {}, "identity_kind": "afiliado", "is_read_only": True},
    {"slug": "oportunidades", "display_name":
        "Oportunidades comerciales abiertas en el CRM (pipeline de ventas en curso).",
     "params_schema": {}, "identity_kind": "afiliado", "is_read_only": True},
    {"slug": "proyectos_crm", "display_name":
        "Proyectos de la empresa registrados en el CRM, con su estado y avance.",
     "params_schema": {}, "identity_kind": "afiliado", "is_read_only": True},
    {"slug": "resumen_financiero", "display_name":
        "Resumen financiero interno de NUESTRA empresa en el CRM (ingresos, egresos, "
        "saldos). NO es información económica general ni de terceros.",
     "params_schema": {}, "identity_kind": "afiliado", "is_read_only": True},
    {"slug": "tareas_crm", "display_name":
        "Tareas pendientes del equipo registradas en el CRM.",
     "params_schema": {}, "identity_kind": "afiliado", "is_read_only": True},
]

# ── Golden set. (query, expected, acceptable, nota)
#    expected: slug o None (None = ninguna tool → RAG)
#    acceptable: resultados alternativos que NO cuentan como error grave
#    ★ = consulta real de prod (consultas_log intellix)
CASES = [
    # ── Positivos reales (el coseno los perdía casi todos) ─────────────────────
    ("¿qué oportunidades abiertas tenemos?",          "oportunidades", set(), "★ única que el coseno ruteó en la historia"),
    ("que oportunidades tenemos abiertas?",           "oportunidades", set(), "★ coseno → producto_intellix 0.440 (mislabel)"),
    ("que oportunidades tenemos abiuertas?",          "oportunidades", set(), "★ typo real"),
    ("contame sobre nuestros proyectos",              "proyectos_crm", set(), "★ coseno 0.696 — murió por 4 milésimas"),
    ("quiero saber sobre nuestros proyectos",         "proyectos_crm", set(), "★"),
    ("quiero saber sobre mis proyectos",              "proyectos_crm", set(), "★"),
    ("tengo alguna tarea?",                           "tareas_crm",    set(), "★ coseno 0.646 < 0.70"),
    # ── Positivos sintéticos (tools sin tráfico real todavía) ──────────────────
    ("pasame el resumen financiero del mes",          "resumen_financiero", set(), "sintética"),
    ("cómo venimos de plata?",                        "resumen_financiero", set(), "sintética coloquial"),
    ("cuánto nos deben los clientes?",                "cuentas_por_cobrar", {"resumen_financiero"}, "sintética"),
    ("qué facturas están pendientes de cobro?",       "cuentas_por_cobrar", set(), "sintética"),
    ("hay algo para cobrar esta semana?",             "cuentas_por_cobrar", {"resumen_financiero"}, "sintética coloquial"),
    ("pasame el contacto del cliente Acme",           "clientes",      set(), "sintética"),
    ("qué clientes tenemos cargados?",                "clientes",      set(), "sintética"),
    ("qué tareas tengo pendientes?",                  "tareas_crm",    set(), "sintética"),
    ("mostrame el pipeline de ventas",                "oportunidades", set(), "sintética — sinónimo"),
    # ── Negativos reales: RAG debe responder (docs de la empresa) ──────────────
    ("Decime los dias y el horario en que puedo contactarlos", None, set(), "★"),
    ("que horarios de atencion tienen",               None, set(), "★"),
    ("horarios de atencion",                          None, set(), "★"),
    ("contame sus horarios de atencion",              None, set(), "★"),
    ("atienden los sabados?",                         None, set(), "★"),
    ("que sla y tiempo de respuesta tiene intellix?", None, set(), "★"),
    ("que es Handicapp? tiene prueba gratis?",        None, set(), "★"),
    ("que servicios ofrecen?",                        None, set(), "★"),
    ("servicios",                                     None, set(), "★ una sola palabra"),
    ("cuanto me costaria desarrollar una app con ustedes?", None, set(), "★"),
    ("sabes los precios?",                            None, set(), "★"),
    ("que hacen",                                     None, set(), "★"),
    ("quien sos",                                     None, set(), "★"),
    ("en que me podes ayudar",                        None, set(), "★"),
    ("como es la pagiuna de pixs",                    None, set(), "★ typo real"),
    ("como los contacto por whatsapp?",               None, set(), "★ contacto DE la empresa, no del CRM"),
    ("y el linkedin",                                 None, set(), "★ follow-up corto"),
    ("si obivio",                                     None, set(), "★ follow-up sin contenido"),
    # ── Negativos reales: personas (equipo/fundadores — docs, no CRM) ──────────
    ("quien es pixs",                                 None, set(), "★ coseno → horario_atencion 0.673"),
    ("quienes son pixs?",                             None, set(), "★"),
    ("quienes son los fundadores de Pixs?",           None, set(), "★"),
    ("quien son los socios",                          None, set(), "★ TRAMPA: socios=fundadores, no clientes CRM"),
    ("quien es enzo",                                 None, {"clientes"}, "★ nombre suelto: lookup CRM defendible"),
    ("quien es guillermo?",                           None, {"clientes"}, "★ ídem"),
    ("quien es Guillermo Fernandez y que experiencia tiene?", None, {"clientes"}, "★ perfil/equipo — lookup CRM defendible sin contexto docs"),
    ("guillermo conoce next",                         None, set(), "★"),
    ("quien sabe next",                               None, set(), "★"),
    # ── Negativos reales: fuera de dominio total ────────────────────────────────
    ("como salio argntina ayer?",                     None, set(), "★ FÚTBOL — coseno → crm_finanzas 0.349"),
    ("que opinas de la situacion economica de argentina?", None, set(), "★ trampa para resumen_financiero"),
    # ── Ambigüedad de proyecto (práctica vs listado CRM) ────────────────────────
    ("y cuanto tardan en entregar un proyecto?",      None, {"proyectos_crm"}, "★ pregunta de práctica, no de listado"),
]


async def _eval_case(sem, query, expected, acceptable, note):
    from services.connector_router import TOOL_ROUTER_SYSTEM, _build_tool_schemas
    from services.groq_client import select_tool

    tools = _build_tool_schemas(CATALOG)
    messages = [
        {"role": "system", "content": TOOL_ROUTER_SYSTEM},
        {"role": "user", "content": query},
    ]
    async with sem:
        t0 = time.perf_counter()
        try:
            picked = await select_tool(messages, tools)
        except Exception as exc:
            return {"query": query, "expected": expected, "got": f"ERROR:{exc}",
                    "verdict": "error", "ms": (time.perf_counter() - t0) * 1000, "note": note}
        ms = (time.perf_counter() - t0) * 1000

    got = picked["name"] if picked else None
    if got == expected:
        verdict = "ok"
    elif got in acceptable or (got is None and expected in acceptable):
        verdict = "soft_ok"
    elif expected is None and got is not None:
        verdict = "dangerous_fp"
    elif expected is not None and got is None:
        verdict = "missed_pos"
    else:
        verdict = "wrong_tool"
    return {"query": query, "expected": expected, "got": got,
            "verdict": verdict, "ms": ms, "note": note,
            "args": (picked or {}).get("arguments")}


async def main():
    sem = asyncio.Semaphore(8)
    results = await asyncio.gather(*[
        _eval_case(sem, q, exp, acc, note) for q, exp, acc, note in CASES
    ])

    counts: dict[str, int] = {}
    for r in results:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1

    n = len(results)
    ok = counts.get("ok", 0)
    soft = counts.get("soft_ok", 0)
    lat = sorted(r["ms"] for r in results if r["verdict"] != "error")

    print(f"\n{'='*90}")
    print("EVAL RUTEO TOOL-CALLING  (catálogo tipo-prod: 6 tools CRM)")
    print(f"{'='*90}")
    print(f"casos: {n}   estricto OK: {ok} ({ok/n:.0%})   con soft_ok: {ok+soft} ({(ok+soft)/n:.0%})")
    print(f"dangerous_fp: {counts.get('dangerous_fp',0)}   missed_pos: {counts.get('missed_pos',0)}   "
          f"wrong_tool: {counts.get('wrong_tool',0)}   errores: {counts.get('error',0)}")
    if lat:
        print(f"latencia select_tool ms — avg {statistics.mean(lat):.0f} · p50 {lat[len(lat)//2]:.0f} · "
              f"p95 {lat[int(len(lat)*0.95)-1]:.0f} · max {lat[-1]:.0f}")

    fails = [r for r in results if r["verdict"] not in ("ok", "soft_ok")]
    softs = [r for r in results if r["verdict"] == "soft_ok"]
    if fails:
        print(f"\n─ FALLAS ({len(fails)}) " + "─" * 70)
        for r in fails:
            print(f"  [{r['verdict']:^13}] {r['query']!r}")
            print(f"                 esperado={r['expected']}  obtuvo={r['got']}  ({r['note']})")
    if softs:
        print(f"\n─ SOFT OK ({len(softs)}) — ambigüedad legítima " + "─" * 40)
        for r in softs:
            print(f"  {r['query']!r}: esperado={r['expected']} obtuvo={r['got']}")
    print()
    return 1 if any(r["verdict"] in ("dangerous_fp", "error") for r in results) else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
