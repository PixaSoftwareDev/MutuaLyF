"""Duplicate chunk management endpoints.

Endpoints:
  GET   /duplicates                        — list pending pairs (paginated)
  POST  /duplicates/{id}/resolve           — mark resolved, optionally delete chunk
  PATCH /duplicates/{id}/chunks/{which}    — edit text of chunk A or B + re-embed
  GET   /duplicates/stats                  — counts by status
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from core.database import get_pg_session, get_qdrant_client
from core.security import require_admin
from core.tenant import get_tenant_id
from services.embeddings import aembed_text

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────

class DuplicatePairResponse(BaseModel):
    id: str
    chunk_id_a: str
    chunk_id_b: str
    doc_id_a: str
    doc_id_b: str
    doc_title_a: str | None
    doc_title_b: str | None
    text_a: str
    text_b: str
    jaccard_score: float | None
    cosine_score: float | None
    status: str
    created_at: str


class ResolveRequest(BaseModel):
    action: Literal["keep_a", "keep_b", "keep_both"]


class EditChunkRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=8000)


class DuplicateStats(BaseModel):
    pending: int
    keep_a: int
    keep_b: int
    keep_both: int
    total: int


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/duplicates")
async def list_duplicates(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    filter_status: str = Query("pending"),
    tenant_id: str = Depends(get_tenant_id),
    current_user=Depends(require_admin),
):
    """List chunk duplicate pairs, filtered by status (default: pending), paginated."""
    offset = (page - 1) * page_size
    async with get_pg_session(tenant_id) as session:
        count_result = await session.execute(
            text("SELECT COUNT(*) FROM chunk_duplicate_pairs WHERE status = :s"),
            {"s": filter_status},
        )
        total = count_result.scalar() or 0

        pending_result = await session.execute(
            text("SELECT COUNT(*) FROM chunk_duplicate_pairs WHERE status = 'pending'"),
        )
        pending = pending_result.scalar() or 0

        result = await session.execute(
            text(
                "SELECT p.id, p.chunk_id_a, p.chunk_id_b, p.doc_id_a, p.doc_id_b, "
                "p.text_a, p.text_b, p.jaccard_score, p.cosine_score, p.status, p.created_at, "
                "da.title AS doc_title_a, db.title AS doc_title_b "
                "FROM chunk_duplicate_pairs p "
                "LEFT JOIN documentos da ON da.id = p.doc_id_a "
                "LEFT JOIN documentos db ON db.id = p.doc_id_b "
                "WHERE p.status = :filter_status "
                "ORDER BY p.cosine_score DESC NULLS LAST, p.created_at DESC "
                "LIMIT :limit OFFSET :offset"
            ),
            {"filter_status": filter_status, "limit": page_size, "offset": offset},
        )
        rows = result.mappings().all()

    pairs = [
        DuplicatePairResponse(
            id=str(row["id"]),
            chunk_id_a=row["chunk_id_a"],
            chunk_id_b=row["chunk_id_b"],
            doc_id_a=str(row["doc_id_a"]),
            doc_id_b=str(row["doc_id_b"]),
            doc_title_a=row["doc_title_a"],
            doc_title_b=row["doc_title_b"],
            text_a=row["text_a"],
            text_b=row["text_b"],
            jaccard_score=row["jaccard_score"],
            cosine_score=row["cosine_score"],
            status=row["status"],
            created_at=row["created_at"].isoformat(),
        )
        for row in rows
    ]
    return {"pairs": pairs, "total": total, "pending": pending}


@router.post("/duplicates/{pair_id}/resolve", status_code=status.HTTP_200_OK)
async def resolve_duplicate(
    pair_id: str,
    body: ResolveRequest,
    tenant_id: str = Depends(get_tenant_id),
    current_user=Depends(require_admin),
):
    """Resolve a duplicate pair.

    - keep_a: delete chunk_id_b from Qdrant
    - keep_b: delete chunk_id_a from Qdrant
    - keep_both: leave both in Qdrant, just mark resolved
    """
    # Atomic claim: only succeeds if status is still 'pending' (prevents TOCTOU)
    async with get_pg_session(tenant_id) as session:
        claim = await session.execute(
            text(
                "UPDATE chunk_duplicate_pairs "
                "SET status = :action, resolved_by = :user_id, resolved_at = NOW() "
                "WHERE id = :pair_id AND status = 'pending' "
                "RETURNING chunk_id_a, chunk_id_b"
            ),
            {
                "action": body.action,
                "user_id": current_user.user_id or None,
                "pair_id": pair_id,
            },
        )
        row = claim.mappings().fetchone()

    if row is None:
        # Either pair doesn't exist or was already resolved by another request
        async with get_pg_session(tenant_id) as session:
            check = await session.execute(
                text("SELECT status FROM chunk_duplicate_pairs WHERE id = :pair_id"),
                {"pair_id": pair_id},
            )
            existing = check.mappings().fetchone()
        if existing is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pair not found")
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Pair already resolved with status '{existing['status']}'",
        )

    chunk_to_delete: str | None = None
    if body.action == "keep_a":
        chunk_to_delete = row["chunk_id_b"]
    elif body.action == "keep_b":
        chunk_to_delete = row["chunk_id_a"]
    # keep_both → no deletion

    if chunk_to_delete:
        qdrant = get_qdrant_client()
        collection = f"{tenant_id}_docs"
        try:
            await qdrant.delete(
                collection_name=collection,
                points_selector=[chunk_to_delete],
            )
            logger.info(
                "duplicate_chunk_deleted pair_id=%s chunk_id=%s tenant_id=%s",
                pair_id, chunk_to_delete, tenant_id,
            )
        except Exception as exc:
            logger.warning(
                "duplicate_chunk_delete_failed pair_id=%s chunk_id=%s error=%s",
                pair_id, chunk_to_delete, exc,
            )

    logger.info(
        "duplicate_resolved pair_id=%s action=%s tenant_id=%s user=%s",
        pair_id, body.action, tenant_id, current_user.user_id,
    )
    return {"pair_id": pair_id, "action": body.action, "status": "resolved"}


@router.patch("/duplicates/{pair_id}/chunks/{which}", status_code=status.HTTP_200_OK)
async def edit_duplicate_chunk(
    pair_id: str,
    which: Literal["a", "b"],
    body: EditChunkRequest,
    tenant_id: str = Depends(get_tenant_id),
    current_user=Depends(require_admin),
):
    """Edit the text of one chunk in a duplicate pair (A or B).

    Steps:
      1. Fetch the chunk_id from the pair (chunk_id_a or chunk_id_b)
      2. Re-embed the new text via OpenAI ('passage:' prefix)
      3. Update Qdrant point: payload.text + new vector
      4. Update chunk_duplicate_pairs.text_a or text_b snapshot

    Notes:
      - Parent_chunks (PG) NO se actualizan: el par usa child chunks, los parents
        son agrupaciones distintas. Si el admin quiere afectar BM25 sobre el
        parent, tiene que editar el documento original.
      - El cosine_score del par queda stale (el vector A cambio) pero no es
        critico porque el admin esta a punto de resolver el par.
    """
    new_text = body.text.strip()
    if len(new_text) < 1:
        raise HTTPException(status_code=422, detail="Texto vacio")

    chunk_col = "chunk_id_a" if which == "a" else "chunk_id_b"
    text_col  = "text_a"     if which == "a" else "text_b"

    # 1. Fetch chunk_id
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text(f"SELECT {chunk_col} AS chunk_id FROM chunk_duplicate_pairs WHERE id = :pid"),
            {"pid": pair_id},
        )
        row = result.mappings().fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Par de duplicados no encontrado")
    chunk_id = row["chunk_id"]

    # 2. Re-embed the new text (passage prefix for indexing)
    vector = await aembed_text(f"passage: {new_text}")
    if vector is None:
        raise HTTPException(status_code=502, detail="No se pudo re-embeddear el texto")

    # 3. Update Qdrant: payload.text + vector
    qdrant = get_qdrant_client()
    collection = f"{tenant_id}_docs"
    try:
        # Get current payload to preserve other fields
        points = await qdrant.retrieve(
            collection_name=collection,
            ids=[chunk_id],
            with_payload=True,
            with_vectors=False,
        )
        if not points:
            raise HTTPException(status_code=404, detail="Chunk no existe en Qdrant")
        current_payload = points[0].payload or {}
        current_payload["text"] = new_text

        from qdrant_client.models import PointStruct
        await qdrant.upsert(
            collection_name=collection,
            points=[PointStruct(id=chunk_id, vector=vector, payload=current_payload)],
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("edit_chunk_qdrant_failed chunk_id=%s error=%s", chunk_id, exc)
        raise HTTPException(status_code=502, detail=f"Error al actualizar Qdrant: {exc}")

    # 4. Update snapshot text in chunk_duplicate_pairs
    async with get_pg_session(tenant_id) as session:
        await session.execute(
            text(f"UPDATE chunk_duplicate_pairs SET {text_col} = :t WHERE id = :pid"),
            {"t": new_text, "pid": pair_id},
        )

    logger.info(
        "duplicate_chunk_edited pair_id=%s which=%s chunk_id=%s tenant_id=%s user=%s len=%d",
        pair_id, which, chunk_id, tenant_id, current_user.user_id, len(new_text),
    )
    return {"pair_id": pair_id, "which": which, "chunk_id": chunk_id, "text": new_text}


@router.get("/duplicates/stats", response_model=DuplicateStats)
async def duplicate_stats(
    tenant_id: str = Depends(get_tenant_id),
    current_user=Depends(require_admin),
):
    """Return counts of duplicate pairs grouped by status."""
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text(
                "SELECT status, COUNT(*) AS cnt "
                "FROM chunk_duplicate_pairs "
                "GROUP BY status"
            )
        )
        rows = result.mappings().all()

    counts = {row["status"]: int(row["cnt"]) for row in rows}
    return DuplicateStats(
        pending=counts.get("pending", 0),
        keep_a=counts.get("keep_a", 0),
        keep_b=counts.get("keep_b", 0),
        keep_both=counts.get("keep_both", 0),
        total=sum(counts.values()),
    )
