"""Harness de evaluación RAG — el "mejor test" para el bot.

Mide lo que importa en un bot RAG, con LLM-as-judge (no hace falta labels humanos):
  - Faithfulness / groundedness: ¿la respuesta se apoya en el contexto recuperado
    o alucina?
  - Answer relevance: ¿responde la pregunta?
  - Refusal accuracy: cuando la info NO está, ¿declina en vez de inventar?
  - Intent accuracy: ¿el clasificador asigna la intención correcta?
  - Retrieval: cantidad de fuentes, latencia.

Golden set: consultas de TODO tipo (in-domain answerable, absent-in-docs,
out-of-domain, saludo, ambiguas cortas, multi-fact).

Uso: docker compose exec backend python rag_eval.py [tenant_id]
"""

import asyncio
import json
import sys
import warnings

warnings.filterwarnings("ignore")

TENANT = sys.argv[1] if len(sys.argv) > 1 else "mutualyf"

# category, query, expect (answer|refuse|greet), expected_intent (o None)
GOLDEN = [
    ("horario",    "¿Qué días atiende pediatría?",                         "answer", "horario"),
    ("horario",    "¿Cuándo atiende cardiología?",                          "answer", "horario"),
    ("horario",    "¿A qué hora termina el traumatólogo?",                  "answer", "horario"),
    ("turno",      "¿Cómo saco un turno?",                                  "answer", "turno"),
    ("turno",      "¿Cuál es la línea gratuita de turnos?",                 "answer", "turno"),
    ("turno",      "¿Puedo sacar turno por WhatsApp?",                      "answer", "turno"),
    ("afiliacion", "¿Cómo afilio a mi esposa?",                            "answer", "afiliacion"),
    ("afiliacion", "¿A qué teléfono llamo para afiliar a un familiar?",     "answer", "afiliacion"),
    ("receta",     "¿Cómo obtengo una receta digital?",                     "answer", "receta"),
    ("receta",     "¿La receta en papel sigue vigente?",                    "answer", "receta"),
    ("contacto",   "¿Cuál es el teléfono de la mutual?",                    "answer", "contacto"),
    ("contacto",   "¿Dónde queda el centro médico?",                        "answer", "contacto"),
    ("pagos",      "¿Puedo pagar la cuota con tarjeta?",                    "answer", None),
    ("estudios",   "¿Qué preparación necesita una ecografía abdominal?",   "answer", None),
    ("estudios",   "¿La ecografía mamaria requiere preparación?",           "answer", None),
    ("horarios_g", "¿Atienden los sábados?",                                "answer", None),
    ("multi",      "¿Cómo saco turno y dónde queda el centro médico?",      "answer", None),
    # Ausente en los docs → debe DECLINAR (no inventar)
    ("absent",     "¿Cuántas horas de ayuno necesito para un análisis de sangre?", "refuse", None),
    ("absent",     "¿Cuáles son los requisitos para afiliarme?",            "refuse", None),
    ("absent",     "¿Cuánto sale la cuota mensual?",                        "refuse", None),
    # Fuera de dominio → debe DECLINAR
    ("ood",        "¿Cuál es la capital de Francia?",                       "refuse", None),
    ("ood",        "¿Qué tiempo va a hacer mañana?",                        "refuse", None),
    # Saludo
    ("greet",      "hola",                                                  "greet", None),
    ("greet",      "buenas, necesito una ayuda",                            "greet", None),
    # Ambiguas / cortas
    ("short",      "turno",                                                 "answer", None),
    ("short",      "horario",                                               "answer", None),
]

JUDGE_PROMPT = """Sos un evaluador estricto de un bot de atención (RAG). Te doy la PREGUNTA del usuario,
el CONTEXTO recuperado (fragmentos de documentos) y la RESPUESTA del bot.

Evaluá y devolvé SOLO JSON:
{
 "faithfulness": 0.0-1.0,   // ¿la respuesta se apoya en el CONTEXTO? 1=todo sale del contexto, 0=inventado
 "relevance": 0.0-1.0,      // ¿responde lo que se preguntó?
 "is_refusal": true/false,  // ¿la respuesta declina/deriva por falta de info?
 "hallucination": true/false, // ¿afirma datos NO presentes en el contexto?
 "comment": "una oración"
}
Si el CONTEXTO está vacío y la respuesta declina, faithfulness=1 y is_refusal=true."""


async def judge(question: str, context: str, answer: str) -> dict:
    from services.groq_client import complete, QueryComplexity
    user = f"PREGUNTA:\n{question}\n\nCONTEXTO:\n{context[:3500]}\n\nRESPUESTA:\n{answer}\n\nJSON:"
    try:
        raw = await complete(
            messages=[{"role": "system", "content": JUDGE_PROMPT}, {"role": "user", "content": user}],
            complexity=QueryComplexity.SIMPLE, temperature=0.0, max_tokens=200,
        )
        s, e = raw.find("{"), raw.rfind("}")
        return json.loads(raw[s:e + 1])
    except Exception as exc:
        return {"faithfulness": 0, "relevance": 0, "is_refusal": False, "hallucination": False, "comment": f"judge_err:{exc}"}


