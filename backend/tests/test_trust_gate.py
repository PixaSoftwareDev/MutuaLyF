"""Tests del trust gate (anti-alucinación por cobertura).

Cubren las tres capas sin tocar red: la léxica es puro cómputo, y el juez LLM
se mockea. El caso guía es el real de producción (2026-07-22): "¿cómo saco
turno para una resonancia de hombro?" contra una KB sin nada de resonancias.
"""

from unittest.mock import AsyncMock, patch

import pytest

from services import trust_gate
from services.trust_gate import (
    _distinctive_terms,
    coverage_note,
    evaluate_coverage,
    lexical_coverage,
)

CHUNKS_VECINOS = [
    "Fuente: Preparacion_Estudios.txt\nPara la ecografía obstétrica se debe beber un litro de agua una hora antes.",
    "Fuente: Info_General.txt\nEl Centro Médico requiere preparaciones previas según el tipo de estudio.",
    "Fuente: Info_General.txt\nLos turnos del Centro Médico se gestionan por Mi MutuaLyF Web.",
]


# ── Términos distintivos ──────────────────────────────────────────────────────

def test_terms_filtra_stopwords_y_verbos_de_tramite():
    terms = _distinctive_terms("¿cómo saco turno para una resonancia de hombro?")
    assert "resonancia" in terms
    assert "hombro" in terms
    assert "turno" in terms
    assert "como" not in terms and "saco" not in terms and "para" not in terms


def test_terms_conserva_siglas_cortas():
    assert "rnm" in _distinctive_terms("necesito una RNM urgente")


def test_terms_normaliza_tildes():
    assert "ecografia" in _distinctive_terms("¿la ecografía pediátrica requiere ayuno?")


# ── Cobertura léxica ──────────────────────────────────────────────────────────

def test_coverage_total_cuando_todo_presente():
    cov, missing = lexical_coverage("preparación ecografía obstétrica", CHUNKS_VECINOS)
    assert cov == 1.0
    assert missing == []


def test_coverage_detecta_terminos_ausentes():
    cov, missing = lexical_coverage("turno para resonancia de hombro", CHUNKS_VECINOS)
    assert cov < 1.0
    assert "resonancia" in missing and "hombro" in missing
    assert "turno" not in missing  # sí está en el contexto


def test_coverage_matchea_por_substring():
    # 'hora' debe matchear 'horario' (stemming barato por substring)
    cov, missing = lexical_coverage("hora de atención", ["El horario de atención es de 8 a 16."])
    assert "hora" not in missing


def test_coverage_sin_terminos_distintivos_no_opina():
    cov, _ = lexical_coverage("¿cómo hago?", CHUNKS_VECINOS)
    assert cov == 1.0


# ── evaluate_coverage: las tres salidas ───────────────────────────────────────

@pytest.mark.asyncio
async def test_pasa_directo_sin_juez_cuando_cobertura_alta():
    with patch.object(trust_gate, "_judge", new=AsyncMock()) as judge:
        result = await evaluate_coverage(
            "preparación ecografía obstétrica", CHUNKS_VECINOS, "test",
        )
    assert result["action"] == "answer"
    assert result["judge_used"] is False
    judge.assert_not_awaited()  # capa gratis: el LLM ni se entera


@pytest.mark.asyncio
async def test_rechaza_cuando_el_juez_dice_que_nada_responde():
    veredicto = {"kept": [], "motivo": "no hay información sobre resonancias"}
    with patch.object(trust_gate, "_judge", new=AsyncMock(return_value=veredicto)):
        result = await evaluate_coverage(
            "turno para resonancia de hombro", CHUNKS_VECINOS, "test",
        )
    assert result["action"] == "refuse"
    assert result["judge_used"] is True
    assert "resonancia" in result["missing"]


@pytest.mark.asyncio
async def test_filtra_contexto_cuando_el_juez_aprueba_algunos():
    veredicto = {"kept": [2], "motivo": "el 3 explica cómo sacar turno"}
    with patch.object(trust_gate, "_judge", new=AsyncMock(return_value=veredicto)):
        result = await evaluate_coverage(
            "turno para resonancia de hombro", CHUNKS_VECINOS, "test",
        )
    assert result["action"] == "answer"
    assert result["kept"] == [2]
    # cobertura parcial → missing viaja para que la generación admita el límite
    assert "resonancia" in result["missing"]


@pytest.mark.asyncio
async def test_fail_open_si_el_juez_falla():
    with patch.object(trust_gate, "_judge", new=AsyncMock(return_value=None)):
        result = await evaluate_coverage(
            "turno para resonancia de hombro", CHUNKS_VECINOS, "test",
        )
    assert result["action"] == "answer"  # ante la duda, comportamiento previo
    assert result["reason"] == "judge_failed_open"


# ── Nota de cobertura parcial ─────────────────────────────────────────────────

def test_coverage_note_admite_limite_sin_afirmar_negativos():
    note = coverage_note(["resonancia", "hombro"])
    assert "resonancia" in note
    assert "NO TENÉS INFORMACIÓN" in note
    # la nota prohíbe explícitamente afirmar que el servicio no existe
    assert "no se realiza" in note or "no existe" in note
