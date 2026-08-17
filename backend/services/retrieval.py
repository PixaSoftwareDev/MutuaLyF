"""RAG retrieval: embed query → Qdrant search → rerank → return top-k chunks.

Etapa 3 improvements:
  - Independent timeouts per source (Qdrant, reranker)
  - doc_type-aware result filtering (skipped chunks from non-autonomous filtering)
  - Tracing spans for each retrieval stage
  - Parallel embedding + metadata enrichment
"""

import asyncio
import logging
import re
from dataclasses import dataclass
from functools import lru_cache

import httpx
from qdrant_client.models import ScoredPoint

from sqlalchemy import text

from core.config import settings
from core.database import get_pg_session, get_qdrant_client, get_redis_cache
from services.embedding_cache import embed_query_cached

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# PyTorch threading config — aplica a cualquier modelo torch cargado en el
# proceso (embeddings locales). 4 workers uvicorn con cgroup limit 12 CPUs →
# ~3 threads por worker para no oversubscribir (24 threads en 12 cores =
# context switching que mata performance).
# ─────────────────────────────────────────────────────────────────────────────
try:
    import torch as _torch
    _torch.set_num_threads(3)
    try:
        _torch.set_num_interop_threads(1)
    except RuntimeError:
        # Solo se puede setear UNA vez, antes de cualquier op.
        # Si otro modulo ya hizo torch ops, queda con el default.
        pass
    logger.info(
        "torch_threads_configured intra=%d interop=%d",
        _torch.get_num_threads(),
        _torch.get_num_interop_threads(),
    )
except ImportError:
    pass

# RERANKER ELIMINADO (2026-07-23, F3 del plan de calidad): el cross-encoder
# local/TEI nunca funcionó para español (bge-reranker-base es zh/en — probado
# A/B: 0.996 en inglés, 0.0 en TODO español) y llevaba apagado desde junio.
# Su función (¿los chunks RESPONDEN la pregunta?) la cumple el trust gate
# (services/trust_gate.py: capa léxica + juez LLM selectivo), validado por la
# suite de calidad (scripts/run_quality_suite.py). Los chunks se ordenan por
# el score de la fusión Qdrant+BM25.

# Per-source timeout
_QDRANT_TIMEOUT_S = settings.db_timeout_ms / 1000       # default 500ms

@dataclass
class RetrievedChunk:
    chunk_id:            str
    document_id:         str
    text:                str           # parent text after expansion; child text for legacy flat chunks
    score:               float
    quality_gate_status: str
    metadata:            dict
    parent_id:           str | None = None  # None for legacy flat chunks

    @property
    def doc_type(self) -> str:
        return self.metadata.get("doc_type", "unknown")

    @property
    def strategy(self) -> str:
        return self.metadata.get("strategy", "fixed")

