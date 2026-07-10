"""Regresión del bug UUID en el camino BM25 (encontrado en prod 2026-07-10).

asyncpg devuelve UUID objects; sin str() en la frontera:
1. SourceChunk (response model) explota con 500 — document_id/title esperan str
2. El cache write falla: UUID no es JSON-serializable
3. Las keys del RRF nunca matchean (str semántico vs UUID BM25) → BM25
   duplicaba parents en vez de boostearlos
"""

import uuid

from services.retrieval import RetrievedChunk, _rrf_merge


def _chunk(parent_id: str, cid: str = "c1", score: float = 0.9) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=cid, document_id="doc-1", text="texto semántico",
        score=score, quality_gate_status="passed",
        metadata={"filename": "reglamento.txt"}, parent_id=parent_id,
    )


class TestRRFMerge:
    def test_bm25_hit_boosts_matching_semantic_parent(self):
        """El hit BM25 del MISMO parent debe boostear, no duplicar (bug str vs UUID)."""
        pid = str(uuid.uuid4())
        semantic = [_chunk(pid)]
        bm25 = [{"parent_id": pid, "document_id": "doc-1", "text": "t", "bm25_rank": 1.0}]
        merged = _rrf_merge(semantic, bm25, k=60)
        assert len(merged) == 1              # boost, no duplicado
        assert merged[0].score > 1.0 / 61    # score RRF combinado (dos aportes)

    def test_bm25_only_hit_carries_string_ids_and_filename(self):
        """Los hits BM25-only deben salir con ids str y filename en metadata."""
        pid = str(uuid.uuid4())
        bm25 = [{"parent_id": pid, "document_id": "doc-2", "text": "t",
                 "filename": "manual.txt", "bm25_rank": 1.0}]
        merged = _rrf_merge([], bm25, k=60)
        assert len(merged) == 1
        c = merged[0]
        assert isinstance(c.document_id, str) and isinstance(c.chunk_id, str)
        assert c.metadata.get("filename") == "manual.txt"

    def test_uuid_parent_id_would_not_match_string(self):
        """Documenta el bug original: UUID object como key jamás matchea el str."""
        pid = str(uuid.uuid4())
        semantic = [_chunk(pid)]
        bm25_bug = [{"parent_id": uuid.UUID(pid), "document_id": "doc-1",
                     "text": "t", "bm25_rank": 1.0}]
        merged = _rrf_merge(semantic, bm25_bug, k=60)
        # Con el bug (UUID key), el mismo parent aparece DUPLICADO:
        assert len(merged) == 2
