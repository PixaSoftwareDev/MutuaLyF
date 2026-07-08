"""Tests de la señal léxica que re-rankea el clasificador de intenciones.

Cubre el caso que motivó la feature: e5 confunde turno/horario y el desempate
por keywords lo corrige. Determinista, sin DB ni red.
"""

from services.intent_keywords import keyword_signal, _tokens, _stem_match


def test_horario_query_favours_horario_label_over_turno():
    q = "¿A qué hora termina el traumatólogo?"
    assert keyword_signal(q, "horarios_atencion") > keyword_signal(q, "sacar_turno")


def test_sacar_turno_query_favours_turno_label():
    q = "¿Puedo sacar turno por WhatsApp?"
    assert keyword_signal(q, "sacar_turno") > keyword_signal(q, "tramite_afiliacion")


def test_synonym_expansion_atiende_maps_to_horario():
    # "atiende" no comparte raíz con "horarios" pero es sinónimo de dominio.
    assert keyword_signal("¿Qué días atiende pediatría?", "horarios_atencion") > 0


def test_stem_match_handles_plural_and_accents():
    assert _stem_match("receta", "recetas")
    assert _stem_match("horario", "horarios")
    assert not _stem_match("turno", "horario")


def test_signal_is_normalised_fraction():
    sig = keyword_signal("¿Cómo saco un turno?", "sacar_turno")
    assert 0.0 <= sig <= 1.0
    assert sig >= 0.5  # al menos "turno" tiene evidencia léxica directa


def test_no_signal_for_unrelated_query():
    assert keyword_signal("¿Cuál es la capital de Francia?", "sacar_turno") == 0.0


def test_empty_and_none_label_are_safe():
    assert keyword_signal("hola", None) == 0.0
    assert keyword_signal("", "sacar_turno") == 0.0


def test_tokens_drop_stopwords_and_short():
    toks = _tokens("¿Cómo saco un turno?")
    assert "turno" in toks and "saco" in toks
    assert "un" not in toks and "como" not in toks  # stopwords fuera
