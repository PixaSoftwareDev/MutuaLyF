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
                "FROM documentos ORDER BY created_at DESC LIMIT 2000"
            )
        )
        rows = result.mappings().all()
        return [document_response_from_row(dict(row)) for row in rows]


@router.get("/documents/search")
async def search_documents_content(
    q: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Busca dentro del CONTENIDO de los documentos (no solo el título).

    Devuelve los document_id cuyas partes mencionan el término, con la cantidad
    de coincidencias. Combina full-text en español (con stemming, vía el índice
    GIN de parent_chunks.ts_body) con ILIKE para substrings/nombres propios que
    el stemming no cubre. El frontend lo usa para el buscador de la tabla.
    """
    term = q.strip()
    if len(term) < 2:
        return []
    async with get_pg_session(tenant_id) as session:
        # El LIKE es insensible a tildes vía translate() en ambos lados: buscar
        # "garantia" encuentra "garantía" (coherente con el filtro del detalle).
        # Sin extensión unaccent — la base compartida prod/staging no la tiene y
        # agregarla implica migración coordinada. Seq scan aceptable: parent_chunks
        # por tenant es chico (cientos de filas).
        accented, plain = "áéíóúàèìòùäëïöüâêîôûñç", "aeiouaeiouaeiouaeiounc"
        # `matches` = MENCIONES del término en el documento (ocurrencias reales,
        # no "partes que matchean"): es lo que el usuario espera leer como
        # "N coincidencias". Se cuenta sobre parent_chunks (texto sin solapar —
        # los chunks hijos de Qdrant se pisan por el overlap y duplicarían).
        # Si solo matchea el full-text (stemming: "psicólogos" para "psicólogo")
        # sin ocurrencia literal, la parte aporta 1 para no reportar 0.
        norm_term = term.lower().translate(str.maketrans(accented, plain))
        result = await session.execute(
            text(
                "SELECT document_id, SUM(GREATEST("
                "  (length(t) - length(replace(t, :q_norm, ''))) / length(:q_norm), "
                "  CASE WHEN fts THEN 1 ELSE 0 END"
                ")) AS matches FROM ("
                "  SELECT document_id, translate(lower(text), :acc, :pl) AS t, "
                "         ts_body @@ plainto_tsquery('spanish', :q) AS fts "
                "  FROM parent_chunks"
                ") s "
                "WHERE fts OR t LIKE '%' || :q_like || '%' "
                "GROUP BY document_id ORDER BY matches DESC LIMIT 200"
            ),
            {
                "q": term,
                "acc": accented,
                "pl": plain,
                # Para contar ocurrencias: término normalizado igual que la columna.
                "q_norm": norm_term,
                # Para el LIKE: además escapado (% y _ literales).
                "q_like": norm_term.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_"),
            },
        )
        return [
            {"document_id": str(row["document_id"]), "matches": row["matches"]}
            for row in result.mappings().all()
        ]


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


@router.get("/contradictions")
async def list_contradictions(
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Campos en conflicto detectados en el corpus (direcciones/teléfonos).

    El admin usa esto para encontrar y corregir el chunk erróneo. Incluye el valor
    canónico (mayoría por sujeto) y las variantes minoritarias (probables errores)."""
    import json
    from core.database import get_redis_cache
    redis = get_redis_cache()
    try:
        raw_c = await redis.get(f"{tenant_id}:contradictions")
        raw_f = await redis.get(f"{tenant_id}:canonical_facts")
    except Exception:
        raw_c = raw_f = None
    return {
        "contradictions": json.loads(raw_c) if raw_c else [],
        "canonical_facts": json.loads(raw_f) if raw_f else {},
    }


@router.post("/contradictions/scan", status_code=status.HTTP_202_ACCEPTED)
async def scan_contradictions(
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Dispara un re-escaneo de contradicciones para el tenant (async)."""
    from workers.maintenance_tasks import detect_contradictions_task
    detect_contradictions_task.apply_async(args=[tenant_id], queue="clustering")
    return {"status": "scan_enqueued", "tenant_id": tenant_id}


@router.get("/documents/{document_id}/download")
async def download_document(
    document_id: uuid.UUID,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    import asyncio as _asyncio, mimetypes
    from fastapi.responses import Response
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
    def _fetch():
        client = get_minio_client()
        obj = client.get_object(settings.minio_bucket, row["storage_key"])
        data = obj.read()
        obj.close()
        obj.release_conn()
        return data
    content = await _asyncio.to_thread(_fetch)
    filename = row["filename"] or "archivo"
    media_type, _ = mimetypes.guess_type(filename)
    cd = f"attachment; filename=\"{filename}\""
    return Response(content=content, media_type=media_type or "application/octet-stream", headers={"Content-Disposition": cd})


_PREFIJO_INDEXADO_RE = re.compile(r"\[[^\]\n]*\]")
# Formato exclusivo del indexador (services/chunker.py:_build_contact_prefix):
# no puede confundirse con contenido del documento, así que se quita esté donde esté.
_PREFIJO_CONTACTO_RE = re.compile(r"^[ \t]*\[Datos de contacto:[^\]\n]*\][ \t]*\n?", re.MULTILINE)


def _sin_prefijos_del_indexador(texto: str) -> str:
    """Quita los prefijos que el procesador antepone al indexar.

    Al armar el texto que va al buscador, el chunker le pone delante
    "[Datos de contacto: ...]" y/o "[Encabezado de sección]", cada uno en su
    propia línea (services/chunker.py:495). Son señales para la búsqueda, no
    contenido del documento.

    Hay que sacarlos al reconstruir el documento: si no, cada reproceso los
    vuelve a anteponer sobre un texto que ya los tenía y se van acumulando
    ("[Datos de contacto: email]" dos y tres veces en el mismo fragmento).

    Los dos se tratan distinto porque son cosas distintas:

    - "[Datos de contacto: ...]" es una señal para el buscador, no está en el
      documento. Se elimina, esté donde esté (puede haber quedado en el medio
      por reprocesos anteriores).

    - El encabezado SÍ es texto del documento —el título de la sección o la
      pregunta que encabeza la respuesta—; el indexador solo lo repite entre
      corchetes al principio del fragmento. Se le quitan los corchetes y se
      conserva: borrarlo dejaría el documento sin sus preguntas.
    """
    texto = _PREFIJO_CONTACTO_RE.sub("", texto)
    lineas = texto.split("\n")
    i = 0
    while i < len(lineas) and _PREFIJO_INDEXADO_RE.fullmatch(lineas[i].strip()):
        lineas[i] = lineas[i].strip()[1:-1].strip()   # sin corchetes, con su texto
        i += 1
    return "\n".join(lineas).strip()


def _cuerpo_del_fragmento(texto: str) -> str:
    """Texto del fragmento SIN sus líneas de prefijo del indexador.

    A diferencia de _sin_prefijos_del_indexador (que conserva el encabezado sin
    corchetes, porque reconstruye el documento completo), acá el encabezado
    repetido se descarta: para ubicar el fragmento DENTRO de su parent hay que
    comparar solo el contenido — el parent ya trae su encabezado una única vez.
    """
    texto = _PREFIJO_CONTACTO_RE.sub("", texto)
    lineas = texto.split("\n")
    i = 0
    while i < len(lineas) and _PREFIJO_INDEXADO_RE.fullmatch(lineas[i].strip()):
        i += 1
    return "\n".join(lineas[i:]).strip()


def _parent_con_fragmento_editado(parent_text: str, old_child: str, new_child: str) -> str | None:
    """Parent actualizado tras editar UNO de sus fragmentos, o None si el
    fragmento anterior no se puede ubicar dentro del parent.

    El parent NUNCA se reemplaza entero por el texto del fragmento: cuando el
    parent tiene varios fragmentos, eso descartaba el resto de su contenido
    para la búsqueda BM25 y para el contexto del LLM (bug hallado 2026-08-18).
    Solo el caso 1 parent = 1 fragmento equivale al reemplazo total.
    """
    viejo = _cuerpo_del_fragmento(old_child)
    nuevo = _cuerpo_del_fragmento(new_child)
    if not viejo:
        return None
    limpio_parent = parent_text.strip()
    # Caso 1 parent = 1 fragmento: el fragmento ES el parent (con su encabezado
    # o solo el cuerpo). El texto nuevo conserva el encabezado si lo trae.
    if limpio_parent in (viejo, _sin_prefijos_del_indexador(old_child)):
        return _sin_prefijos_del_indexador(new_child)
    # Fragmento dentro de un parent con más contenido: reemplazo puntual.
    if viejo in parent_text:
        return parent_text.replace(viejo, nuevo, 1)
    return None


async def _texto_vigente(document_id: str, tenant_id: str) -> str:
    """Documento tal como lo usa el asistente hoy: las partes en uso, en orden,
    CON las correcciones hechas a mano y sin las marcadas "sin usar".

    Es la única representación completa y al día del documento: el archivo
    original no tiene las correcciones del panel.

    Se reconstruye desde los PARENTS (PostgreSQL), no desde los fragmentos de
    búsqueda en Qdrant: los fragmentos se guardan con solapamiento entre sí
    (child_chunk_overlap_words) y unirlos repetía esas palabras en cada
    costura — y cada reproceso volvía a partir y solapar, acumulando
    repeticiones (bug hallado 2026-08-18). Los parents no se solapan y
    reciben las correcciones del panel (edit_chunk_text los actualiza).

    Un parent cuenta como "sin usar" solo si TODOS sus fragmentos en Qdrant
    están marcados 'skipped'. (Antes se excluía fragmento por fragmento; el
    costo de este cambio es que un fragmento suelto marcado "sin usar" dentro
    de un parent con otros vigentes reaparece al reprocesar.)
    """
    qdrant = get_qdrant_client()
    results, _ = await qdrant.scroll(
        collection_name=f"{tenant_id}_docs",
        scroll_filter=Filter(
            must=[FieldCondition(key="document_id", match=MatchValue(value=str(document_id)))]
        ),
        limit=1000,
        with_payload=["parent_id", "quality_gate_status"],
        with_vectors=False,
    )
    parent_en_uso: dict[str, bool] = {}
    for p in results:
        payload = p.payload or {}
        pid = str(payload.get("parent_id") or "")
        en_uso = payload.get("quality_gate_status") != "skipped"
        parent_en_uso[pid] = parent_en_uso.get(pid, False) or en_uso

    async with get_pg_session(tenant_id) as session:
        rows = (await session.execute(
            text("SELECT id, text FROM parent_chunks WHERE document_id = :d ORDER BY chunk_index"),
            {"d": str(document_id)},
        )).fetchall()

    partes = (
        _sin_prefijos_del_indexador(r[1] or "")
        for r in rows
        # Un parent sin fragmentos en Qdrant no debería existir; si aparece,
        # conservarlo es lo seguro (perder texto es peor que texto de más).
        if parent_en_uso.get(str(r[0]), True)
    )
    return "\n\n".join(t.strip() for t in partes if t.strip())


@router.post("/documents/{document_id}/reprocess", status_code=status.HTTP_202_ACCEPTED)
async def reprocess_document(
    document_id: uuid.UUID,
    request: Request,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Vuelve a procesar el documento PARTIENDO DE SU VERSIÓN VIGENTE.

    Existe para poder mejorar cómo se corta un documento (que es una necesidad
    real: un corte pobre da peores respuestas) sin perder las correcciones hechas
    a mano. Procesar de nuevo el archivo original las borraría — fue lo que pasó
    el 05/08/2026 y obligó a reconstruirlas desde un backup.

    El archivo original NO se toca: queda como estaba y se sigue pudiendo
    descargar. Además se guarda una copia del texto vigente en el almacenamiento,
    con fecha, para tener trazabilidad de con qué se reprocesó.
    """
    import io as _io
    import asyncio as _asyncio
    from datetime import datetime as _dt

    async with get_pg_session(tenant_id) as session:
        row = (await session.execute(
            text("SELECT title, filename, status, chunk_count FROM documentos WHERE id = :id"),
            {"id": document_id},
        )).mappings().fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Document not found")
    if row["status"] != "ready":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"El documento está en estado '{row['status']}'. Esperá a que termine de procesarse.",
        )

    texto = await _texto_vigente(str(document_id), tenant_id)
    if not texto.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="El documento no tiene partes en uso para reprocesar.",
        )

    # Copia con fecha del texto con el que se reprocesa. No pisa el original.
    sello = _dt.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    respaldo_key = f"{tenant_id}/{document_id}/vigente-{sello}.txt"
    datos = texto.encode("utf-8")
    try:
        def _guardar() -> None:
            get_minio_client().put_object(
                settings.minio_bucket, respaldo_key, _io.BytesIO(datos),
                length=len(datos), content_type="text/plain",
            )
        await _asyncio.to_thread(_guardar)
    except Exception as exc:
        logger.warning("reprocess_backup_failed document_id=%s error=%s", document_id, exc)

    _ensure_upload_dir()
    safe_name = re.sub(r"[^\w\-.]", "_", row["filename"] or "documento")[:200]
    file_path = os.path.join(_UPLOAD_DIR, f"{document_id}_reproceso_{sello}_{safe_name}")
    with open(file_path, "wb") as f:
        f.write(datos)

    async with get_pg_session(tenant_id) as session:
        await session.execute(
            text("UPDATE documentos SET status = 'processing' WHERE id = :id"),
            {"id": document_id},
        )

    from workers.ingest_tasks import process_document
    process_document.apply_async(
        args=[str(document_id), tenant_id, file_path, "text/plain", row["filename"] or safe_name],
        queue="ingest",
    )

    logger.info(
        "document_reprocess_enqueued document_id=%s tenant_id=%s chars=%d user=%s",
        document_id, tenant_id, len(texto), current_user.email,
    )
    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
        tenant_id=tenant_id,
        actor_id=current_user.user_id,
        actor_email=current_user.email,
        actor_role=current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role),
        action="documents.reprocess",
        resource=f"document:{document_id}",
        detail={"chars": len(texto), "chunks_previos": row["chunk_count"], "respaldo": respaldo_key},
        request=request,
    ))
    return {"status": "processing", "document_id": str(document_id), "chars": len(texto)}