async def retrieve_multi_query(
    queries: list[str],
    tenant_id: str,
    top_k: int = settings.retrieval_top_k,
    rerank_top_k: int = settings.rerank_top_k,
) -> list[RetrievedChunk]:
    """Multi-query retrieval con RRF fusion.

    Patrón estándar de RAG moderno (LangChain MultiQueryRetriever): dado N
    reformulaciones del query (main + variants del query rewriter), hace
    retrieval con cada una en PARALELO y fusiona los resultados con
    Reciprocal Rank Fusion para priorizar chunks que aparecen relevantes
    en múltiples variantes.

    Latencia: en paralelo via asyncio.gather, TEI/OpenAI hacen batching
    natural cuando llegan requests simultáneos → costo ~= 1 retrieve solo.

    Si solo hay 1 query → delega directo a retrieve() (sin overhead RRF).
    Si gather falla parcialmente → usa las queries que sí retornaron.
    """
    queries = [q.strip() for q in queries if q and q.strip()]
    if not queries:
        return []
    if len(queries) == 1:
        return await retrieve(queries[0], tenant_id, top_k=top_k, rerank_top_k=rerank_top_k)

    # Cada sub-query traemos un top_k chico — el RRF final selecciona
    # los mejores entre todas. Un poco de overlap para que el merge tenga
    # señal de "este chunk apareció en N queries".
    sub_top_k = max(top_k // len(queries) + 10, 20)
    sub_rerank = max(rerank_top_k // len(queries) + 5, 10)

    # Paralelo — asyncio.gather los corre todos al toque. TEI/OpenAI ven
    # batch concurrente y procesan eficiente.
    sub_results = await asyncio.gather(
        *(retrieve(q, tenant_id, top_k=sub_top_k, rerank_top_k=sub_rerank) for q in queries),
        return_exceptions=True,
    )

    # Filtrar excepciones — si una sub-query falla, sigo con las otras
    valid_lists: list[list[RetrievedChunk]] = []
    for idx, r in enumerate(sub_results):
        if isinstance(r, Exception):
            logger.warning("retrieve_multi_subquery_failed idx=%d query=%r error=%s",
                           idx, queries[idx][:60], r)
            continue
        valid_lists.append(r)

    if not valid_lists:
        logger.error("retrieve_multi_all_failed queries=%d", len(queries))
        return []

    # RRF fusion entre los N rankings: SELECCIONA los mejores candidatos entre
    # las variantes. Su score (~1/60 ≈ 0.016-0.05) queda en escala RRF — el
    # orquestador lo maneja con max(score, _cosine_score) al filtrar por
    # min_score (parche defendido por la suite: sin él, listados/enumeraciones
    # caían a falsos "no encontré").
    fused = _rrf_fuse_lists(valid_lists, top_k=max(rerank_top_k, 20))
    return fused[:rerank_top_k]

def _rrf_fuse_lists(
    rankings: list[list[RetrievedChunk]],
    top_k: int,
    k: int | None = None,
) -> list[RetrievedChunk]:
    """RRF entre N rankings independientes (uno por query variant).

    Score final de un chunk = Σ 1/(k + rank_en_lista_i) sobre todas las listas
    donde aparece. Chunks que aparecen en más listas se priorizan.
    """
    if k is None:
        k = settings.rrf_k
    fused_scores: dict[str, float] = {}
    chunk_by_id: dict[str, RetrievedChunk] = {}
    for ranking in rankings:
        for rank, chunk in enumerate(ranking):
            # Identidad del chunk: parent_id si tiene, sino chunk_id
            key = chunk.parent_id or chunk.chunk_id
            score = 1.0 / (k + rank + 1)
            fused_scores[key] = fused_scores.get(key, 0.0) + score
            # Mantener la primera ocurrencia del chunk (con su texto/metadata)
            if key not in chunk_by_id:
                chunk_by_id[key] = chunk

    # Aplicar score RRF y ordenar
    for key, score in fused_scores.items():
        chunk_by_id[key].score = score
    sorted_chunks = sorted(chunk_by_id.values(), key=lambda c: c.score, reverse=True)
    return sorted_chunks[:top_k]


def fuse_rankings(
    rankings: list[list[RetrievedChunk]],
    top_k: int,
) -> list[RetrievedChunk]:
    """Fusión RRF entre rankings YA recuperados.

    La usa el orquestador cuando la búsqueda de la consulta original corre en
    paralelo con el rewriter: cada rama trae su ranking por separado y acá se
    fusionan — misma RRF que retrieve_multi_query, sin re-buscar nada.
    """
    valid = [r for r in rankings if r]
    if not valid:
        return []
    if len(valid) == 1:
        return valid[0][:top_k]
    return _rrf_fuse_lists(valid, top_k=top_k)

async def retrieve(
    query: str,
    tenant_id: str,
    top_k: int = settings.retrieval_top_k,
    rerank_top_k: int = settings.rerank_top_k,
) -> list[RetrievedChunk]:
    """Embed query, search Qdrant with independent timeout, rerank results.

    Each stage has its own timeout — a slow reranker doesn't block Qdrant results.
    Falls back gracefully at each stage.
    """
    from core.tracing import get_tracer
    tracer = get_tracer()

    # BM25 no necesita el embedding: se lanza YA y corre en paralelo con
    # embed + Qdrant. Antes iba en serie después del search — latencia sumada
    # por nada (son independientes hasta el merge RRF).
    bm25_task = asyncio.create_task(_bm25_search(query, tenant_id, limit=settings.bm25_limit))

    def _drop_bm25() -> None:
        if not bm25_task.done():
            bm25_task.cancel()

    # ── 1. Embed query (CPU-bound, non-blocking) ──────────────────────────────
    with tracer.start_as_current_span("retrieval.embed") as span:
        span.set_attribute("tenant_id", tenant_id)
        query_vector = await embed_query_cached(query)

    if query_vector is None:
        logger.error("retrieve_embed_failed query_len=%d", len(query))
        _drop_bm25()
        return []

    # ── 2. Qdrant search with independent timeout ─────────────────────────────
    collection = f"{tenant_id}_docs"
    qdrant = get_qdrant_client()

    with tracer.start_as_current_span("retrieval.qdrant_search") as span:
        span.set_attribute("collection", collection)
        span.set_attribute("top_k", top_k)
        try:
            async with asyncio.timeout(_QDRANT_TIMEOUT_S):
                results: list[ScoredPoint] = await qdrant.search(
                    collection_name=collection,
                    query_vector=query_vector,
                    limit=top_k,
                    with_payload=True,
                )
        except asyncio.TimeoutError:
            logger.warning(
                "qdrant_search_timeout tenant_id=%s timeout_s=%.1f",
                tenant_id, _QDRANT_TIMEOUT_S,
            )
            span.set_attribute("timeout", True)
            _drop_bm25()
            return []
        except Exception as exc:
            logger.error("qdrant_search_failed tenant_id=%s error=%s", tenant_id, exc)
            _drop_bm25()
            return []

    if not results:
        _drop_bm25()
        return []

    # ── 3. Build chunk list with parent_id from Qdrant payload ──────────────
    chunks = []
    for point in results:
        md = {k: v for k, v in point.payload.items() if k not in ("text", "document_id")}
        # Preservar el cosine original de Qdrant ANTES de que RRF/reranker
        # sobreescriban .score. Es la señal de relevancia semántica más estable:
        # no depende de que el reranker corra ni de la escala del RRF. El filtro de
        # relevancia (orchestrator) la usa como piso para no descartar chunks
        # semánticamente relevantes cuyo score post-pipeline quedó en otra escala.
        md["_cosine_score"] = float(point.score)
        chunks.append(RetrievedChunk(
            chunk_id=str(point.id),
            document_id=point.payload.get("document_id", ""),
            text=point.payload.get("text", ""),
            score=float(point.score),
            quality_gate_status=point.payload.get("quality_gate_status", "unknown"),
            metadata=md,
            parent_id=point.payload.get("parent_id"),
        ))

    # Skipped chunks participate in search but get a score penalty
    for chunk in chunks:
        if chunk.quality_gate_status == "skipped":
            chunk.score *= settings.skipped_chunk_score_penalty

    # ── 4. Parent expansion (Small-to-Big) ───────────────────────────────────
    # Replace each child's short text with its full parent text from PG.
    # Flat chunks (parent_id=None) pass through unchanged.
    with tracer.start_as_current_span("retrieval.parent_expand") as span:
        parent_ids = list({c.parent_id for c in chunks if c.parent_id})
        span.set_attribute("parents_to_fetch", len(parent_ids))

        if parent_ids:
            parent_texts = await _fetch_parent_texts(parent_ids, tenant_id)

            # Deduplicate: keep highest-scored child per parent, expand its text.
            best_per_parent: dict[str, RetrievedChunk] = {}
            flat_chunks: list[RetrievedChunk] = []

            for c in chunks:
                if c.parent_id:
                    prev = best_per_parent.get(c.parent_id)
                    if prev is None or c.score > prev.score:
                        best_per_parent[c.parent_id] = c
                else:
                    flat_chunks.append(c)

            expanded: list[RetrievedChunk] = []
            for pid, chunk in best_per_parent.items():
                if pid in parent_texts:
                    chunk.text = parent_texts[pid]
                expanded.append(chunk)

            chunks = flat_chunks + expanded
            span.set_attribute("after_dedup", len(chunks))

    # ── 5. BM25 keyword search + RRF merge ───────────────────────────────────
    # El search corrió en paralelo desde el arranque; acá solo se espera el
    # resultado (normalmente ya está listo) y se fusiona.
    with tracer.start_as_current_span("retrieval.bm25_rrf") as span:
        try:
            bm25_hits = await bm25_task
            span.set_attribute("bm25_hits", len(bm25_hits))
            if bm25_hits:
                chunks = _rrf_merge(chunks, bm25_hits)
                span.set_attribute("after_rrf", len(chunks))
        except Exception as exc:
            logger.warning("bm25_search_failed tenant_id=%s error=%s", tenant_id, exc)

    # ── 6. Orden final por score de fusión (reranker eliminado — ver arriba) ──
    reranked = sorted(chunks, key=lambda c: c.score, reverse=True)[:rerank_top_k]

    logger.debug(
        "retrieve_done tenant_id=%s candidates=%d reranked=%d",
        tenant_id, len(chunks), len(reranked),
    )
    return reranked

async def _fetch_parent_texts(parent_ids: list[str], tenant_id: str) -> dict[str, str]:
    """Fetch parent chunk texts from PostgreSQL in a single IN query."""
    from sqlalchemy import text as sa_text
    from core.database import get_pg_session

    if not parent_ids:
        return {}

    try:
        async with get_pg_session(tenant_id) as session:
            rows = await session.execute(
                sa_text("SELECT id, text FROM parent_chunks WHERE id = ANY(:ids)"),
                {"ids": parent_ids},
            )
            return {row.id: row.text for row in rows}
    except Exception as exc:
        logger.warning("fetch_parent_texts_failed tenant_id=%s error=%s", tenant_id, exc)
        return {}

async def _bm25_search(query: str, tenant_id: str, limit: int = 20) -> list[dict]:
    """Full-text BM25 search over parent_chunks via PostgreSQL tsvector."""
    from sqlalchemy import text as sa_text
    from core.database import get_pg_session

    # AND (&) entre términos. Probamos OR (|) pero fue contraproducente: en queries
    # con palabras comunes ("horario", "atiende") el OR trae chunks genéricos que
    # dominan el BM25 y, vía RRF, entierran el ranking del embedding (que ya es bueno
    # — los cardiólogos salían top-4 por cosine). Con AND, una query multi-término
    # matchea pocos/ningún chunk → BM25 no contamina y el embedding manda (lo correcto
    # para queries semánticas). Si AND da 0 hits (término raro faltante), cae a
    # embedding-only, que para nombres propios ya funciona bien.
    # Sanitizar cada token a alfanumérico ANTES de armar el tsquery: caracteres
    # como ( ) ? ! & | * : son sintaxis de to_tsquery y un input de usuario con
    # paréntesis desbalanceados o "?!!" rompía la query SQL → BM25 devolvía []
    # en silencio y ese turno perdía todo el recall léxico (bug encontrado por
    # fuzzing accidental durante el eval de tool-routing, 2026-07-21).
    words = [
        w for w in (
            re.sub(r"[^0-9a-zñáéíóúü]+", "", t, flags=re.IGNORECASE)
            for t in query.replace("'", " ").split()
        )
        if len(w) > 1
    ]
    if not words:
        return []
    tsquery = " & ".join(words)

    try:
        async with get_pg_session(tenant_id) as session:
            rows = await session.execute(
                sa_text("""
                    SELECT pc.id, pc.document_id, pc.text, d.filename,
                           ts_rank_cd(pc.ts_body, query) AS rank
                    FROM parent_chunks pc
                    LEFT JOIN documentos d ON d.id = pc.document_id,
                         to_tsquery('spanish', :tsquery) query
                    WHERE pc.ts_body @@ query
                    ORDER BY rank DESC
                    LIMIT :limit
                """),
                {"tsquery": tsquery, "limit": limit},
            )
            # str() en la frontera de PG: asyncpg devuelve UUID objects. Sin el
            # cast: (1) el response model SourceChunk explota con 500 (espera str),
            # (2) el cache write falla (UUID no es JSON-serializable), y (3) las
            # keys del RRF nunca matchean las semánticas (str vs UUID) → BM25
            # duplicaba parents en vez de boostearlos.
            return [
                {
                    "parent_id": str(row.id),
                    "document_id": str(row.document_id),
                    "text": row.text,
                    "filename": row.filename,
                    "bm25_rank": float(row.rank),
                }
                for row in rows
            ]
    except Exception as exc:
        logger.warning("bm25_search_failed tenant_id=%s error=%s", tenant_id, exc)
        return []

def _rrf_merge(
    semantic_chunks: list[RetrievedChunk],
    bm25_hits: list[dict],
    k: int | None = None,
) -> list[RetrievedChunk]:
    if k is None:
        k = settings.rrf_k
    """Reciprocal Rank Fusion: merge semantic + BM25 results by rank.

    RRF score = 1/(k + rank_semantic) + 1/(k + rank_bm25).
    BM25 results that match a semantic chunk boost it; new BM25-only
    results are added as new RetrievedChunks with their parent text.
    """
    # Map parent_id → (rrf_contribution, chunk) for semantic results
    rrf_scores: dict[str, float] = {}
    chunk_by_pid: dict[str, RetrievedChunk] = {}
    # Also index by chunk_id for flat chunks (parent_id=None)
    chunk_by_cid: dict[str, RetrievedChunk] = {}

    for rank, chunk in enumerate(semantic_chunks):
        key = chunk.parent_id or chunk.chunk_id
        score = 1.0 / (k + rank + 1)
        rrf_scores[key] = rrf_scores.get(key, 0.0) + score
        chunk_by_pid[key] = chunk
        chunk_by_cid[chunk.chunk_id] = chunk

    # Add BM25 rank contributions
    for rank, hit in enumerate(bm25_hits):
        pid = hit["parent_id"]
        bm25_score = 1.0 / (k + rank + 1)
        if pid in rrf_scores:
            rrf_scores[pid] += bm25_score
        else:
            # BM25-only hit — add as new chunk with parent text
            rrf_scores[pid] = bm25_score
            md = {"strategy": "bm25"}
            if hit.get("filename"):
                md["filename"] = hit["filename"]  # título real en las fuentes
            chunk_by_pid[pid] = RetrievedChunk(
                chunk_id=pid,
                document_id=hit["document_id"],
                text=hit["text"],
                score=0.0,
                quality_gate_status="unknown",
                metadata=md,
                parent_id=pid,
            )

    # Apply RRF scores and return sorted
    for key, rrf in rrf_scores.items():
        if key in chunk_by_pid:
            chunk_by_pid[key].score = rrf

    return sorted(chunk_by_pid.values(), key=lambda c: c.score, reverse=True)
