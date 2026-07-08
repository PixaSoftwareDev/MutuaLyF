"""Tests del detector de contradicciones de campos.

Cubre el caso real que motivó la feature y la trampa que encontramos probando:
Junín 2956 (centro médico) y Junín 2961 (sede) son direcciones LEGÍTIMAS de
entidades distintas, no un error de OCR — el detector debe distinguirlas por sujeto.
"""

from services.contradiction_detector import (
    extract_occurrences,
    _similar_number,
    _classify_subject,
)


def test_extracts_address_with_subject_centro_medico():
    text = "Centro: Centro Médico MutuaLyF, Junín 2956, Santa Fe"
    occ = extract_occurrences(text)
    dirs = [o for o in occ if o[0] == "direccion"]
    assert any("centro_medico" in o[1] and o[2] == "2956" for o in dirs)


def test_extracts_address_with_subject_sede():
    text = "1.2 Sede la mutual y contacto principal Dirección: Junín 2961, Santa Fe"
    occ = extract_occurrences(text)
    dirs = [o for o in occ if o[0] == "direccion"]
    assert any("sede" in o[1] and o[2] == "2961" for o in dirs)


def test_subject_classification():
    assert _classify_subject("El Centro Médico está en") == "centro_medico"
    assert _classify_subject("la sede administrativa de") == "sede"
    assert _classify_subject("Oficina de Autorizaciones") == "sede"
    assert _classify_subject("un texto cualquiera sin marcador") == "general"


def test_similar_number_catches_ocr_typo():
    assert _similar_number("2956", "2961")     # 2 dígitos distintos
    assert _similar_number("2956", "2957")     # 1 dígito
    assert not _similar_number("2956", "2956")  # idénticos → no es variante
    assert not _similar_number("2956", "1234")  # muy distintos
    assert not _similar_number("2956", "295")   # distinto largo


def test_number_list_not_flagged_as_typo_when_length_differs():
    assert not _similar_number("0074", "074")


def test_extracts_phone():
    text = "Teléfono: 0342 452 0074 interno 187"
    occ = extract_occurrences(text)
    phones = [o for o in occ if o[0] == "telefono"]
    assert phones and phones[0][2] == "03424520074"


def test_list_numbering_not_taken_as_address():
    # "3.13 Mendoza" no debe extraerse como dirección (viene tras dígito.punto).
    occ = extract_occurrences("3.13 Mendoza Fabian Jose Alberto — Clinica medica")
    assert not [o for o in occ if o[0] == "direccion"]
