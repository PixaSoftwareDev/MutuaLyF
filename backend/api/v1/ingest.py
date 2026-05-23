"""Document ingestion endpoint."""

import hashlib
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from pydantic import BaseModel
from qdrant_client.models import Filter, FieldCondition, MatchValue
from sqlalchemy import text

from core.config import settings
from core.database import get_pg_session, get_qdrant_client, get_minio_client
from core.security import CurrentUser, require_admin, require_operator
from core.tenant import get_tenant_id
from models.document import DocumentIngestResponse, DocumentResponse, DocumentStatus, document_response_from_row

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/documents", response_model=list[DocumentResponse])
async def list_documents(
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """List all documents for the tenant ordered by creation date (newest first)."""
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text(
                "SELECT id, title, filename, status, chunk_count, quality_gate_status, storage_key, created_at, updated_at "
                "FROM documentos ORDER BY created_at DESC LIMIT 500"
            )
        )
        rows = result.mappings().all()
        return [document_response_from_row(dict(row)) for row in rows]


@router.get("/documents/{document_id}/status")
async def document_status(
    document_id: uuid.UUID,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Lightweight status poll for a single document. Used by the upload progress bar."""
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text(
                "SELECT status, chunk_count, quality_gate_status "
                "FROM documentos WHERE id = :id"
            ),
            {"id": document_id},
        )
        row = result.mappings().fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Document not found")
    return {
        "status": row["status"],
        "chunk_count": row["chunk_count"],
        "quality_gate_status": row["quality_gate_status"],
    }


@router.get("/documents/{document_id}/download")
async def download_document(
    document_id: uuid.UUID,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Return a short-lived presigned MinIO URL for direct download."""
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text("SELECT filename, storage_key FROM documentos WHERE id = :id"),
            {"id": document_id},
        )
        row = result.mappings().fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Document not found")
    if not row["storage_key"]:
        raise HTTPException(status_code=404, detail="Original file not stored")

    import asyncio as _asyncio
    from datetime import timedelta

    def _presign() -> str:
        client = get_minio_client()
        url = client.presigned_get_object(
            settings.minio_bucket,
            row["storage_key"],
            expires=timedelta(hours=1),
        )
        return url

    presigned_url = await _asyncio.to_thread(_presign)
    return {"url": presigned_url, "filename": row["filename"]}