@router.get("/documents/{document_id}/download/edited")
async def download_document_edited(
    document_id: uuid.UUID,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Descarga la versión vigente del documento: las partes tal como las usa el
    asistente hoy (con las ediciones del admin, sin las marcadas "sin usar").

    No reconstruye el formato original (un PDF no se rearma desde las partes) —
    siempre exporta texto plano.
    """
    from fastapi.responses import Response
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text("SELECT filename FROM documentos WHERE id = :id"),
            {"id": document_id},
        )
        row = result.mappings().fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Document not found")

    # Misma reconstrucción que usa el reproceso: una sola definición de "versión
    # vigente" para que la descarga y el reproceso nunca difieran.
    body = await _texto_vigente(str(document_id), tenant_id)
    if not body.strip():
        raise HTTPException(status_code=404, detail="El documento no tiene partes en uso para exportar")

    stem = (row["filename"] or "documento").rsplit(".", 1)[0]
    cd = f"attachment; filename=\"{stem} (editado).txt\""
    return Response(
        content=body.encode("utf-8"),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": cd},
    )



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
                # Editado a mano desde el panel: el archivo original NO tiene este
                # texto, así que se pierde si el documento se vuelve a procesar.
                "manually_edited": point.payload.get("manually_edited", False),
                "edited_by": point.payload.get("edited_by"),
                "edited_at": point.payload.get("edited_at"),
            }
            for point in results
        ],
        key=lambda c: c["chunk_index"],
    )
    return chunks


@router.get("/documents/{document_id}/manual-edits")
async def document_manual_edits(
    document_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Correcciones hechas a mano sobre este documento que NO están en el archivo.

    Se consulta antes de borrar o reemplazar un documento: esas correcciones viven
    solo en la base y se pierden al volver a procesar el archivo, que es lo que
    pasó el 05/08/2026 y obligó a reconstruirlas desde un backup.
    """
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
    editados = [
        {
            "chunk_id": str(p.id),
            "chunk_index": p.payload.get("chunk_index", 0),
            "edited_by": p.payload.get("edited_by"),
            "edited_at": p.payload.get("edited_at"),
            "preview": (p.payload.get("text") or "")[:180],
        }
        for p in results
        if p.payload.get("manually_edited")
    ]
    editados.sort(key=lambda c: c["chunk_index"])
    return {"count": len(editados), "edits": editados}


@router.get("/chunks/pending")
async def list_pending_chunks(
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Return chunks awaiting human review (quality_gate_status == 'pending').

    'pending' = la IA marcó el chunk como poco coherente, o Groq no pudo validarlo.
    En ambos casos el chunk está indexado y participa en la búsqueda con peso
    normal; acá el admin lo revisa para editar / aprobar / rechazar.

    Los 'skipped' se excluyen de esta cola: son los que el ADMIN ya rechazó
    explícitamente (decisión tomada), no algo pendiente de revisar.
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


class ChunkEditBody(BaseModel):
    """Editar el texto de un chunk. El backend re-embeddea automaticamente."""
    text: str


@router.patch("/documents/{document_id}/chunks/{chunk_id}")
async def edit_chunk_text(
    document_id: str,
    chunk_id: str,
    body: ChunkEditBody,
    request: Request,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """Editar el texto de un chunk desde el panel de Documentos.

    Pasos:
      1. Validar que el chunk existe y pertenece al documento
      2. Re-embeddear el nuevo texto via OpenAI ('passage:' prefix)
      3. Update Qdrant: payload.text + nuevo vector + audit fields
      4. Update parent_chunks.text si el chunk tiene parent_id
         (afecta BM25 search — buscar coherente con el contenido nuevo)

    Después de editar, el bot va a recuperar este chunk con el texto nuevo
    en busquedas semánticas y BM25.
    """
    new_text = body.text.strip()
    if not new_text:
        raise HTTPException(status_code=422, detail="Texto vacio")
    if len(new_text) > 8000:
        raise HTTPException(status_code=422, detail="Texto demasiado largo (max 8000 chars)")

    qdrant = get_qdrant_client()
    collection = f"{tenant_id}_docs"

    # 1. Validar pertenencia
    existing = await qdrant.retrieve(
        collection_name=collection,
        ids=[chunk_id],
        with_payload=True,
        with_vectors=False,
    )
    if not existing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chunk no encontrado")
    payload = existing[0].payload or {}
    if payload.get("document_id") != document_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="El chunk no pertenece a este documento")

    # 2. Re-embeddear
    from services.embeddings import aembed_text
    vector = await aembed_text(f"passage: {new_text}")
    if vector is None:
        raise HTTPException(status_code=502, detail="No se pudo re-embeddear el texto")

    # 3. Upsert Qdrant con payload merged + nuevo vector
    # El texto ANTERIOR se guarda para la auditoría: es lo único que se pierde si
    # el documento se reprocesa (incidente 2026-08-05, donde hubo que reconstruir
    # las correcciones desde un backup de PostgreSQL).
    old_text = payload.get("text") or ""
    payload["text"] = new_text
    payload["manually_edited"] = True
    payload["edited_by"] = current_user.email
    payload["edited_at"] = datetime.now(timezone.utc).isoformat()

    from qdrant_client.models import PointStruct
    await qdrant.upsert(
        collection_name=collection,
        points=[PointStruct(id=chunk_id, vector=vector, payload=payload)],
    )

    # 4. Update parent_chunks si aplica (afecta BM25 + small-to-big retrieval).
    #    Reemplazo PUNTUAL del fragmento dentro del parent: pisar el parent
    #    entero descartaba el resto de su contenido cuando tiene varios
    #    fragmentos (bug 2026-08-18; no explotó porque las ediciones históricas
    #    fueron todas en docs FAQ donde parent y fragmento coinciden 1:1).
    parent_id = payload.get("parent_id")
    parent_actualizado = False
    if parent_id:
        async with get_pg_session(tenant_id) as session:
            parent_text = (await session.execute(
                text("SELECT text FROM parent_chunks WHERE id = :pid AND document_id = :did"),
                {"pid": parent_id, "did": document_id},
            )).scalar()
            actualizado = (
                _parent_con_fragmento_editado(parent_text, old_text, new_text)
                if parent_text is not None else None
            )
            if actualizado is not None:
                await session.execute(
                    text("UPDATE parent_chunks SET text = :t WHERE id = :pid AND document_id = :did"),
                    {"t": actualizado, "pid": parent_id, "did": document_id},
                )
                parent_actualizado = True
            else:
                # No ubicamos el texto anterior dentro del parent (p.ej. una
                # edición previa ya lo había desincronizado). Dejar el parent
                # intacto: la búsqueda semántica ya usa el texto nuevo del
                # fragmento; perder contenido del parent sería peor.
                logger.warning(
                    "chunk_edit_parent_no_ubicado chunk_id=%s parent_id=%s document_id=%s: "
                    "el parent queda sin modificar",
                    chunk_id, parent_id, document_id,
                )

    # 5. Invalidar respuestas cacheadas del tenant. Sin esto, una respuesta vieja
    # cacheada antes de la edición (p.ej. "no encontré ese dato") se seguiría
    # sirviendo hasta el TTL aunque el chunk ya tenga el contenido nuevo. Igual
    # que hace la ingesta de documentos tras indexar.
    try:
        from core.database import get_redis_cache
        _redis = get_redis_cache()
        _cursor = 0
        while True:
            _cursor, _keys = await _redis.scan(_cursor, match=f"{tenant_id}:cache:*", count=200)
            if _keys:
                await _redis.delete(*_keys)
            if _cursor == 0:
                break
    except Exception as _exc:
        logger.warning("chunk_edit_cache_invalidation_failed tenant_id=%s error=%s", tenant_id, _exc)

    logger.info(
        "chunk_text_edited document_id=%s chunk_id=%s parent_id=%s len=%d user=%s",
        document_id, chunk_id, parent_id, len(new_text), current_user.email,
    )

    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
        tenant_id=tenant_id,
        actor_id=current_user.user_id,
        actor_email=current_user.email,
        actor_role=current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role),
        action="documents.chunk_text_edited",
        resource=f"document:{document_id}/chunk:{chunk_id}",
        # Guardamos AMBOS textos, no solo el largo: la auditoría es la única copia
        # de una corrección manual hasta que el archivo original se actualiza.
        detail={
            "len": len(new_text),
            "parent_updated": parent_actualizado,
            "text_before": old_text[:8000],
            "text_after": new_text[:8000],
        },
        request=request,
    ))

    return {
        "chunk_id": chunk_id,
        "document_id": document_id,
        "text": new_text,
        "parent_id": parent_id,
    }


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

    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
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
    current_user: CurrentUser = Depends(require_admin),
):
    """Delete a document and all associated data: PG record, Qdrant chunks, parent_chunks, MinIO file."""
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

    # Borramos primero los stores externos y SOLO si los críticos (Qdrant, MinIO)
    # salieron bien tocamos PostgreSQL. Así, ante un fallo, NO dejamos huérfanos
    # silenciosos (chunks que el bot sigue recuperando / archivo original con PII)
    # con el registro PG ya borrado e irrecuperable desde el panel: el documento
    # se conserva y el borrado se puede reintentar.
    critical_failures: list[str] = []

    # 2. Delete Qdrant chunks (crítico: los huérfanos quedan buscables)
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
        critical_failures.append("qdrant")

    # 3. Delete original file from MinIO (crítico: archivo original con PII)
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
            critical_failures.append("minio")

    # Si falló un store crítico, NO borramos el registro PG: conservamos el
    # documento para poder reintentar el borrado, en vez de devolver un 204 que
    # oculta huérfanos buscables / con PII.
    if critical_failures:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=(
                f"No se pudo completar el borrado ({', '.join(critical_failures)}). "
                "El documento se conserva — reintentá en un momento."
            ),
        )

    # 5. PostgreSQL: parent_chunks (BM25) + pares de duplicados + registro del
    # documento, en una sola transacción. Sin limpiar chunk_duplicate_pairs, los
    # pares que referencian este documento quedan huérfanos y el panel de
    # duplicados los sigue mostrando aunque sus chunks ya no existan (bug 05/06).
    async with get_pg_session(tenant_id) as session:
        await session.execute(
            text("DELETE FROM parent_chunks WHERE document_id = :id"), {"id": document_id}
        )
        # Solo los PENDIENTES. Los pares ya resueltos se conservan como memoria de
        # la decisión del admin: si se borran, al volver a subir el documento la
        # detección los recrea como pendientes y el admin tiene que resolverlos de
        # nuevo, una y otra vez (reporte del cliente, 10/08/2026).
        await session.execute(
            text(
                "DELETE FROM chunk_duplicate_pairs "
                "WHERE (doc_id_a = :id OR doc_id_b = :id) AND status = 'pending'"
            ),
            {"id": document_id},
        )
        await session.execute(
            text("DELETE FROM documentos WHERE id = :id"), {"id": document_id}
        )

    logger.info("document_deleted document_id=%s tenant_id=%s user=%s", document_id, tenant_id, current_user.user_id)

    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
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

