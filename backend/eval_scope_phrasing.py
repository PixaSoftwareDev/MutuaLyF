"""Eval de alcance por fraseo (camino UNIFICADO) — regresión del bug 2026-07-28.

El bug: "quiero saber sobre películas populares" (declaración de intención)
rebotaba como fuera-de-alcance mientras "¿qué películas hay?" (pregunta
directa) ruteaba — la personalidad y el bloque de tools se contradecían y el
modelo arbitraba según el fraseo. El fix: módulo ALCANCE Y FUENTES único,
generado por turno con los dominios de las tools activas (prompt_builder).

A diferencia de eval_tool_routing.py (que mide select_tool aislado contra un
catálogo sintético curado), esto ejercita el camino REAL de producción:
handle_query con el catálogo vivo del tenant, prompt modular incluido.

  - positivos: variantes de fraseo por tool activa → NO debe caer al guion de
    rechazo. Elegir una tool cuenta como éxito pleno; pedir una aclaración
    ("¿qué película querés buscar?") también es válido — con tools
    parametrizadas es el comportamiento correcto, no un fallo de ruteo.
  - negativos: fuera de alcance → NO debe elegir tool.

Sin labels humanos ni ejemplos manuales: las variantes salen del display_name
del catálogo. Correr contra el modelo de prod antes de confiar (local rutea
con otro proveedor).

Uso:
  docker compose exec backend python eval_scope_phrasing.py [tenant] [max_tools] [umbral]
  # defaults: intellix, 8, 0.75
Exit 1 si el ruteo positivo queda bajo el umbral o algún negativo rutea.
"""

import asyncio
import sys
import warnings

warnings.filterwarnings("ignore")

TENANT = sys.argv[1] if len(sys.argv) > 1 else "intellix"
MAX_TOOLS = int(sys.argv[2]) if len(sys.argv) > 2 else 8
THRESHOLD = float(sys.argv[3]) if len(sys.argv) > 3 else 0.75

# Formas de pedir lo mismo. La declaración de intención es LA que falló;
# las otras cubren pedido indirecto y pregunta directa.
VARIANTES = [
    "quiero saber sobre {n}",
    "me interesa ver {n}",
    "¿qué hay de {n}?",
]

# Fuera de alcance para cualquier tenant: ni tool ni respuesta de entrenamiento.
NEGATIVOS = [
    "¿cómo hago milanesas a la napolitana?",
    "¿qué equipo ganó el último mundial?",
    "contame un chiste de programadores",
]

# Guiones de rechazo (actual + legacy). Que un fraseo positivo caiga acá es EL
# bug que esta eval protege. Mantener alineado con prompt_builder.REFUSAL_PHRASE.
_REFUSAL_MARKERS = [
    "fuera de mi área de conocimiento",
    "Eso se escapa de lo que puedo ayudarte",
    "fuera del alcance de este asistente",
]


def _es_rechazo(answer: str) -> bool:
    return any(m in answer for m in _REFUSAL_MARKERS)


async def main() -> int:
    from services.connector_router import _build_tool_schemas
    from services.connectors_dao import list_tools_for_tool_calling
    from services.orchestrator import handle_query
    from services.prompt_builder import tool_domain_summary

    catalog = await list_tools_for_tool_calling(TENANT)
    if not catalog:
        print(f"[eval] tenant {TENANT} sin tools activas — nada que evaluar")
        return 0

    schemas = _build_tool_schemas(catalog)
    domains = tool_domain_summary(catalog)
    # Muestra determinística (por slug): costo acotado y corridas comparables.
    sample = sorted(catalog, key=lambda t: t["slug"])[:MAX_TOOLS]

    print(f"[eval] tenant={TENANT} tools_activas={len(catalog)} muestreadas={len(sample)} "
          f"variantes={len(VARIANTES)} negativos={len(NEGATIVOS)}\n")

    ok = 0
    total = 0
    tool_picks = 0
    fallos: list[str] = []
    for t in sample:
        nombre = str(t.get("display_name") or t["slug"]).lower()
        for tpl in VARIANTES:
            q = tpl.format(n=nombre)
            total += 1
            try:
                r = await handle_query(q, TENANT, tool_schemas=schemas, tool_domains=domains)
            except Exception as exc:  # noqa: BLE001
                fallos.append(f"  ✗ [{t['slug']}] {q!r} → ERROR {exc}")
                continue
            picked = (r.get("tool_call") or {}).get("name")
            ans = (r.get("answer") or "").replace("\n", " ")
            if picked:
                ok += 1
                tool_picks += 1
                print(f"  ✓ [{t['slug']}] {q!r} → tool {picked}")
            elif not _es_rechazo(ans):
                # Sin tool pero sin guion de rechazo = aclaración o respuesta
                # en tema (válido con tools parametrizadas).
                ok += 1
                print(f"  ✓ [{t['slug']}] {q!r} → en tema (aclaración): {ans[:60]!r}")
            else:
                fallos.append(f"  ✗ [{t['slug']}] {q!r} → RECHAZO: {ans[:80]!r}")

    neg_fallos: list[str] = []
    for q in NEGATIVOS:
        try:
            r = await handle_query(q, TENANT, tool_schemas=schemas, tool_domains=domains)
        except Exception as exc:  # noqa: BLE001
            neg_fallos.append(f"  ✗ {q!r} → ERROR {exc}")
            continue
        picked = (r.get("tool_call") or {}).get("name")
        if picked:
            neg_fallos.append(f"  ✗ {q!r} → eligió {picked} (debía rechazar)")
        else:
            print(f"  ✓ [negativo] {q!r} → sin tool")

    rate = ok / total if total else 0.0
    print(f"\n[eval] en-tema: {ok}/{total} = {rate:.0%} (umbral {THRESHOLD:.0%}) · "
          f"tool directa: {tool_picks}/{total}")
    if fallos:
        print("[eval] fraseos RECHAZADOS (el bug protegido):")
        print("\n".join(fallos))
    if neg_fallos:
        print("[eval] NEGATIVOS que rutearon (grave):")
        print("\n".join(neg_fallos))

    if rate < THRESHOLD or neg_fallos:
        print("[eval] RESULTADO: FALLO")
        return 1
    print("[eval] RESULTADO: OK")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
