"""Adjuntos en conversaciones de handoff.

El afiliado (desde el widget) y el operador (desde el panel) pueden enviar
archivos (imágenes / PDF, ≤10 MB) dentro de una conversación. El archivo se
guarda en MinIO; en `mensajes` queda la referencia + metadatos. Ambos extremos
pueden ver y descargar los adjuntos del otro.

Endpoints:
  POST /widget/conversation/{id}/attachment              → afiliado sube (widget_token)
  GET  /widget/conversation/{id}/attachment/{message_id} → afiliado descarga
  POST /operator/conversations/{id}/attachment           → operador sube (JWT + scope sector)
  GET  /operator/conversations/{id}/attachment/{message_id} → operador descarga

Seguridad: cada endpoint valida que la conversación pertenece a quien la pide
(anti-IDOR: widget_session_id para el afiliado; scope de sector para el operador).
"""

import asyncio
import io
import logging
import re
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import text

from core.config import settings
from core.database import get_minio_client, get_pg_session
from core.rate_limit import check_widget_rate_limit
from core.security import CurrentUser, get_widget_or_chat_user, require_operator
from core.tenant import get_tenant_id
from services.events import publish as _publish_event
from services.handoff import ConvStatus
from api.v1.operator_panel import _operator_sector_scope

logger = logging.getLogger(__name__)
router = APIRouter()

# Imágenes + PDF, hasta 10 MB (alcance acordado). El content-type declarado por
# el cliente es trivial de spoofear, así que también validamos los magic bytes.
_ALLOWED_MIME = {"image/png", "image/jpeg", "image/jpg", "image/webp", "application/pdf"}
_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024  # 10 MB


def _sniff_mime(content: bytes) -> str | None:
    """Detecta el mime real por magic bytes. None si no reconoce."""
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content.startswith(b"%PDF"):
        return "application/pdf"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    return None


async def _validate_and_store(file: UploadFile, tenant_id: str, conversation_id: str) -> dict:
    """Valida tipo/tamaño y sube el archivo a MinIO. Devuelve los metadatos para
    persistir en `mensajes`. Lanza HTTPException 400/413 si no pasa la validación."""
    declared = (file.content_type or "").split(";")[0].strip().lower()
    if declared == "image/jpg":
        declared = "image/jpeg"
    if declared not in _ALLOWED_MIME:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Tipo de archivo no permitido: {file.content_type}. Solo imágenes (PNG/JPG/WEBP) o PDF.",
        )

    content = await file.read()
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El archivo está vacío.")
    if len(content) > _MAX_ATTACHMENT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"El archivo supera el máximo de {_MAX_ATTACHMENT_BYTES // (1024*1024)} MB.",
        )

    real_mime = _sniff_mime(content)
    if real_mime is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El contenido del archivo no coincide con un formato permitido (imagen o PDF).",
        )

    safe_name = re.sub(r"[^\w\-.]", "_", file.filename or "archivo")[:200]
    key = f"{tenant_id}/attachments/{conversation_id}/{uuid.uuid4().hex}_{safe_name}"

    def _upload() -> None:
        client = get_minio_client()
        client.put_object(
            settings.minio_bucket, key, io.BytesIO(content),
            length=len(content), content_type=real_mime,
        )
    await asyncio.to_thread(_upload)

    # `content` se incluye para poder reenviar el adjunto a canales salientes
    # (WhatsApp) sin re-bajarlo de MinIO. Los callers que no lo usan lo ignoran.
    return {"key": key, "name": safe_name, "mime": real_mime, "size": len(content), "content": content}


