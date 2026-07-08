"""Regresión: _embed_openai debe trocear en lotes <= 2048 (OpenAI rechaza arrays mayores)."""
from unittest.mock import patch
import services.embeddings as emb


def test_embed_openai_chunks_large_input():
    """2661 inputs → varias llamadas, ninguna > _OPENAI_MAX_BATCH, longitud preservada."""
    n = 2661
    texts = [f"consulta {i}" for i in range(n)]
    sizes = []

    def fake_chunk(cleaned):
        sizes.append(len(cleaned))
        return [[0.0] * emb.EMBEDDING_DIM for _ in cleaned]

    with patch.object(emb, "_embed_openai_chunk", side_effect=fake_chunk):
        out = emb._embed_openai(texts)

    assert len(out) == n                       # contrato de longitud
    assert all(s <= emb._OPENAI_MAX_BATCH for s in sizes)  # ningún lote supera el límite
    assert sum(sizes) == n                      # cubre todo el input
    assert len(sizes) == 3                       # 1000 + 1000 + 661


def test_embed_openai_empty():
    assert emb._embed_openai([]) == []
