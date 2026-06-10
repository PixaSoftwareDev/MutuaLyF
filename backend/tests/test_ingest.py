"""Tests for the ingestion pipeline services."""

import pytest
from unittest.mock import AsyncMock, patch

from services.chunker import (
    chunk_document,
    chunk_document_hierarchical,
    extract_text_from_bytes,
    Chunk,
    _json_record_sections,
)
from services.quality_gate import validate_chunk, validate_chunks_batch, QualityStatus


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


# ── JSON extraction tests ──────────────────────────────────────────────────────

class TestJsonExtraction:
    def test_flat_object_becomes_key_value_lines(self):
        raw = b'{"nombre": "Mesa de ayuda", "horario": "8 a 16"}'
        text = extract_text_from_bytes(raw, "application/json", "info.json")
        assert "nombre: Mesa de ayuda" in text
        assert "horario: 8 a 16" in text
        assert "{" not in text  # sin sintaxis JSON cruda

    def test_array_of_objects_expands_with_indices(self):
        raw = b'{"tramites": [{"nombre": "Alta"}, {"nombre": "Baja"}]}'
        text = extract_text_from_bytes(raw, "application/json", "tramites.json")
        assert "tramites[0].nombre: Alta" in text
        assert "tramites[1].nombre: Baja" in text

    def test_nested_structure_keeps_full_path(self):
        raw = b'{"contacto": {"telefono": "123", "horarios": {"semana": "8 a 16"}}}'
        text = extract_text_from_bytes(raw, "application/json", "contacto.json")
        assert "contacto.telefono: 123" in text
        assert "contacto.horarios.semana: 8 a 16" in text

    def test_primitive_array_items_are_indexed(self):
        raw = b'{"sedes": ["Centro", "Norte"]}'
        text = extract_text_from_bytes(raw, "application/json", "sedes.json")
        assert "sedes[0]: Centro" in text
        assert "sedes[1]: Norte" in text

    def test_invalid_json_falls_back_to_raw_text(self):
        # El upload rechaza JSON inválido (400), pero el extractor mantiene el
        # fallback para documentos ya ingestados antes de esa validación.
        raw = b'{ "a": [1, 2 '
        text = extract_text_from_bytes(raw, "application/json", "roto.json")
        assert text == '{ "a": [1, 2 '


# ── JSON record-aligned chunking tests ─────────────────────────────────────────

def _nomina_json_text(n: int = 30) -> str:
    """Texto aplanado como lo emite el extractor para una nómina de n personas."""
    lines = ["version: 2026.1"]
    for i in range(n):
        lines += [
            f"empleados[{i}].nombre: Persona {i}",
            f"empleados[{i}].area: {'Ventas' if i % 3 == 0 else 'Soporte'}",
            f"empleados[{i}].interno: {1000 + i}",
        ]
    return "\n".join(lines)


class TestJsonRecordChunking:
    def test_detects_record_list_and_packs_whole_records(self):
        sections = _json_record_sections(_nomina_json_text())
        assert sections is not None
        # Cada registro queda entero dentro de una sección (nunca partido):
        # las 3 líneas de empleados[7] aparecen juntas en el mismo body.
        body_with_7 = next(b for _, b in sections if "empleados[7].nombre" in b)
        assert "empleados[7].area" in body_with_7
        assert "empleados[7].interno" in body_with_7

    def test_returns_none_for_non_record_text(self):
        assert _json_record_sections("config.timeout: 5000\nconfig.debug: true") is None
        assert _json_record_sections("Texto libre sin estructura de registros.") is None

    def test_hierarchical_children_are_one_record_each(self):
        parents, children = chunk_document_hierarchical(
            _nomina_json_text(), "doc-001", "tenant_a",
            metadata={"mime_type": "application/json", "filename": "nomina.json"},
        )
        assert parents and children
        # Un child que menciona a empleados[7] tiene TODOS sus campos (registro
        # entero) y NO arrastra campos de otro registro.
        child_7 = next(c for c in children if "empleados[7].nombre" in c.text)
        assert "empleados[7].interno" in child_7.text
        assert "empleados[8]." not in child_7.text
        assert "empleados[6]." not in child_7.text

    def test_non_json_mime_keeps_normal_path(self):
        # El mismo texto SIN mime application/json no entra al camino de
        # registros — el resto del pipeline queda intacto.
        parents, children = chunk_document_hierarchical(
            _nomina_json_text(), "doc-001", "tenant_a",
            metadata={"mime_type": "text/plain", "filename": "nomina.txt"},
        )
        assert parents and children  # no crashea; sigue el camino estructural


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
    async def test_validate_chunk_incoherent_goes_to_pending(self, sample_chunk):
        """Incoherente según la IA → PENDING (cola de revisión del admin), NO SKIPPED.

        Decisión de la auditoría de casuística (commit 09364b5): la IA marca,
        el admin decide. SKIPPED queda reservado para el rechazo manual del
        admin — el chunk se indexa igual y participa en búsquedas penalizado.
        """
        with patch(
            "services.quality_gate.complete_quality_gate",
            new=AsyncMock(return_value={"is_coherent": False, "reason": "boilerplate", "error": None}),
        ):
            result = await validate_chunk(sample_chunk)
            assert result.status == QualityStatus.PENDING
            assert result.is_coherent is False

    @pytest.mark.asyncio
    async def test_validate_chunk_pending_on_parse_error(self, sample_chunk):
        """Groq JSON parse failure must produce PENDING, not silently pass the chunk."""
        with patch(
            "services.quality_gate.complete_quality_gate",
            new=AsyncMock(return_value={"is_coherent": None, "reason": None, "error": "JSONDecodeError"}),
        ):
            result = await validate_chunk(sample_chunk)
            assert result.status == QualityStatus.PENDING
            assert result.error is not None

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
