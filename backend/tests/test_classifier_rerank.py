"""Regresión del re-rank léxico del clasificador.

Cubre dos bugs reales:
1. Sin dedup por label, dos EJEMPLOS de la misma intención en el top-2
   disparaban is_ambiguous contra sí misma.
2. Margen de ambigüedad en coseno crudo: cuando el boost léxico invierte el
   orden, el coseno del runner-up supera al del ganador → margen negativo →
   is_ambiguous=True por construcción.
"""

from unittest.mock import AsyncMock, patch

import pytest


class _FakeHit:
    def __init__(self, label: str, score: float):
        self.payload = {"label": label}
        self.score = score


def _mock_qdrant(hits):
    qdrant = AsyncMock()
    qdrant.search = AsyncMock(return_value=hits)
    return qdrant


async def _classify(hits, query="¿a qué hora atienden?"):
    from services.classifier import classify_intent

    with patch("services.embedding_cache.embed_query_cached",
               new=AsyncMock(return_value=[0.1] * 1024)), \
         patch("services.classifier.get_qdrant_client",
               return_value=_mock_qdrant(hits)):
        return await classify_intent(query, "tenant_a")


@pytest.mark.asyncio
async def test_same_label_examples_are_not_ambiguous():
    """Dos puntos de la MISMA intención pegados no son ambigüedad."""
    hits = [
        _FakeHit("horarios_atencion", 0.80),
        _FakeHit("horarios_atencion", 0.79),   # otro ejemplo del mismo intent
        _FakeHit("sacar_turno", 0.55),         # el competidor real está lejos
    ]
    result = await _classify(hits)
    assert result.label == "horarios_atencion"
    assert result.is_ambiguous is False
    assert result.second_label == "sacar_turno"   # el runner-up es OTRO label


@pytest.mark.asyncio
async def test_rerank_flip_does_not_force_ambiguity():
    """Cuando el boost léxico invierte el orden, el margen se mide en la escala
    del score combinado (siempre >= 0), no en coseno crudo (que daría negativo)."""
    # "turno" en la query matchea el label sacar_turno → boost léxico lo sube
    # por encima de horarios_atencion aunque pierda en coseno por poco.
    hits = [
        _FakeHit("horarios_atencion", 0.82),
        _FakeHit("sacar_turno", 0.80),
    ]
    result = await _classify(hits, query="quiero sacar un turno con el médico")
    assert result.label == "sacar_turno"
    # confidence reportado = coseno del elegido (semántica de umbral intacta)
    assert result.confidence == pytest.approx(0.80)
    # el margen combinado decide ambigüedad; nunca puede ser negativo
    assert result.second_confidence == pytest.approx(0.82)


@pytest.mark.asyncio
async def test_clear_winner_is_not_ambiguous():
    hits = [
        _FakeHit("afiliacion", 0.85),
        _FakeHit("farmacia", 0.55),
    ]
    result = await _classify(hits, query="¿cómo me afilio a la mutual?")
    assert result.label == "afiliacion"
    assert result.is_ambiguous is False


@pytest.mark.asyncio
async def test_hits_without_label_are_ignored():
    hits = [_FakeHit("", 0.9)]
    hits[0].payload = {}
    result = await _classify(hits)
    assert result.band == "unknown"
    assert result.label is None
