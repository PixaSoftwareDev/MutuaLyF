"""Entity graph endpoints — exposes Neo4j entity data to the admin panel.

Endpoints:
  GET /entities          — list all entities for the tenant (filterable by type)
  GET /entities/{label}/{name} — detail: chunks and documents where entity appears
  GET /entities/stats    — counts by entity type
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from core.database import get_pg_session
from core.security import require_admin
from core.tenant import get_tenant_id
from services.neo4j_client import _neo4j_session, _circuit_is_open

logger = logging.getLogger(__name__)
router = APIRouter()

EntityLabel = Literal["Persona", "Rol", "Departamento", "Horario", "Dominio", "Organizacion", "Fecha", "Lugar", "Entidad"]


# ── Schemas ───────────────────────────────────────────────────────────────────

class EntitySummary(BaseModel):
    nombre: str
    nombre_normalizado: str
    label: str
    mention_count: int
    created_at: str | None


class EntityChunk(BaseModel):
    chunk_id: str
    doc_id: str
    doc_filename: str | None
    # Texto del chunk para que el admin vea el contexto donde se menciona la
    # entidad. Truncado a max_chunk_text_chars en la respuesta para evitar
    # payloads pesados — el modal lo expande on-demand si el admin quiere.
    text: str | None = None


class EntityDetail(BaseModel):
    nombre: str
    label: str
    chunks: list[EntityChunk]


class EntityUpdate(BaseModel):
    new_nombre: str | None = Field(default=None, min_length=1, max_length=200)
    new_label: EntityLabel | None = None


class EntityStats(BaseModel):
    label: str
    count: int


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/entities/stats", response_model=list[EntityStats])
async def get_entity_stats(
    tenant_id: str = Depends(get_tenant_id),
    _user=Depends(require_admin),
):
    """Count of entities grouped by type."""
    if _circuit_is_open():
        raise HTTPException(status_code=503, detail="Neo4j no disponible")

    labels = ["Persona", "Rol", "Departamento", "Horario", "Dominio", "Organizacion", "Fecha", "Lugar", "Entidad"]
    results: list[EntityStats] = []

    try:
        async with _neo4j_session(tenant_id) as session:
            for label in labels:
                record = await session.run(
                    f"MATCH (e:{label} {{tenant_id: $tid}}) RETURN count(e) AS cnt",
                    tid=tenant_id,
                )
                data = await record.data()
                count = data[0]["cnt"] if data else 0
                if count > 0:
                    results.append(EntityStats(label=label, count=count))
    except Exception as exc:
        logger.error("entity_stats_failed tenant_id=%s error=%s", tenant_id, exc)
        raise HTTPException(status_code=503, detail="Error consultando Neo4j")

    return sorted(results, key=lambda x: x.count, reverse=True)


@router.get("/entities", response_model=list[EntitySummary])
async def list_entities(
    label: EntityLabel | None = Query(None, description="Filtrar por tipo"),
    search: str | None = Query(None, description="Buscar por nombre"),
    limit: int = Query(100, ge=1, le=500),
    tenant_id: str = Depends(get_tenant_id),
    _user=Depends(require_admin),
):
    """List all entities for this tenant, optionally filtered by type or name."""
    if _circuit_is_open():
        raise HTTPException(status_code=503, detail="Neo4j no disponible")

    # Filter to entity labels only — exclude Chunk/Documento structural nodes
    _ENTITY_LABELS = ["Persona", "Rol", "Departamento", "Horario", "Dominio", "Organizacion", "Fecha", "Lugar", "Entidad"]
    label_filter = f":{label}" if label else (":" + "|".join(_ENTITY_LABELS))
    name_filter = "AND toLower(e.nombre) CONTAINS toLower($search)" if search else ""

    cypher = f"""
        MATCH (e{label_filter} {{tenant_id: $tid}})
        WHERE e.nombre IS NOT NULL {name_filter}
        OPTIONAL MATCH (e)-[:MENCIONADA_EN]->(c:Chunk {{tenant_id: $tid}})
        WITH
            labels(e)[0]              AS label,
            e.nombre_normalizado      AS nombre_normalizado,
            min(e.nombre)             AS nombre,
            max(e.created_at)         AS created_at,
            count(DISTINCT c)         AS mention_count
        RETURN label, nombre_normalizado, nombre, created_at, mention_count
        ORDER BY mention_count DESC, nombre
        LIMIT $limit
    """

    try:
        async with _neo4j_session(tenant_id) as session:
            result = await session.run(
                cypher,
                tid=tenant_id,
                search=search or "",
                limit=limit,
            )
            rows = await result.data()
    except Exception as exc:
        logger.error("entity_list_failed tenant_id=%s error=%s", tenant_id, exc)
        raise HTTPException(status_code=503, detail="Error consultando Neo4j")

    return [
        EntitySummary(
            nombre=r["nombre"],
            nombre_normalizado=r["nombre_normalizado"] or "",
            label=r["label"],
            mention_count=r["mention_count"],
            created_at=str(r["created_at"]) if r["created_at"] else None,
        )
        for r in rows
    ]


@router.get("/entities/{label}/{nombre}", response_model=EntityDetail)
async def get_entity_detail(
    label: EntityLabel,
    nombre: str,
    tenant_id: str = Depends(get_tenant_id),
    _user=Depends(require_admin),
):
    """Get all chunks and documents where a specific entity appears."""
    if _circuit_is_open():
        raise HTTPException(status_code=503, detail="Neo4j no disponible")

    # Fetch chunks linked to this entity via Neo4j
    cypher = f"""
        MATCH (e:{label} {{tenant_id: $tid}})
        WHERE toLower(e.nombre) = toLower($nombre)
           OR e.nombre_normalizado = toLower($nombre)
        MATCH (e)-[:MENCIONADA_EN]->(c:Chunk {{tenant_id: $tid}})
        MATCH (c)-[:PERTENECE_A]->(doc:Documento {{tenant_id: $tid}})
        RETURN DISTINCT c.id AS chunk_id, doc.id AS doc_id
        LIMIT 50
    """

    try:
        async with _neo4j_session(tenant_id) as session:
            result = await session.run(cypher, tid=tenant_id, nombre=nombre)
            rows = await result.data()
    except Exception as exc:
        logger.error("entity_detail_failed tenant_id=%s nombre=%s error=%s", tenant_id, nombre, exc)
        raise HTTPException(status_code=503, detail="Error consultando Neo4j")

    if not rows:
        raise HTTPException(status_code=404, detail="Entidad no encontrada")

    # Enrich with document filenames from Qdrant payload
    chunk_ids = [r["chunk_id"] for r in rows]
    doc_filenames: dict[str, str] = {}
    chunk_texts: dict[str, str] = {}
    parent_ids: dict[str, str | None] = {}
    try:
        from core.database import get_qdrant_client
        qdrant = get_qdrant_client()
        points = await qdrant.retrieve(
            collection_name=f"{tenant_id}_docs",
            ids=chunk_ids,
            with_payload=True,
        )
        for p in points:
            doc_id = p.payload.get("document_id", "")
            filename = p.payload.get("filename") or p.payload.get("original_filename") or None
            if doc_id and filename:
                doc_filenames[doc_id] = filename
            # text del child chunk (~150 palabras). Si existe parent_id, abajo
            # reemplazamos por el texto del parent (mejor contexto).
            chunk_texts[str(p.id)] = (p.payload.get("text") or "").strip()
            parent_ids[str(p.id)] = p.payload.get("parent_id")
    except Exception as exc:
        logger.warning("qdrant_lookup_failed_in_entity_detail tenant=%s error=%s", tenant_id, exc)

    # Para chunks con parent_id, traer el texto del parent (mejor que el child
    # de ~150 palabras para mostrar contexto en UI). Una sola query batch.
    parent_id_list = [pid for pid in parent_ids.values() if pid]
    if parent_id_list:
        try:
            from sqlalchemy import text as sa_text
            async with get_pg_session(tenant_id) as pg_session:
                parent_result = await pg_session.execute(
                    sa_text("SELECT id, text FROM parent_chunks WHERE id = ANY(:ids)"),
                    {"ids": parent_id_list},
                )
                parent_texts = {row["id"]: row["text"] for row in parent_result.mappings().all()}
            for cid, pid in parent_ids.items():
                if pid and pid in parent_texts:
                    chunk_texts[cid] = parent_texts[pid].strip()
        except Exception as exc:
            logger.warning("parent_chunks_lookup_failed tenant=%s error=%s", tenant_id, exc)

    chunks = [
        EntityChunk(
            chunk_id=r["chunk_id"],
            doc_id=r["doc_id"],
            doc_filename=doc_filenames.get(r["doc_id"]),
            text=chunk_texts.get(r["chunk_id"]) or None,
        )
        for r in rows
    ]

    return EntityDetail(nombre=nombre, label=label, chunks=chunks)


# ── Edicion manual de entidades ──────────────────────────────────────────────


@router.patch("/entities/{label}/{nombre}", status_code=status.HTTP_200_OK)
async def update_entity(
    label: EntityLabel,
    nombre: str,
    body: EntityUpdate,
    tenant_id: str = Depends(get_tenant_id),
    _user=Depends(require_admin),
):
    """Renombrar y/o cambiar el tipo (label) de una entidad detectada por GLiNER.

    Si new_label != label original, hay que crear un nodo del nuevo label,
    re-conectar todas las aristas (MENCIONADA_EN), y borrar el viejo nodo.
    Si solo cambia el nombre, basta con un SET.
    """
    if _circuit_is_open():
        raise HTTPException(status_code=503, detail="Neo4j no disponible")
    if body.new_nombre is None and body.new_label is None:
        raise HTTPException(status_code=400, detail="Nada para actualizar")

    new_nombre = (body.new_nombre or nombre).strip()
    new_label = body.new_label or label
    new_normalizado = new_nombre.lower()

    try:
        async with _neo4j_session(tenant_id) as session:
            # Verificar que la entidad existe
            check_cypher = (
                f"MATCH (e:{label} {{tenant_id: $tid}}) "
                "WHERE toLower(e.nombre) = toLower($nombre) "
                "   OR e.nombre_normalizado = toLower($nombre) "
                "RETURN e LIMIT 1"
            )
            r = await session.run(check_cypher, tid=tenant_id, nombre=nombre)
            check_data = await r.data()
            if not check_data:
                raise HTTPException(status_code=404, detail="Entidad no encontrada")

            if new_label == label:
                # Solo rename — SET propiedades
                rename_cypher = (
                    f"MATCH (e:{label} {{tenant_id: $tid}}) "
                    "WHERE toLower(e.nombre) = toLower($nombre) "
                    "   OR e.nombre_normalizado = toLower($nombre) "
                    "SET e.nombre = $new_nombre, e.nombre_normalizado = $new_normalizado "
                    "RETURN e.nombre AS nombre"
                )
                await session.run(
                    rename_cypher,
                    tid=tenant_id, nombre=nombre,
                    new_nombre=new_nombre, new_normalizado=new_normalizado,
                )
            else:
                # Cambio de label: re-crear nodo con nuevo label, reconectar
                # aristas MENCIONADA_EN, borrar viejo.
                migrate_cypher = (
                    f"MATCH (old:{label} {{tenant_id: $tid}}) "
                    "WHERE toLower(old.nombre) = toLower($nombre) "
                    "   OR old.nombre_normalizado = toLower($nombre) "
                    f"MERGE (newe:{new_label} {{nombre: $new_nombre, tenant_id: $tid}}) "
                    "ON CREATE SET newe.nombre_normalizado = $new_normalizado "
                    "ON MATCH SET  newe.nombre_normalizado = $new_normalizado "
                    "WITH old, newe "
                    "MATCH (old)-[r:MENCIONADA_EN]->(c) "
                    "MERGE (newe)-[:MENCIONADA_EN]->(c) "
                    "DELETE r "
                    "WITH old, newe "
                    "DETACH DELETE old "
                    "RETURN newe.nombre AS nombre"
                )
                await session.run(
                    migrate_cypher,
                    tid=tenant_id, nombre=nombre,
                    new_nombre=new_nombre, new_normalizado=new_normalizado,
                )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("update_entity_failed tenant=%s nombre=%s error=%s", tenant_id, nombre, exc)
        raise HTTPException(status_code=503, detail="Error actualizando entidad")

    logger.info(
        "entity_updated tenant=%s from=(%s,%s) to=(%s,%s)",
        tenant_id, label, nombre, new_label, new_nombre,
    )
    return {"nombre": new_nombre, "label": new_label}


@router.delete("/entities/{label}/{nombre}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_entity(
    label: EntityLabel,
    nombre: str,
    tenant_id: str = Depends(get_tenant_id),
    _user=Depends(require_admin),
):
    """Eliminar una entidad detectada por GLiNER que el admin considera incorrecta.

    Borra el nodo de Neo4j + todas sus aristas (DETACH DELETE).
    Los chunks asociados NO se borran — siguen en Qdrant, solo se desvincula
    la entidad. El texto del documento queda intacto.
    """
    if _circuit_is_open():
        raise HTTPException(status_code=503, detail="Neo4j no disponible")

    try:
        async with _neo4j_session(tenant_id) as session:
            result = await session.run(
                f"MATCH (e:{label} {{tenant_id: $tid}}) "
                "WHERE toLower(e.nombre) = toLower($nombre) "
                "   OR e.nombre_normalizado = toLower($nombre) "
                "WITH e, count(e) AS n "
                "DETACH DELETE e "
                "RETURN n",
                tid=tenant_id, nombre=nombre,
            )
            data = await result.data()
            deleted = data[0]["n"] if data else 0
    except Exception as exc:
        logger.error("delete_entity_failed tenant=%s nombre=%s error=%s", tenant_id, nombre, exc)
        raise HTTPException(status_code=503, detail="Error eliminando entidad")

    if deleted == 0:
        raise HTTPException(status_code=404, detail="Entidad no encontrada")

    logger.info("entity_deleted tenant=%s label=%s nombre=%s", tenant_id, label, nombre)
    return None
