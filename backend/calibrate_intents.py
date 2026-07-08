"""B. Calibración empírica de umbrales del clasificador de intenciones.

Los umbrales por defecto (0.95 high / 0.70 mid) se fijaron a ojo. Con
multilingual-e5-large/OpenAI, el coseno de paráfrasis del mismo tema vive en
~0.4-0.8, así que 0.70+ casi nunca dispara. Este script mide la distribución
REAL sobre las consultas ya clasificadas (ground truth) y recomienda umbrales
que maximizan cobertura sin perder precisión.

  mid  = umbral para responder por intención (fast-path). Objetivo: precisión >= 0.90.
  high = umbral para auto-aprender. Objetivo: precisión >= 0.97 (casi seguro).

Uso: docker compose exec backend python calibrate_intents.py [tenant_id]
"""

import asyncio
import sys
import warnings

warnings.filterwarnings("ignore")

TENANT = sys.argv[1] if len(sys.argv) > 1 else "mutualyf"


async def main():
    from core.database import get_worker_pg_session
    from services.classifier import classify_intent
    from sqlalchemy import text

    async with get_worker_pg_session(TENANT) as s:
        rows = (await s.execute(text("""
            SELECT question_text, intent_label FROM consultas_log
            WHERE cluster_status='classified' AND intent_label IS NOT NULL
              AND question_text IS NOT NULL
            ORDER BY RANDOM() LIMIT 150
        """))).fetchall()

    if len(rows) < 20:
        print(f"Muy pocas consultas clasificadas ({len(rows)}) para calibrar.")
        return

    # Predecir sobre cada una: (confianza, acierto)
    preds = []
    for qtext, true_label in rows:
        r = await classify_intent(qtext, TENANT)
        preds.append((r.confidence, (r.label or "") == true_label))

    preds.sort(reverse=True)  # mayor confianza primero
    n = len(preds)
    print(f"\n=== Calibración umbrales ({TENANT}) — {n} consultas etiquetadas ===")
    print(f"{'umbral':>7} {'cobertura':>10} {'precisión':>10}  (de las que disparan, % correctas)")

    best_mid = None
    best_high = None
    for tau in [x / 100 for x in range(30, 96, 5)]:
        fired = [(c, ok) for c, ok in preds if c >= tau]
        if not fired:
            continue
        coverage = len(fired) / n
        precision = sum(1 for _, ok in fired if ok) / len(fired)
        mark = ""
        if precision >= 0.90 and best_mid is None and coverage >= 0.30:
            best_mid = tau; mark += " ← MID (precisión>=0.90)"
        if precision >= 0.97 and best_high is None:
            best_high = tau; mark += " ← HIGH (precisión>=0.97)"
        print(f"{tau:>7.2f} {coverage:>9.0%} {precision:>10.0%}{mark}")

    # Fallback si no se alcanzan los targets: tomar el mejor disponible.
    print("\n--- Recomendación ---")
    if best_mid:
        print(f"INTENT_CONFIDENCE_MID={best_mid:.2f}")
    else:
        print("INTENT_CONFIDENCE_MID=0.50  (no se alcanzó precisión 0.90 — revisar calidad de intenciones)")
    if best_high:
        print(f"INTENT_CONFIDENCE_HIGH={best_high:.2f}")
    else:
        print("INTENT_CONFIDENCE_HIGH=0.80  (no se alcanzó precisión 0.97 — auto-learn conservador)")


asyncio.run(main())