async def store_attachment_bytes(
    content: bytes, filename: str, tenant_id: str, conversation_id: str
) -> dict | None:
    """Variante de _validate_and_store para binarios YA descargados (canales como
    WhatsApp que reciben el archivo, no un UploadFile). Valida magic bytes + tamaño
    y sube a MinIO. Devuelve los metadatos, o None si no pasa la validación (no lanza)."""
    if not content or len(content) > _MAX_ATTACHMENT_BYTES:
        return None
    real_mime = _sniff_mime(content)
    if real_mime is None:
        return None
    safe_name = re.sub(r"[^\w\-.]", "_", filename or "archivo")[:200]
    key = f"{tenant_id}/attachments/{conversation_id}/{uuid.uuid4().hex}_{safe_name}"

    def _upload() -> None:
        client = get_minio_client()
        client.put_object(
            settings.minio_bucket, key, io.BytesIO(content),
            length=len(content), content_type=real_mime,
        )
    await asyncio.to_thread(_upload)
    return {"key": key, "name": safe_name, "mime": real_mime, "size": len(content)}


async def _insert_attachment_message(tenant_id: str, conversation_id: str, sender_type: str, meta: dict) -> str:
    """Inserta un mensaje con adjunto (content vacío) y toca la conversación."""
    msg_id = str(uuid.uuid4())
    async with get_pg_session(tenant_id) as session:
        await session.execute(text("""
            INSERT INTO mensajes (id, conversation_id, sender_type, content,
                                  attachment_key, attachment_name, attachment_mime, attachment_size)
            VALUES (:id, :cid, :st, '', :k, :n, :m, :s)
        """), {"id": msg_id, "cid": conversation_id, "st": sender_type,
               "k": meta["key"], "n": meta["name"], "m": meta["mime"], "s": meta["size"]})
        await session.execute(
            text("UPDATE conversaciones SET updated_at = NOW() WHERE id = :id"),
            {"id": conversation_id},
        )
    return msg_id


def _stream_from_minio(key: str, mime: str, name: str, download: bool) -> StreamingResponse:
    client = get_minio_client()
    try:
        resp = client.get_object(settings.minio_bucket, key)
    except Exception as exc:
        logger.warning("attachment_minio_get_failed key=%s error=%s", key, exc)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Archivo no encontrado.")
    disp = "attachment" if download else "inline"
    return StreamingResponse(
        resp.stream(32 * 1024),
        media_type=mime or "application/octet-stream",
        headers={"Content-Disposition": f'{disp}; filename="{name or "archivo"}"'},
    )


# ── Afiliado (widget) ─────────────────────────────────────────────────────────

@router.post("/widget/conversation/{conversation_id}/attachment")
async def widget_upload_attachment(
    conversation_id: str,
    widget_session_id: str = Form(...),
    file: UploadFile = File(...),
    tenant_id: str = Depends(get_tenant_id),
    widget_user: CurrentUser = Depends(get_widget_or_chat_user),
    _rl: None = Depends(check_widget_rate_limit),
):
    async with get_pg_session(tenant_id) as session:
        row = (await session.execute(
            text("SELECT status FROM conversaciones WHERE id = :id AND widget_session_id = :sid"),
            {"id": conversation_id, "sid": widget_session_id},
        )).mappings().fetchone()
    if not row:  # anti-IDOR: no existe o no es de este afiliado
        raise HTTPException(status_code=404, detail="No encontramos la conversación. Iniciá una nueva.")
    if row["status"] == ConvStatus.CLOSED:
        raise HTTPException(status_code=410, detail="La conversación fue cerrada. Iniciá una nueva.")

    meta = await _validate_and_store(file, tenant_id, conversation_id)
    msg_id = await _insert_attachment_message(tenant_id, conversation_id, "user", meta)
    await _publish_event(tenant_id, "new_message", {"conversation_id": conversation_id})
    return {"message_id": msg_id, "attachment_name": meta["name"], "attachment_mime": meta["mime"]}


