"""Tests de repair_mojibake — repara UTF-8→Latin1 y Mac Roman→Latin1."""

from core.text_utils import repair_mojibake


def test_none_and_empty_are_safe():
    assert repair_mojibake(None) is None
    assert repair_mojibake("") == ""


def test_clean_text_untouched():
    clean = "¿Cuál es el horario de atención?"
    assert repair_mojibake(clean) == clean


def test_macroman_repair():
    # Mac Roman decodificado como Latin-1: \x8e=é, \x87=á, \x97=ó, \x9c=ú, À=¿
    assert repair_mojibake("ÀCu\x87l es el horario de atenci\x97n?") == "¿Cuál es el horario de atención?"
    assert repair_mojibake("m\x8edico") == "médico"
    assert repair_mojibake("n\x9cmero") == "número"


def test_macroman_is_idempotent():
    once = repair_mojibake("ÀPuedo elegir cualquier m\x8edico?")
    assert repair_mojibake(once) == once
    assert once == "¿Puedo elegir cualquier médico?"


def test_utf8_mojibake_repair():
    # 'é' en UTF-8 (0xC3 0xA9) leído como Latin-1 = 'Ã©'
    assert repair_mojibake("mÃ©dico") == "médico"


def test_no_control_chars_after_repair():
    import re
    out = repair_mojibake("ÀQu\x8e prestaciones cubre adem\x87s de m\x8edicos?")
    assert not re.search(r"[\x80-\x9f]", out)
    assert out == "¿Qué prestaciones cubre además de médicos?"
