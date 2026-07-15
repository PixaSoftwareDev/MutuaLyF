"""Reconciliación de consistencia PG ↔ Qdrant para ejemplos de intenciones.

Por qué existe: la indexación de ejemplos es dual-write (PG primero, Qdrant
después) y el paso de Qdrant depende de la API de embeddings. Si embeddings
falla (rate limit, cuota, red), los ejemplos quedan en PG pero invisibles para
el clasificador (incidente 2026-07-10: 694 en PG vs 285 en Qdrant tras agotar
la cuota de OpenAI). Este módulo detecta y repara esa deriva.

También purga puntos viejos del cache semántico de consultas: sus payloads
solo referencian claves de Redis con TTL 1h, así que un punto viejo es basura
que nunca produce un hit (la clave ya expiró) pero sigue ocupando el índice.
"""

import json
import logging
import time
import asyncio

logger = logging.getLogger(__name__)

_BATCH = 40
_MAX_ATTEMPTS = 5
_BACKOFF_BASE_S = 20
_QUERY_CACHE_MAX_AGE_S = 7 * 24 * 3600  # puntos del cache semántico > 7 días = huérfanos


async def reconcile_intent_examples(tenant_id: str) -> dict:
    """Indexa en Qdrant los ejemplos que están en PG pero no en la colección.

    Idempotente (ids deterministas). Batches chicos con backoff para convivir
    con rate limits de embeddings. Devuelve un summary para logging/alerta.
    """
    from core.database import get_worker_pg_session, get_worker_qdrant_client
    from services.embeddings import embed_batch
    from services.intent_examples import qdrant_point_id
    from sqlalchemy import text

    collection = f"{tenant_id}_intenciones"
    summary = {"tenant_id": tenant_id, "pg": 0, "qdrant_before": 0,
               "missing": 0, "indexed": 0, "failed": 0}

    async with get_worker_pg_session(tenant_id) as session:
        rows = (await session.execute(text("""
            SELECT e.intencion_id::text, i.label, e.question_text
            FROM intencion_ejemplos e
            JOIN intenciones i ON i.id = e.intencion_id
            WHERE i.is_active
        """))).fetchall()
    summary["pg"] = len(rows)
    if not rows:
        return summary

    async with get_worker_qdrant_client() as qdrant:
        try:
            existing: set = set()
            offset = None
            while True:
                points, offset = await qdrant.scroll(
                    collection_name=collection, limit=256,
                    offset=offset, with_payload=False, with_vectors=False,
                )
                existing.update(str(p.id) for p in points)
                if offset is None:
                    break
        except Exception as exc:
            logger.warning("reconcile_scroll_failed tenant=%s error=%s", tenant_id, exc)
            return summary
        summary["qdrant_before"] = len(existing)

        missing = [
            (iid, label, txt, qdrant_point_id(iid, txt))
            for iid, label, txt in rows
            if qdrant_point_id(iid, txt) not in existing
        ]
        summary["missing"] = len(missing)
        if not missing:
            return summary

        logger.info("reconcile_start tenant=%s pg=%d qdrant=%d missing=%d",
                    tenant_id, len(rows), len(existing), len(missing))

        from qdrant_client.models import PointStruct
        loop = asyncio.get_running_loop()
        for i in range(0, len(missing), _BATCH):
            batch = missing[i:i + _BATCH]
            vecs = None
            for attempt in range(_MAX_ATTEMPTS):
                vecs = await loop.run_in_executor(
                    None, embed_batch, [m[2] for m in batch], True)
                if vecs and all(v is not None for v in vecs):
                    break
                await asyncio.sleep(_BACKOFF_BASE_S * (attempt + 1))
            points = [
                PointStruct(id=pid, vector=v,
                            payload={"intention_id": iid, "label": label, "text": txt})
                for (iid, label, txt, pid), v in zip(batch, vecs or []) if v is not None
            ]
            if points:
                await qdrant.upsert(collection_name=collection, points=points)
                summary["indexed"] += len(points)
            summary["failed"] += len(batch) - len(points)

    if summary["failed"]:
        # No se pudo completar (p. ej. cuota agotada) — el beat diario reintenta.
        logger.warning("reconcile_incomplete %s", json.dumps(summary))
    else:
        logger.info("reconcile_done %s", json.dumps(summary))
    return summary


async def purge_stale_query_cache(tenant_id: str) -> int:
    """Borra puntos del cache semántico cuyo Redis (TTL 1h) expiró hace días."""
    from core.database import get_worker_qdrant_client
    from qdrant_client.models import FieldCondition, Filter, FilterSelector, Range

    collection = f"{tenant_id}_query_cache"
    cutoff = int(time.time()) - _QUERY_CACHE_MAX_AGE_S
    try:
        async with get_worker_qdrant_client() as qdrant:
            info = await qdrant.get_collection(collection)
            before = info.points_count or 0
            await qdrant.delete(
                collection_name=collection,
                points_selector=FilterSelector(filter=Filter(must=[
                    FieldCondition(key="cached_at", range=Range(lt=cutoff)),
                ])),
            )
            info = await qdrant.get_collection(collection)
            purged = before - (info.points_count or 0)
            if purged:
                logger.info("query_cache_purged tenant=%s points=%d", tenant_id, purged)
            return purged
    except Exception as exc:
        # Colección puede no existir todavía — no es un error.
        logger.debug("query_cache_purge_skipped tenant=%s error=%s", tenant_id, exc)
        return 0