@router.get("/documents/{document_id}/chunks")
async def list_chunks(
    document_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Return all chunks for a document, retrieved from Qdrant."""
    qdrant = get_qdrant_client()
    results, _ = await qdrant.scroll(
        collection_name=f"{tenant_id}_docs",
        scroll_filter=Filter(
            must=[FieldCondition(key="document_id", match=MatchValue(value=document_id))]
        ),
        limit=500,
        with_payload=True,
        with_vectors=False,
    )
    chunks = sorted(
        [
            {
                "id": str(point.id),
                "chunk_index": point.payload.get("chunk_index", 0),
                "total_chunks": point.payload.get("total_chunks", 1),
                "text": point.payload.get("text", ""),
                "quality_gate_status": point.payload.get("quality_gate_status", "pending"),
                "quality_gate_confidence": point.payload.get("quality_gate_confidence"),
                "quality_gate_reason": point.payload.get("quality_gate_reason"),
                "manually_reviewed": point.payload.get("manually_reviewed", False),
                "reviewed_by": point.payload.get("reviewed_by"),
            }
            for point in results
        ],
        key=lambda c: c["chunk_index"],
    )
    return chunks


@router.get("/chunks/pending")
async def list_pending_chunks(
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Return chunks awaiting human review (quality_gate_status == 'pending').

    Skipped chunks are excluded — they already have a decision (Groq descartó
    el contenido). El admin puede revisarlos abriendo el documento si quiere
    rescatar alguno puntual; no son parte de la cola de "por revisar".
    """
    qdrant = get_qdrant_client()
    collection = f"{tenant_id}_docs"

    results, _ = await qdrant.scroll(
        collection_name=collection,
        scroll_filter=Filter(
            must=[
                FieldCondition(
                    key="quality_gate_status",
                    match=MatchValue(value="pending"),
                )
            ]
        ),
        limit=500,
        with_payload=True,
        with_vectors=False,
    )

    # Group by document_id and enrich with document title from PG
    doc_ids = list({p.payload.get("document_id") for p in results if p.payload.get("document_id")})
    doc_titles: dict[str, str] = {}
    if doc_ids:
        async with get_pg_session(tenant_id) as session:
            placeholders = ", ".join(f":id{i}" for i in range(len(doc_ids)))
            rows = await session.execute(
                text(f"SELECT id, title FROM documentos WHERE id IN ({placeholders})"),
                {f"id{i}": did for i, did in enumerate(doc_ids)},
            )
            doc_titles = {str(r["id"]): r["title"] for r in rows.mappings().all()}

    chunks = sorted(
        [
            {
                "id": str(p.id),
                "document_id": p.payload.get("document_id"),
                "document_title": doc_titles.get(p.payload.get("document_id", ""), "—"),
                "chunk_index": p.payload.get("chunk_index", 0),
                "total_chunks": p.payload.get("total_chunks", 1),
                "text": p.payload.get("text", ""),
                "quality_gate_status": p.payload.get("quality_gate_status", "pending"),
                "quality_gate_confidence": p.payload.get("quality_gate_confidence"),
                "quality_gate_reason": p.payload.get("quality_gate_reason"),
                "manually_reviewed": p.payload.get("manually_reviewed", False),
                "reviewed_by": p.payload.get("reviewed_by"),
            }
            for p in results
        ],
        key=lambda c: (c["document_id"], c["chunk_index"]),
    )
    return chunks


class ChunkReviewBody(BaseModel):
    action: Literal["approve", "reject"]


@router.patch("/documents/{document_id}/chunks/{chunk_id}/quality")
async def review_chunk(
    document_id: str,
    chunk_id: str,
    body: ChunkReviewBody,
    request: Request,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Manually override the quality_gate_status of a single chunk.

    approve → status: passed
    reject  → status: skipped

    The override is stamped in the Qdrant payload (manually_reviewed,
    reviewed_by, reviewed_at). The Celery retry task respects this stamp
    and will not overwrite a manually reviewed chunk.

    After the update, the document's aggregate quality_gate_status in
    PostgreSQL is recalculated from all its chunks.
    """
    qdrant = get_qdrant_client()
    collection = f"{tenant_id}_docs"

    # Verify chunk exists and belongs to this document
    results = await qdrant.retrieve(
        collection_name=collection,
        ids=[chunk_id],
        with_payload=True,
    )
    if not results:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chunk not found")
    if results[0].payload.get("document_id") != document_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Chunk does not belong to this document")

    new_status = "passed" if body.action == "approve" else "skipped"
    now = datetime.now(timezone.utc).isoformat()

    await qdrant.set_payload(
        collection_name=collection,
        payload={
            "quality_gate_status": new_status,
            "manually_reviewed": True,
            "reviewed_by": current_user.email,
            "reviewed_at": now,
        },
        points=[chunk_id],
    )

    # Recalculate document aggregate quality status from all its chunks
    all_chunks, _ = await qdrant.scroll(
        collection_name=collection,
        scroll_filter=Filter(
            must=[FieldCondition(key="document_id", match=MatchValue(value=document_id))]
        ),
        limit=1000,
        with_payload=True,
        with_vectors=False,
    )
    status_list = [p.payload.get("quality_gate_status", "pending") for p in all_chunks]
    passed_count = sum(1 for s in status_list if s == "passed")
    pending_count = sum(1 for s in status_list if s == "pending")
    if pending_count > 0:
        agg = "pending"
    elif passed_count > 0:
        agg = "passed"
    else:
        agg = "skipped"

    async with get_pg_session(tenant_id) as session:
        await session.execute(
            text("UPDATE documentos SET quality_gate_status = :qgs, updated_at = NOW() WHERE id = :id"),
            {"qgs": agg, "id": document_id},
        )

    logger.info(
        "chunk_reviewed document_id=%s chunk_id=%s action=%s new_status=%s agg=%s user=%s",
        document_id, chunk_id, body.action, new_status, agg, current_user.email,
    )

    import asyncio
    from core.audit import record as audit
    asyncio.ensure_future(audit(
        tenant_id=tenant_id,
        actor_id=current_user.user_id,
        actor_email=current_user.email,
        actor_role=current_user.role.value,
        action="chunk.review",
        resource=chunk_id,
        detail={"action": body.action, "document_id": document_id, "new_status": new_status},
        request=request,
    ))

    return {"chunk_id": chunk_id, "quality_gate_status": new_status, "document_quality_gate_status": agg}


@router.delete("/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(
    document_id: str,
    request: Request,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """Delete a document and all associated data: PG record, Qdrant chunks, Neo4j nodes, parent_chunks, MinIO file."""
    # 1. Verify document exists and belongs to this tenant; fetch storage_key for MinIO cleanup
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text("SELECT id, storage_key FROM documentos WHERE id = :id"), {"id": document_id}
        )
        # Usar .mappings() para que el Row se comporte como dict (acceso por nombre).
        # Sin esto, doc["storage_key"] falla con "tuple indices must be integers or slices, not str"
        # porque Row de SQLAlchemy solo soporta indexing posicional por default.
        doc = result.mappings().fetchone()
        if doc is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
        storage_key = doc["storage_key"]

    # 2. Delete Qdrant chunks (filter by document_id in payload)
    qdrant = get_qdrant_client()
    try:
        await qdrant.delete(
            collection_name=f"{tenant_id}_docs",
            points_selector=Filter(
                must=[FieldCondition(key="document_id", match=MatchValue(value=document_id))]
            ),
        )
    except Exception as e:
        logger.warning("delete_qdrant_chunks_failed document_id=%s error=%s", document_id, e)

    # 3. Delete Neo4j nodes for this document (chunks, document, and orphaned entities)
    try:
        from core.database import get_neo4j_driver
        neo4j = get_neo4j_driver()
        database = tenant_id if settings.neo4j_multidatabase else "neo4j"
        async with neo4j.session(database=database) as neo4j_session:
            # Step 1: delete entity→chunk edges for this document's chunks, then
            # delete any entity nodes that now have no remaining MENCIONADA_EN edges.
            await neo4j_session.run(
                """
                MATCH (c:Chunk {tenant_id: $tenant_id})-[:PERTENECE_A]->
                      (d:Documento {id: $doc_id, tenant_id: $tenant_id})
                WITH c, d
                OPTIONAL MATCH (e)-[r:MENCIONADA_EN]->(c)
                DELETE r
                WITH c, d, e
                WHERE e IS NOT NULL AND NOT (e)-[:MENCIONADA_EN]->()
                DELETE e
                """,
                tenant_id=tenant_id, doc_id=document_id,
            )
            # Step 2: delete chunk and document nodes
            await neo4j_session.run(
                """
                MATCH (c:Chunk {tenant_id: $tenant_id})-[:PERTENECE_A]->
                      (d:Documento {id: $doc_id, tenant_id: $tenant_id})
                DETACH DELETE c, d
                """,
                tenant_id=tenant_id, doc_id=document_id,
            )
    except Exception as e:
        logger.warning("delete_neo4j_nodes_failed document_id=%s error=%s", document_id, e)

    # 4. Delete parent_chunks (BM25 full-text search index)
    async with get_pg_session(tenant_id) as session:
        await session.execute(
            text("DELETE FROM parent_chunks WHERE document_id = :id"), {"id": document_id}
        )

    # 5. Delete original file from MinIO
    if storage_key:
        try:
            import asyncio as _asyncio
            def _delete_from_minio() -> None:
                client = get_minio_client()
                client.remove_object(settings.minio_bucket, storage_key)
            await _asyncio.to_thread(_delete_from_minio)
            logger.info("minio_delete_ok document_id=%s key=%s", document_id, storage_key)
        except Exception as e:
            logger.warning("minio_delete_failed document_id=%s error=%s", document_id, e)

    # 6. Delete PG record
    async with get_pg_session(tenant_id) as session:
        await session.execute(
            text("DELETE FROM documentos WHERE id = :id"), {"id": document_id}
        )

    logger.info("document_deleted document_id=%s tenant_id=%s user=%s", document_id, tenant_id, current_user.user_id)

    import asyncio
    from core.audit import record as audit
    asyncio.ensure_future(audit(
        tenant_id=tenant_id,
        actor_id=current_user.user_id,
        actor_email=current_user.email,
        actor_role=current_user.role.value,
        action="document.delete",
        resource=document_id,
        request=request,
    ))


ALLOWED_MIME_TYPES = {
    "application/pdf",
    "text/plain",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/html",
    "application/json",
    "application/octet-stream",  # Some browsers send this for .docx — detected by extension below
}

_EXTENSION_MIME_MAP = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pdf":  "application/pdf",
    ".txt":  "text/plain",
    ".html": "text/html",
    ".htm":  "text/html",
    ".json": "application/json",
}

# Max file size per plan is enforced in nginx. Here we enforce a hard cap.
_MAX_FILE_BYTES = 200 * 1024 * 1024  # 200 MB (enterprise plan max)

_UPLOAD_DIR = "/tmp/ia_ingest"


def _ensure_upload_dir() -> None:
    os.makedirs(_UPLOAD_DIR, exist_ok=True)


def _compute_file_hashes(file_bytes: bytes, mime_type: str) -> tuple[str, str]:
    """Compute (hash_bytes, hash_text) for duplicate detection.

    hash_bytes: SHA-256 of raw file bytes (exact binary match).
    hash_text: SHA-256 of extracted+normalized text (same content, different format).
    """
    hash_bytes = hashlib.sha256(file_bytes).hexdigest()

    try:
        if mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
            import io
            from docx import Document as DocxDocument
            doc = DocxDocument(io.BytesIO(file_bytes))
            raw_text = "\n".join(p.text for p in doc.paragraphs)
        elif mime_type == "application/pdf":
            try:
                import fitz  # PyMuPDF
                pdf = fitz.open(stream=file_bytes, filetype="pdf")
                raw_text = "\n".join(page.get_text() for page in pdf)
                pdf.close()
            except ImportError:
                from pdfminer.high_level import extract_text as pdfminer_extract
                import io
                raw_text = pdfminer_extract(io.BytesIO(file_bytes))
        else:
            # text/plain, text/html, fallback
            raw_text = file_bytes.decode("utf-8", errors="replace")

        # Normalize: lowercase, strip, collapse whitespace
        normalized = " ".join(raw_text.lower().split())
        hash_text = hashlib.sha256(normalized.encode()).hexdigest()
    except Exception as exc:
        logger.warning("hash_text_extraction_failed mime_type=%s error=%s", mime_type, exc)
        # Fall back to hash_bytes so we still detect exact copies
        hash_text = hash_bytes

    return hash_bytes, hash_text


async def _check_duplicate_document(session, hash_bytes: str, hash_text: str) -> dict | None:
    """Query documentos for an existing doc matching either hash.

    Returns {id, title, filename, created_at} if found, else None.
    """
    result = await session.execute(
        text(
            "SELECT id, title, filename, created_at, "
            "content_hash_bytes, content_hash_text "
            "FROM documentos "
            "WHERE content_hash_bytes = :hash_bytes OR content_hash_text = :hash_text "
            "LIMIT 1"
        ),
        {"hash_bytes": hash_bytes, "hash_text": hash_text},
    )
    row = result.mappings().fetchone()
    if row is None:
        return None
    return {
        "id": str(row["id"]),
        "title": row["title"],
        "filename": row["filename"],
        "created_at": row["created_at"].isoformat() if isinstance(row["created_at"], datetime) else str(row["created_at"]),
        "_matched_bytes": row["content_hash_bytes"] == hash_bytes,
    }


@router.post("/ingest", response_model=DocumentIngestResponse, status_code=status.HTTP_202_ACCEPTED)
async def ingest_document(
    request: Request,
    file: UploadFile = File(...),
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_operator),
):
    """Upload a document and enqueue it for async processing.

    Returns 202 Accepted immediately. Poll document status via GET /documents/{id}.
    """
    # Strip charset/boundary params: "text/plain; charset=utf-8" → "text/plain"
    mime_type = (file.content_type or "").split(";")[0].strip()

    # Resolve generic octet-stream by file extension (e.g. .docx from some browsers)
    if mime_type == "application/octet-stream" and file.filename:
        import pathlib
        ext = pathlib.Path(file.filename).suffix.lower()
        mime_type = _EXTENSION_MIME_MAP.get(ext, mime_type)

    if mime_type not in ALLOWED_MIME_TYPES or mime_type == "application/octet-stream":
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Tipo de archivo no soportado: {file.content_type}. Use PDF, DOCX, TXT o HTML.",
        )

    # Read and check size before writing to disk
    content = await file.read()
    if not content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El archivo está vacío.",
        )
    if len(content) > _MAX_FILE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds maximum allowed size of {_MAX_FILE_BYTES // (1024*1024)} MB",
        )

    # ── Compute file hashes for duplicate detection ───────────────────────────
    # Run in thread pool — PDF/DOCX parsing is CPU-bound and would block the event loop.
    import asyncio as _asyncio
    hash_bytes, hash_text = await _asyncio.to_thread(_compute_file_hashes, content, mime_type)

    document_id = str(uuid.uuid4())
    logger.info(
        "ingest_received tenant_id=%s document_id=%s filename=%s size_bytes=%d",
        tenant_id, document_id, file.filename, len(content),
    )

    # ── Atomic insert with duplicate detection (avoids TOCTOU race) ──────────
    # INSERT ... ON CONFLICT DO NOTHING. If 0 rows inserted → duplicate exists.
    # NOTE: the constraint covers hash_bytes (byte-identical files). For same-content
    # different-format duplicates (PDF vs DOCX of same text), we do a pre-check on
    # hash_text. A tiny TOCTOU window remains but the consequence is a duplicate doc,
    # not data loss — acceptable given the rarity of concurrent same-content uploads.
    async with get_pg_session(tenant_id) as session:
        text_dup_result = await session.execute(
            text(
                "SELECT id, title, filename, created_at FROM documentos "
                "WHERE content_hash_text = :h AND content_hash_bytes != :hb LIMIT 1"
            ),
            {"h": hash_text, "hb": hash_bytes},
        )
        text_dup_row = text_dup_result.mappings().fetchone()
        if text_dup_row is not None:
            logger.info(
                "ingest_text_hash_duplicate tenant_id=%s existing_id=%s",
                tenant_id, text_dup_row["id"],
            )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "detail": "Documento duplicado",
                    "duplicate_of": {
                        "id": str(text_dup_row["id"]),
                        "title": text_dup_row["title"],
                        "filename": text_dup_row["filename"],
                        "created_at": (
                            text_dup_row["created_at"].isoformat()
                            if isinstance(text_dup_row["created_at"], datetime)
                            else str(text_dup_row["created_at"])
                        ),
                    },
                    "match_type": "same_content",
                },
            )
        insert_result = await session.execute(
            text(
                "INSERT INTO documentos (id, title, filename, mime_type, size_bytes, uploaded_by, "
                "content_hash_bytes, content_hash_text) "
                "VALUES (:id, :title, :filename, :mime_type, :size_bytes, :uploaded_by, "
                ":content_hash_bytes, :content_hash_text) "
                "ON CONFLICT ON CONSTRAINT uq_doc_hash_bytes DO NOTHING "
                "RETURNING id"
            ),
            {
                "id": document_id,
                "title": file.filename or document_id,
                "filename": file.filename or document_id,
                "mime_type": mime_type,
                "size_bytes": len(content),
                "uploaded_by": current_user.user_id or "system",
                "content_hash_bytes": hash_bytes,
                "content_hash_text": hash_text,
            },
        )
        inserted = insert_result.fetchone()

        if inserted is None:
            # Duplicate detected — fetch existing record to return in the 409
            existing = await _check_duplicate_document(session, hash_bytes, hash_text)
            matched_bytes = existing.pop("_matched_bytes", False) if existing else False
            match_type = "exact_bytes" if matched_bytes else "same_content"
            logger.info(
                "ingest_duplicate_detected tenant_id=%s existing_id=%s match_type=%s",
                tenant_id, existing["id"] if existing else "unknown", match_type,
            )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "detail": "Documento duplicado",
                    "duplicate_of": existing or {},
                    "match_type": match_type,
                },
            )

    # ── Upload original file to MinIO ─────────────────────────────────────────
    import io as _io
    import asyncio as _asyncio

    safe_name = re.sub(r"[^\w\-.]", "_", file.filename or "unknown")[:200]
    storage_key = f"{tenant_id}/{document_id}/{safe_name}"

    def _upload_to_minio() -> None:
        client = get_minio_client()
        client.put_object(
            settings.minio_bucket,
            storage_key,
            _io.BytesIO(content),
            length=len(content),
            content_type=mime_type,
        )

    try:
        await _asyncio.to_thread(_upload_to_minio)
        async with get_pg_session(tenant_id) as session:
            await session.execute(
                text("UPDATE documentos SET storage_key = :key WHERE id = :id"),
                {"key": storage_key, "id": document_id},
            )
        logger.info("minio_upload_ok document_id=%s key=%s", document_id, storage_key)
    except Exception as exc:
        logger.warning("minio_upload_failed document_id=%s error=%s — continuing without storage", document_id, exc)

    # ── Write to temp dir and enqueue Celery task ─────────────────────────────
    _ensure_upload_dir()
    file_path = os.path.join(_UPLOAD_DIR, f"{document_id}_{safe_name}")
    with open(file_path, "wb") as f:
        f.write(content)

    from workers.ingest_tasks import process_document
    process_document.apply_async(
        args=[document_id, tenant_id, file_path, mime_type, file.filename or safe_name],
        queue="ingest",
    )

    import asyncio
    from core.audit import record as audit
    asyncio.ensure_future(audit(
        tenant_id=tenant_id,
        actor_id=current_user.user_id,
        actor_email=current_user.email,
        actor_role=current_user.role.value,
        action="document.upload",
        resource=document_id,
        detail={"filename": file.filename, "size_bytes": len(content), "mime_type": mime_type},
        request=request,
    ))

    return DocumentIngestResponse(
        document_id=document_id,
        status=DocumentStatus.PENDING,
        message="Document queued for processing",
    )