# MIME types reales que libmagic reporta sobre el contenido. python-magic mira
# magic numbers en los primeros bytes — un .exe renombrado a .pdf NO va a pasar.
# DOCX es un zip por dentro: libmagic reporta application/zip o el subtype OOXML
# segun la version. Aceptamos ambos y revalidamos el extension below.
ALLOWED_REAL_MIME_TYPES = {
    "application/pdf",
    "text/plain",
    "text/html",
    "application/json",
    "application/zip",  # DOCX detectado como zip
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/x-empty",  # se rechaza arriba por len(content)==0
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
            detail=f"Tipo de archivo no soportado: {file.content_type}. Use PDF, DOCX, TXT, HTML o JSON.",
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
            detail=f"El archivo supera el máximo de {_MAX_FILE_BYTES // (1024*1024)} MB.",
        )

    # ── Validar MIME real con libmagic ────────────────────────────────────────
    # file.content_type viene del cliente y es trivial de spoofear: cualquier
    # script puede mandar Content-Type: application/pdf sobre un .exe. libmagic
    # mira los magic bytes del contenido real — si el archivo no tiene la
    # signature de pdf/docx/etc, lo rechazamos antes de tocar Qdrant/Celery.
    try:
        import magic
        real_mime = magic.from_buffer(content[:8192], mime=True)
    except Exception as exc:
        # Si libmagic no esta disponible (dev sin libmagic1), no bloqueamos
        # el upload — solo loguamos. En produccion el Dockerfile lo instala.
        logger.warning("magic_unavailable_skipping_check error=%s", exc)
        real_mime = None

    if real_mime is not None and real_mime not in ALLOWED_REAL_MIME_TYPES:
        logger.warning(
            "ingest_mime_spoof_detected tenant=%s filename=%s declared=%s real=%s",
            tenant_id, file.filename, mime_type, real_mime,
        )
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=(
                f"El archivo no tiene el contenido esperado (detectado: {real_mime}). "
                "Solo aceptamos PDF, DOCX, TXT, HTML o JSON."
            ),
        )

    # ── JSON: validar el parseo en el upload ──────────────────────────────────
    # Un JSON roto NO se rechazaba: caía al fallback "texto plano" del extractor
    # y la sintaxis cruda se indexaba en silencio (basura en la KB que el bot
    # puede citar). Mejor rebotarlo acá con la ubicación del error para que el
    # admin lo corrija. Solo JSON: es el único formato parseable barato y completo.
    if mime_type == "application/json":
        import asyncio as _aio
        import json as _json
        try:
            await _aio.to_thread(_json.loads, content.decode("utf-8", errors="replace"))
        except _json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"El archivo no es un JSON válido (error en línea {exc.lineno}, "
                    f"columna {exc.colno}). Corregilo y volvé a subirlo."
                ),
            )

    # Plan limit: document count + per-file size cap
    from core.plan_limits import enforce_document_limit
    await enforce_document_limit(tenant_id, len(content))

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
        # Un intento anterior que quedó en 'failed' con el MISMO contenido (hash)
        # bloquearía re-subir el archivo corregido por el UNIQUE de hash_bytes; lo
        # borramos antes de los checks. SOLO por contenido (hash), NO por filename:
        # el 'OR filename' borraba cualquier 'failed' que compartiera nombre aunque
        # fuera contenido DISTINTO (pérdida de datos). Los 'failed' sin hash tienen
        # hash NULL → no colisionan con el UNIQUE, así que no hace falta limpiarlos.
        await session.execute(text("""
            DELETE FROM documentos
            WHERE status = 'failed'
              AND (content_hash_bytes = :hb OR content_hash_text = :ht)
        """), {"hb": hash_bytes, "ht": hash_text})

        # ── Check 1: mismo filename pero contenido distinto ──────────────────
        # Si bytes coinciden tambien → se ignora aca, el ON CONFLICT abajo
        # lo va a marcar como exact_bytes (mas preciso).
        filename_dup_result = await session.execute(
            text(
                "SELECT id, title, filename, created_at FROM documentos "
                "WHERE filename = :fn AND content_hash_bytes != :hb LIMIT 1"
            ),
            {"fn": file.filename, "hb": hash_bytes},
        )
        filename_dup_row = filename_dup_result.mappings().fetchone()
        if filename_dup_row is not None:
            logger.info(
                "ingest_filename_duplicate tenant_id=%s existing_id=%s filename=%s",
                tenant_id, filename_dup_row["id"], file.filename,
            )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "detail": "Documento duplicado",
                    "duplicate_of": {
                        "id": str(filename_dup_row["id"]),
                        "title": filename_dup_row["title"],
                        "filename": filename_dup_row["filename"],
                        "created_at": (
                            filename_dup_row["created_at"].isoformat()
                            if isinstance(filename_dup_row["created_at"], datetime)
                            else str(filename_dup_row["created_at"])
                        ),
                    },
                    "match_type": "filename",
                },
            )

        # ── Check 2: mismo contenido de texto pero bytes y filename distintos ──
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
                "ON CONFLICT DO NOTHING "  # cubre hash_bytes Y hash_text (evita 500 por TOCTOU)
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

    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
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
