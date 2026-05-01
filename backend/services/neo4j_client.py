"""Neo4j client with circuit breaker and MERGE-based entity writing.

Rules enforced here (per CLAUDE.md):
1. MERGE, never CREATE for entities.
2. MENCIONADA_EN edge from entity to chunk_id.
3. Circuit breaker: fallback to PG if Neo4j times out.
"""

import asyncio
import logging
from collections import defaultdict
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_fixed,
)

from neo4j import AsyncDriver

from core.config import settings
from core.database import get_neo4j_driver
from services.nlu import Entity

# Whitelist of allowed Neo4j node labels — prevents Cypher injection from GLiNER output
_ALLOWED_LABELS = frozenset({
    "Persona", "Rol", "Departamento", "Horario",
    "Dominio", "Organizacion", "Fecha", "Lugar",
})


def _safe_label(raw: str) -> str:
    """Map a GLiNER entity label to a whitelisted Neo4j node label."""
    capitalized = raw.strip().capitalize()
    return capitalized if capitalized in _ALLOWED_LABELS else "Entidad"

logger = logging.getLogger(__name__)


class Neo4jCircuitOpen(Exception):
    """Raised when the Neo4j circuit breaker is open (too many recent failures)."""


_circuit_failure_count = 0
_CIRCUIT_THRESHOLD = 3


def _record_neo4j_failure() -> None:
    global _circuit_failure_count
    _circuit_failure_count += 1
    logger.warning("neo4j_failure_count count=%d threshold=%d", _circuit_failure_count, _CIRCUIT_THRESHOLD)


def _reset_circuit() -> None:
    global _circuit_failure_count
    _circuit_failure_count = 0


def _circuit_is_open() -> bool:
    return _circuit_failure_count >= _CIRCUIT_THRESHOLD


@asynccontextmanager
async def _neo4j_session(
    tenant_id: str,
    *,
    driver: AsyncDriver | None = None,
) -> AsyncGenerator:
    """Open a Neo4j session for the given tenant's database, with circuit breaker.

    Args:
        driver: Pass a fresh driver from get_worker_neo4j_driver() in Celery tasks.
                Omit (None) in the FastAPI context to use the module-level singleton.
    """
    if _circuit_is_open():
        logger.warning("neo4j_circuit_open tenant_id=%s using_fallback", tenant_id)
        raise Neo4jCircuitOpen("Neo4j circuit breaker is open")

    # Enterprise: one database per tenant (full schema isolation).
    # Community: single "neo4j" database with tenant_id on every node.
    database = tenant_id if settings.neo4j_multidatabase else "neo4j"

    _driver = driver or get_neo4j_driver()
    try:
        async with _driver.session(database=database) as session:
            yield session
        _reset_circuit()
    except asyncio.TimeoutError:
        _record_neo4j_failure()
        raise
    except Exception as exc:
        _record_neo4j_failure()
        logger.error("neo4j_session_error tenant_id=%s error=%s", tenant_id, exc)
        raise


async def write_entities_for_chunk(
    tenant_id: str,
    chunk_id: str,
    document_id: str,
    entities: list[Entity],
    *,
    driver: AsyncDriver | None = None,
) -> bool:
    """Write entities to Neo4j with MERGE to avoid duplicates.

    Uses MERGE on (nombre_normalizado, tenant_id) as the uniqueness key.
    Creates MENCIONADA_EN edges from each entity to the chunk.
    Returns True on success, False on Neo4j failure (caller should log and continue).

    Args:
        driver: Pass a fresh driver from get_worker_neo4j_driver() in Celery tasks.
    """
    if not entities:
        return True

    try:
        async with asyncio.timeout(settings.neo4j_timeout_ms / 1000):
            async with _neo4j_session(tenant_id, driver=driver) as session:
                # Group entities by label → one UNWIND query per label instead of N round trips
                by_label: dict[str, list[dict]] = defaultdict(list)
                for e in entities:
                    by_label[_safe_label(e.label)].append({
                        "nombre_normalizado": e.text.strip().lower(),
                        "nombre": e.text,
                    })

                for label, label_entities in by_label.items():
                    # label is whitelisted — safe to interpolate
                    await session.run(
                        f"""
                        UNWIND $entities AS entity
                        MERGE (e:{label} {{nombre_normalizado: entity.nombre_normalizado, tenant_id: $tenant_id}})
                        ON CREATE SET e.nombre = entity.nombre, e.created_at = datetime()
                        MERGE (c:Chunk {{id: $chunk_id, tenant_id: $tenant_id}})
                        ON CREATE SET c.created_at = datetime()
                        MERGE (e)-[:MENCIONADA_EN]->(c)
                        MERGE (doc:Documento {{id: $doc_id, tenant_id: $tenant_id}})
                        MERGE (c)-[:PERTENECE_A]->(doc)
                        """,
                        entities=label_entities,
                        tenant_id=tenant_id,
                        chunk_id=chunk_id,
                        doc_id=document_id,
                    )

        logger.debug(
            "neo4j_entities_written chunk_id=%s entity_count=%d",
            chunk_id, len(entities),
        )
        return True

    except (Neo4jCircuitOpen, asyncio.TimeoutError) as exc:
        logger.warning(
            "neo4j_write_skipped chunk_id=%s reason=%s",
            chunk_id, type(exc).__name__,
        )
        return False
    except Exception as exc:
        logger.error("neo4j_write_failed chunk_id=%s error=%s", chunk_id, exc)
        return False


async def query_entities(
    tenant_id: str,
    entity_names: list[str],
    limit: int = 20,
) -> list[dict]:
    """Retrieve chunks related to a list of entity names from Neo4j.

    Called by the orchestrator when the query contains named entities.
    Falls back to empty list on circuit open or timeout.
    """
    if not entity_names or _circuit_is_open():
        return []

    try:
        async with asyncio.timeout(settings.neo4j_timeout_ms / 1000):
            async with _neo4j_session(tenant_id) as session:
                normalized = [name.strip().lower() for name in entity_names]
                result = await session.run(
                    """
                    MATCH (e)-[:MENCIONADA_EN]->(c:Chunk {tenant_id: $tenant_id})
                    WHERE e.nombre_normalizado IN $names AND e.tenant_id = $tenant_id
                    MATCH (c)-[:PERTENECE_A]->(doc:Documento)
                    RETURN c.id AS chunk_id, doc.id AS doc_id, collect(DISTINCT e.nombre) AS entities
                    LIMIT $limit
                    """,
                    tenant_id=tenant_id,
                    names=normalized,
                    limit=limit,
                )
                records = await result.data()
                logger.debug("neo4j_query_done tenant_id=%s results=%d", tenant_id, len(records))
                return records

    except (Neo4jCircuitOpen, asyncio.TimeoutError):
        logger.warning("neo4j_query_timeout_fallback tenant_id=%s", tenant_id)
        return []
    except Exception as exc:
        logger.error("neo4j_query_failed tenant_id=%s error=%s", tenant_id, exc)
        return []