_UNAVAILABLE = "no está disponible"


async def _query_with_retry(handle_query, q, tenant, tries=3):
    """Reintenta si el LLM devuelve el sentinel de 'no disponible' (rate-limit del
    proveedor) — así el eval no cuenta fallas de infra como rechazos del bot."""
    for i in range(tries):
        r = await handle_query(q, tenant)
        if _UNAVAILABLE not in (r.get("answer") or ""):
            return r
        await asyncio.sleep(3 * (i + 1))
    return r


def _ctx_of(sources) -> str:
    out = []
    for s in (sources or []):
        t = s.get("text") if isinstance(s, dict) else getattr(s, "text", "")
        if t:
            out.append(t)
    return "\n---\n".join(out)


async def main():
    from services.orchestrator import handle_query

    rows = []
    for cat, q, expect, exp_intent in GOLDEN:
        r = await _query_with_retry(handle_query, q, TENANT)
        ans = r.get("answer") or ""
        ctx = _ctx_of(r.get("sources"))
        await asyncio.sleep(1.0)          # pacing anti rate-limit
        j = await judge(q, ctx, ans)
        await asyncio.sleep(1.0)
        rows.append({
            "cat": cat, "q": q, "expect": expect, "exp_intent": exp_intent,
            "intent": r.get("intent_label"), "conf": r.get("intent_confidence") or 0,
            "src": len(r.get("sources") or []), "lat": r.get("latency_ms"),
            "faith": j.get("faithfulness", 0), "rel": j.get("relevance", 0),
            "refusal": j.get("is_refusal", False), "hallu": j.get("hallucination", False),
            "ans": ans[:90].replace("\n", " "),
        })

    # ── Scorecard ──────────────────────────────────────────────────────────
    n = len(rows)
    ans_rows = [r for r in rows if r["expect"] == "answer"]
    ref_rows = [r for r in rows if r["expect"] == "refuse"]

    faith = sum(r["faith"] for r in ans_rows) / max(1, len(ans_rows))
    rel = sum(r["rel"] for r in ans_rows) / max(1, len(ans_rows))
    hallu = sum(1 for r in rows if r["hallu"]) / n
    # refusal accuracy: en 'refuse' debe declinar; en 'answer' NO debe declinar
    ref_ok = sum(1 for r in ref_rows if r["refusal"]) / max(1, len(ref_rows))
    ans_no_ref = sum(1 for r in ans_rows if not r["refusal"]) / max(1, len(ans_rows))

    print("\n================ RAG SCORECARD (%s) ================" % TENANT)
    print(f"Consultas: {n}  |  answerable: {len(ans_rows)}  refuse: {len(ref_rows)}")
    print(f"Faithfulness (answerable) : {faith:.2f}   [1=fundamentado]")
    print(f"Answer relevance          : {rel:.2f}")
    print(f"Alucinación (todas)       : {hallu:.2f}   [menor mejor]")
    print(f"Refusal accuracy (absent/ood): {ref_ok:.2f}   [declina cuando no sabe]")
    print(f"Answerable NO declinadas  : {ans_no_ref:.2f}   [responde cuando sí sabe]")

    # Intent accuracy (solo donde definimos expected)
    lab = [r for r in rows if r["exp_intent"]]
    def _match(r):
        il = (r["intent"] or "").lower()
        return r["exp_intent"] in il or il in r["exp_intent"]
    if lab:
        acc = sum(1 for r in lab if _match(r)) / len(lab)
        fired = sum(1 for r in lab if r["conf"] >= 0.70)
        print(f"Intent accuracy (top-1)   : {acc:.2f}  sobre {len(lab)} etiquetadas")
        print(f"Intent >= umbral 0.70     : {fired}/{len(lab)}  (cuántas cruzan a fast-path)")

    print("\n--- detalle por categoría ---")
    print(f"{'cat':<11}{'exp':<7}{'intent':<22}{'conf':<6}{'faith':<6}{'rel':<5}{'ref':<4} q")
    for r in rows:
        flag = ""
        if r["expect"] == "refuse" and not r["refusal"]: flag = " ❌debía declinar"
        if r["expect"] == "answer" and r["refusal"]: flag = " ⚠declinó"
        if r["hallu"]: flag += " 🔴HALU"
        print(f"{r['cat']:<11}{r['expect']:<7}{str(r['intent'])[:20]:<22}{r['conf']:<6.2f}{('s'+str(r['src'])):<5}{r['faith']:<6.1f}{r['rel']:<5.1f}{str(r['refusal'])[:1]:<4} {r['q'][:38]}{flag}")

asyncio.run(main())