@router.get("/widget/conversation/{conversation_id}/attachment/{message_id}")
async def widget_download_attachment(
    conversation_id: str,
    message_id: str,
    widget_session_id: str,
    tenant_id: str = Depends(get_tenant_id),
    widget_user: CurrentUser = Depends(get_widget_or_chat_user),
):
    async with get_pg_session(tenant_id) as session:
        row = (await session.execute(text("""
            SELECT m.attachment_key, m.attachment_mime, m.attachment_name
            FROM mensajes m JOIN conversaciones c ON c.id = m.conversation_id
            WHERE m.id = :mid AND m.conversation_id = :cid AND c.widget_session_id = :sid
        """), {"mid": message_id, "cid": conversation_id, "sid": widget_session_id})).mappings().fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Adjunto no encontrado")
    if not row["attachment_key"]:
        # La limpieza de retención conserva el nombre pero borra el archivo:
        # name presente + key NULL = adjunto expirado (no "no existe").
        if row["attachment_name"]:
            raise HTTPException(status_code=410, detail="El adjunto expiró y ya no está disponible.")
        raise HTTPException(status_code=404, detail="Adjunto no encontrado")
    return _stream_from_minio(row["attachment_key"], row["attachment_mime"], row["attachment_name"], download=False)


# ── Operador (panel) ──────────────────────────────────────────────────────────

@router.post("/operator/conversations/{conversation_id}/attachment")
async def operator_upload_attachment(
    conversation_id: str,
    file: UploadFile = File(...),
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    scope_sql, scope_params = _operator_sector_scope(current_user, "c.sector_id")
    async with get_pg_session(tenant_id) as session:
        row = (await session.execute(
            text(f"SELECT c.status FROM conversaciones c WHERE c.id = :id{scope_sql}"),
            {"id": conversation_id, **scope_params},
        )).mappings().fetchone()
    if not row:  # 404 también si es de otro sector (no revelar existencia)
        raise HTTPException(status_code=404, detail="No encontramos la conversación. Iniciá una nueva.")
    if row["status"] == ConvStatus.CLOSED:
        raise HTTPException(status_code=409, detail="La conversación está cerrada.")

    meta = await _validate_and_store(file, tenant_id, conversation_id)
    msg_id = await _insert_attachment_message(tenant_id, conversation_id, "operator", meta)
    await _publish_event(tenant_id, "new_message", {"conversation_id": conversation_id, "sender": "operator"})

    # Si la conversación es de WhatsApp, reenviar el adjunto al cliente por Meta.
    # Fire-and-forget: la entrega al panel no depende de que Meta responda (espeja
    # al relay de texto en el endpoint de reply del operador).
    from services.whatsapp import relay_attachment_to_whatsapp
    from core.audit import fire_and_log
    fire_and_log(
        relay_attachment_to_whatsapp(
            tenant_id, conversation_id, meta["content"], meta["name"], meta["mime"], msg_id,
        ),
        "whatsapp.relay_attachment",
    )
    return {"message_id": msg_id, "attachment_name": meta["name"], "attachment_mime": meta["mime"]}


@router.get("/operator/conversations/{conversation_id}/attachment/{message_id}")
async def operator_download_attachment(
    conversation_id: str,
    message_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    scope_sql, scope_params = _operator_sector_scope(current_user, "c.sector_id")
    async with get_pg_session(tenant_id) as session:
        row = (await session.execute(text(f"""
            SELECT m.attachment_key, m.attachment_mime, m.attachment_name
            FROM mensajes m JOIN conversaciones c ON c.id = m.conversation_id
            WHERE m.id = :mid AND m.conversation_id = :cid{scope_sql}
        """), {"mid": message_id, "cid": conversation_id, **scope_params})).mappings().fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Adjunto no encontrado")
    if not row["attachment_key"]:
        if row["attachment_name"]:
            raise HTTPException(status_code=410, detail="El adjunto expiró y ya no está disponible.")
        raise HTTPException(status_code=404, detail="Adjunto no encontrado")
    return _stream_from_minio(row["attachment_key"], row["attachment_mime"], row["attachment_name"], download=True)
