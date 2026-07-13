"""Siembra ejemplos de intención (Qdrant) para las 4 intenciones del conector NEXA.

Sin esto el clasificador no matchea las intenciones del conector (solo tenía
ejemplos de 'quienes_son') y el chat nunca dispara la tool. Reutiliza el mismo
camino de embedding/upsert que el reentrenador (services.classifier_trainer).

También escribe los ejemplos curados en intencion_ejemplos (PG) para que el panel
y el reentrenador queden consistentes.

Uso: docker exec local_backend python /app/../scripts/seed_intent_examples_nexa.py <tenant_id>
"""

from __future__ import annotations

import asyncio
import sys
import uuid

from sqlalchemy import text

from core.database import get_pg_session
from services.classifier_trainer import _embed_and_upsert
from services.intent_examples import insert_examples

EXAMPLES: dict[str, list[str]] = {
    "consulta_ordenes_pendientes": [
        "¿qué órdenes pendientes tengo?",
        "quiero ver mis órdenes pendientes",
        "tengo autorizaciones sin usar?",
        "mis órdenes pendientes",
        "qué autorizaciones me quedan pendientes",
        "consultar mis órdenes",
    ],
    "consulta_cuenta_corriente": [
        "¿cuánto debo?",
        "quiero ver mi cuenta corriente",
        "tengo deuda con la mutual?",
        "cuál es mi saldo",
        "estado de mi cuenta corriente",
        "cuánto tengo que pagar",
    ],
    "buscar_profesional_especialidad": [
        "qué cardiólogos hay",
        "necesito un pediatra",
        "médicos de dermatología",
        "busco un traumatólogo",
        "profesionales de cardiología",
        "qué especialistas en pediatría atienden",
    ],
    "consultar_horarios_profesional": [
        "qué horarios tiene la matrícula MP-1001",
        "horarios de atención del profesional MP-1003",
        "cuándo atiende el doctor con matrícula MP-1002",
        "horario del médico MP-1004",
        "en qué días atiende el profesional",
    ],
}


async def seed(tenant_id: str) -> dict:
    version_id = "seed-nexa"
    total = 0
    per_intent = {}
    async with get_pg_session(tenant_id) as session:
        for label, texts in EXAMPLES.items():
            intencion_id = (await session.execute(
                text("SELECT id::text FROM intenciones WHERE label = :l"), {"l": label}
            )).scalar()
            if not intencion_id:
                print(f"  ⚠ intención '{label}' no existe en {tenant_id}, salto")
                continue
            # PG: ejemplos curados (idempotente por hash)
            await insert_examples(session, intencion_id, texts)
            # Qdrant: vectores para el clasificador
            examples = [
                {"question_text": t, "label": label,
                 "intencion_id": intencion_id, "example_id": str(uuid.uuid4())}
                for t in texts
            ]
            n = await _embed_and_upsert(tenant_id, examples, version_id)
            per_intent[label] = n
            total += n
        await session.commit()
    return {"tenant_id": tenant_id, "total_upserted": total, "per_intent": per_intent}


if __name__ == "__main__":
    tid = sys.argv[1] if len(sys.argv) > 1 else "intellix"
    print("seed intent examples NEXA:", asyncio.run(seed(tid)))
