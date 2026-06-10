"""Limpieza de adjuntos de conversaciones con retención configurable.

Los adjuntos (imágenes/PDF que intercambian afiliado y operador) viven en
MinIO; en `mensajes` queda la referencia (attachment_key). Pasados
`settings.attachment_retention_days` (default 60), una task nocturna:

  1. Borra el objeto de MinIO.
  2. Setea attachment_key = NULL conservando name/mime/size — el mensaje
     sigue visible en el historial y los endpoints de descarga responden
     410 "el adjunto expiró" en vez de servir el archivo.

Orden a propósito: primero MinIO, después la DB. Si el borrado en MinIO
falla, la referencia queda intacta y se reintenta en la corrida siguiente
(nunca queda un registro "vivo" apuntando a un objeto que ya no existe...
pero sí puede quedar transitoriamente un objeto huérfano si la DB falla
después — inofensivo: la corrida siguiente no lo ve y el remove es idempotente).
"""

import asyncio
import logging

from workers.celery_app import app

logger = logging.getLogger(__name__)

# Tope por tenant por corrida: evita una primera ejecución eterna si hay
# mucho backlog acumulado. Lo que no entra hoy, sale mañana.
_BATCH_LIMIT = 500


@app.task(name="workers.cleanup_tasks.delete_expired_attachments", queue="default")
def delete_expired_attachments() -> dict:
    """Borra adjuntos más viejos que la retención en todos los tenants activos."""
    return asyncio.run(_run_cleanup())


async def _run_cleanup() -> dict:
    from core.database import get_worker_pg_session
    from sqlalchemy import text

    async with get_worker_pg_session(None) as session:
        result = await session.execute(
            text("SELECT id FROM tenants WHERE status = 'active'")
        )
        tenant_ids = [row[0] for row in result.fetchall()]

    total_deleted = 0
    total_failed = 0
    for tenant_id in tenant_ids:
        try:
            deleted, failed = await _cleanup_tenant(tenant_id)
            total_deleted += deleted
            total_failed += failed
        except Exception as exc:
            logger.error("attachment_cleanup_tenant_error tenant=%s error=%s", tenant_id, exc)

    logger.info(
        "attachment_cleanup_done tenants=%d deleted=%d failed=%d",
        len(tenant_ids), total_deleted, total_failed,
    )
    return {"tenants": len(tenant_ids), "deleted": total_deleted, "failed": total_failed}


async def _cleanup_tenant(tenant_id: str) -> tuple[int, int]:
    """Limpia un tenant. Devuelve (borrados, fallidos)."""
    from core.config import settings
    from core.database import get_minio_client, get_worker_pg_session
    from sqlalchemy import text

    retention_days = settings.attachment_retention_days

    async with get_worker_pg_session(tenant_id) as session:
        result = await session.execute(text("""
            SELECT id, attachment_key
            FROM mensajes
            WHERE attachment_key IS NOT NULL
              AND created_at < NOW() - INTERVAL '1 day' * :days
            ORDER BY created_at
            LIMIT :lim
        """), {"days": retention_days, "lim": _BATCH_LIMIT})
        rows = [(str(r[0]), r[1]) for r in result.fetchall()]

    if not rows:
        return (0, 0)

    def _remove(key: str) -> None:
        # remove_object es idempotente (no falla si el objeto ya no existe),
        # así que un retry tras un fallo parcial de DB no rompe nada.
        client = get_minio_client()
        client.remove_object(settings.minio_bucket, key)

    cleared_ids: list[str] = []
    failed = 0
    for msg_id, key in rows:
        try:
            await asyncio.to_thread(_remove, key)
            cleared_ids.append(msg_id)
        except Exception as exc:
            # Se reintenta en la próxima corrida — la referencia queda intacta.
            failed += 1
            logger.warning(
                "attachment_minio_delete_failed tenant=%s message=%s key=%s error=%s",
                tenant_id, msg_id, key, exc,
            )

    if cleared_ids:
        async with get_worker_pg_session(tenant_id) as session:
            await session.execute(text("""
                UPDATE mensajes
                SET attachment_key = NULL
                WHERE id = ANY(CAST(:ids AS uuid[]))
            """), {"ids": cleared_ids})

    logger.info(
        "attachment_cleanup_tenant tenant=%s deleted=%d failed=%d retention_days=%d",
        tenant_id, len(cleared_ids), failed, retention_days,
    )
    return (len(cleared_ids), failed)
