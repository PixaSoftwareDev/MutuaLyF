"""Entity graph endpoints — exposes Neo4j entity data to the admin panel.

Endpoints:
  GET /entities          — list all entities for the tenant (filterable by type)
  GET /entities/{label}/{name} — detail: chunks and documents where entity appears
  GET /entities/stats    — counts by entity type
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

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


class EntityDetail(BaseModel):
    nombre: str
    label: str
    chunks: list[EntityChunk]


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
    except Exception:
        pass

    chunks = [
        EntityChunk(
            chunk_id=r["chunk_id"],
            doc_id=r["doc_id"],
            doc_filename=doc_filenames.get(r["doc_id"]),
        )
        for r in rows
    ]

    return EntityDetail(nombre=nombre, label=label, chunks=chunks)
