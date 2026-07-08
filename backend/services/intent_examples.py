"""Helpers compartidos para poblar intencion_ejemplos de forma consistente.

Antes, `approve_cluster` y `_promote_pending_to_active` creaban la intención e
indexaban en Qdrant pero NUNCA escribían en intencion_ejemplos. Resultado: el
reentrenador (que lee de esa tabla) no encontraba nada, el panel listaba los
ejemplos vacíos y el versioning/rollback quedaba desconectado. Esta función
centraliza el insert correcto para que todos los caminos de creación de
intención alimenten el aprendizaje.
"""

import hashlib
import logging
import uuid

from sqlalchemy import text

from core.text_utils import repair_mojibake

logger = logging.getLogger(__name__)

# Namespace estable para derivar ids de puntos Qdrant deterministas.
_QDRANT_NS = uuid.UUID("6f1c8f9e-4a2b-4c1d-9e3a-8b7c6d5e4f30")


def qdrant_point_id(intencion_id: str, text: str) -> str:
    """Id determinista de punto Qdrant para (intención, texto de ejemplo).

    Re-indexar el mismo ejemplo (ej: cada reentrenamiento) hace UPSERT sobre el
    mismo id en vez de crear un duplicado — evita que la colección de intenciones
    se infle con copias del mismo vector run tras run.
    """
    qh = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return str(uuid.uuid5(_QDRANT_NS, f"{intencion_id}:{qh}"))


async def insert_examples(session, intencion_id: str, texts: list[str]) -> int:
    """Inserta ejemplos manuales/aprobados en intencion_ejemplos (dedup por hash).

    - Repara mojibake antes de guardar.
    - Salta hashes ya presentes para esa intención (no hay UNIQUE en la tabla).
    - Marca is_auto_learned=FALSE, is_approved=TRUE (curados, listos para entrenar).
    - Recalcula intenciones.example_count = # de ejemplos NO auto-aprendidos.

    Devuelve la cantidad de ejemplos nuevos insertados.
    """
    # Hashes ya existentes para esta intención → evitar duplicados.
    existing_rows = await session.execute(
        text("SELECT question_hash FROM intencion_ejemplos WHERE intencion_id = :iid"),
        {"iid": intencion_id},
    )
    existing: set[str] = {r[0] for r in existing_rows.fetchall()}

    inserted = 0
    seen: set[str] = set()
    for raw in texts:
        qt = repair_mojibake(raw) or raw
        if not qt or not qt.strip():
            continue
        qh = hashlib.sha256(qt.encode("utf-8")).hexdigest()
        if qh in existing or qh in seen:
            continue
        seen.add(qh)
        await session.execute(
            text(
                "INSERT INTO intencion_ejemplos "
                "(id, intencion_id, question_hash, question_text, is_auto_learned, is_approved) "
                "VALUES (:id, :iid, :qh, :qt, FALSE, TRUE)"
            ),
            {"id": str(uuid.uuid4()), "iid": intencion_id, "qh": qh, "qt": qt[:500]},
        )
        inserted += 1

    # Mantener example_count sincronizado con la realidad (ejemplos curados).
    await session.execute(
        text(
            "UPDATE intenciones SET example_count = "
            "(SELECT COUNT(*) FROM intencion_ejemplos "
            " WHERE intencion_id = :iid AND is_auto_learned = FALSE), "
            "updated_at = NOW() WHERE id = :iid"
        ),
        {"iid": intencion_id},
    )
    logger.info("intent_examples_inserted iid=%s inserted=%d", intencion_id, inserted)
    return inserted
