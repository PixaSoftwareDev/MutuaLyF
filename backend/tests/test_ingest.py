"""Tests for the ingestion pipeline services."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from services.chunker import chunk_document, extract_text_from_bytes, Chunk
from services.quality_gate import validate_chunk, validate_chunks_batch, QualityStatus, QualityResult


# ── Chunker tests ──────────────────────────────────────────────────────────────

class TestChunker:
    def test_chunk_document_basic(self):
        text = "This is a sentence. " * 100  # ~300 tokens
        chunks = chunk_document(text, "doc-001", "tenant_a")
        assert len(chunks) > 0
        assert all(isinstance(c, Chunk) for c in chunks)

    def test_chunk_has_required_fields(self):
        chunks = chunk_document("Hello world. " * 50, "doc-001", "tenant_a")
        chunk = chunks[0]
        assert chunk.id
        assert chunk.document_id == "doc-001"
        assert chunk.tenant_id == "tenant_a"
        assert chunk.text
        assert chunk.chunk_level == "flat"
        assert chunk.parent_id is None

    def test_chunk_empty_text_returns_empty(self):
        chunks = chunk_document("   ", "doc-001", "tenant_a")
        assert chunks == []

    def test_chunk_indices_are_sequential(self):
        text = "Paragraph. " * 200
        chunks = chunk_document(text, "doc-001", "tenant_a")
        for i, chunk in enumerate(chunks):
            assert chunk.chunk_index == i
            assert chunk.total_chunks == len(chunks)

    def test_chunk_metadata_propagated(self):
        meta = {"filename": "test.txt", "source": "manual"}
        chunks = chunk_document("Content here. " * 50, "doc-001", "tenant_a", metadata=meta)
        for chunk in chunks:
            assert chunk.metadata["filename"] == "test.txt"

    def test_extract_text_plain(self):
        content = b"Hello world this is a test."
        text = extract_text_from_bytes(content, "text/plain", "test.txt")
        assert "Hello world" in text

    def test_extract_text_html(self):
        html = b"<html><body><script>var x=1;</script><p>Hello</p></body></html>"
        text = extract_text_from_bytes(html, "text/html", "test.html")
        assert "Hello" in text
        assert "var x=1" not in text  # script tag content should be stripped

    def test_chunk_ids_are_unique(self):
        chunks = chunk_document("Word " * 300, "doc-001", "tenant_a")
        ids = [c.id for c in chunks]
        assert len(ids) == len(set(ids))


# ── Quality gate tests ─────────────────────────────────────────────────────────

class TestQualityGate:
    @pytest.fixture
    def sample_chunk(self):
        return Chunk(
            id="chunk-001",
            document_id="doc-001",
            tenant_id="tenant_a",
            text="This is a well-formed paragraph about company policies.",
            token_count=10,
            chunk_index=0,
            total_chunks=1,
        )

    @pytest.mark.asyncio
    async def test_validate_chunk_passed_on_coherent(self, sample_chunk):
        with patch(
            "services.quality_gate.complete_quality_gate",
            new=AsyncMock(return_value={"is_coherent": True, "reason": "good", "error": None}),
        ):
            result = await validate_chunk(sample_chunk)
            assert result.status == QualityStatus.PASSED
            assert result.is_coherent is True

    @pytest.mark.asyncio
    async def test_validate_chunk_pending_on_groq_failure(self, sample_chunk):
        with patch(
            "services.quality_gate.complete_quality_gate",
            new=AsyncMock(return_value={"is_coherent": None, "reason": None, "error": "API timeout"}),
        ):
            result = await validate_chunk(sample_chunk)
            # Groq failure → PENDING, not blocked
            assert result.status == QualityStatus.PENDING
            assert result.error is not None
            assert result.is_coherent is True  # Optimistic default

    @pytest.mark.asyncio
    async def test_validate_chunk_pending_on_incoherent(self, sample_chunk):
        with patch(
            "services.quality_gate.complete_quality_gate",
            new=AsyncMock(return_value={"is_coherent": False, "reason": "boilerplate", "error": None}),
        ):
            result = await validate_chunk(sample_chunk)
            assert result.status == QualityStatus.PENDING
            assert result.is_coherent is False

    @pytest.mark.asyncio
    async def test_batch_validation(self, sample_chunk):
        chunks = [sample_chunk] * 3
        with patch(
            "services.quality_gate.complete_quality_gate",
            new=AsyncMock(return_value={"is_coherent": True, "reason": "ok", "error": None}),
        ):
            results = await validate_chunks_batch(chunks, max_concurrent=2)
            assert len(results) == 3
            assert all(r.status == QualityStatus.PASSED for r in results)

    @pytest.mark.asyncio
    async def test_batch_handles_exceptions(self, sample_chunk):
        """Batch validation should not crash if one chunk raises an exception."""
        chunks = [sample_chunk] * 2

        async def _raise_once(text, tenant_id):
            raise RuntimeError("Unexpected error")

        with patch("services.quality_gate.complete_quality_gate", new=AsyncMock(side_effect=_raise_once)):
            results = await validate_chunks_batch(chunks)
            # All should be marked PENDING (not crash)
            assert len(results) == 2
            for r in results:
                assert r.status == QualityStatus.PENDING
