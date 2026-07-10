"""Tests de lógica pura de intent_promotion + regresión de _uniquify_label.

_uniquify_label: la absorción ya dictaminó "tema nuevo"; si el label del LLM
colisiona con una intención existente, fusionar por ON CONFLICT mezclaría dos
temas en silencio → debe sufijar.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.intent_promotion import _is_junk_cluster, _uniquify_label


class TestIsJunkCluster:
    def test_single_word_spam_is_junk(self):
        assert _is_junk_cluster(["messi"] * 44) is True

    def test_real_questions_are_not_junk(self):
        samples = [
            "¿a qué hora atiende el traumatólogo?",
            "¿cómo saco un turno con clínica médica?",
            "¿dónde queda la sede central?",
        ]
        assert _is_junk_cluster(samples) is False

    def test_two_word_greetings_are_junk(self):
        assert _is_junk_cluster(["hola", "buenas", "hola bot", "gracias"]) is True


def _mock_session_returning_labels(labels):
    """Context manager async cuyo execute devuelve las filas dadas."""
    result = MagicMock()
    result.fetchall.return_value = [(lbl,) for lbl in labels]
    session = AsyncMock()
    session.execute = AsyncMock(return_value=result)
    ctx = MagicMock()
    ctx.__aenter__ = AsyncMock(return_value=session)
    ctx.__aexit__ = AsyncMock(return_value=False)
    return ctx


class TestUniquifyLabel:
    @pytest.mark.asyncio
    async def test_new_label_passes_through(self):
        with patch("core.database.get_worker_pg_session",
                   return_value=_mock_session_returning_labels([])):
            assert await _uniquify_label("tenant_a", "farmacia_horarios") == "farmacia_horarios"

    @pytest.mark.asyncio
    async def test_collision_gets_numeric_suffix(self):
        """Label ya existente (y la absorción dijo 'tema nuevo') → sufijo, no merge."""
        with patch("core.database.get_worker_pg_session",
                   return_value=_mock_session_returning_labels(["sacar_turno"])):
            assert await _uniquify_label("tenant_a", "sacar_turno") == "sacar_turno_2"

    @pytest.mark.asyncio
    async def test_suffix_skips_taken_candidates(self):
        existing = ["sacar_turno", "sacar_turno_2", "sacar_turno_3"]
        with patch("core.database.get_worker_pg_session",
                   return_value=_mock_session_returning_labels(existing)):
            assert await _uniquify_label("tenant_a", "sacar_turno") == "sacar_turno_4"

    @pytest.mark.asyncio
    async def test_db_failure_fails_open_to_original_label(self):
        """Un fallo de lectura no bloquea la promoción (comportamiento previo)."""
        with patch("core.database.get_worker_pg_session",
                   side_effect=RuntimeError("pg down")):
            assert await _uniquify_label("tenant_a", "afiliacion") == "afiliacion"


class TestSuggestionMode:
    @pytest.mark.asyncio
    async def test_disabled_flag_skips_automatic_promotion(self):
        from core.config import settings
        from services.intent_promotion import promote_candidate_clusters

        with patch.object(settings, "intent_auto_promote_enabled", False):
            summary = await promote_candidate_clusters("tenant_a")
        assert summary["enabled"] is False
        assert summary["promoted"] == 0

    @pytest.mark.asyncio
    async def test_force_bypasses_disabled_flag(self):
        """El disparo manual del admin corre aunque el modo sugerencia esté activo."""
        from core.config import settings
        from services.intent_promotion import promote_candidate_clusters

        # Sin clusters candidatos (session mockeada) → summary vacío pero enabled=True
        with patch.object(settings, "intent_auto_promote_enabled", False), \
             patch("core.database.get_worker_pg_session",
                   return_value=_mock_session_returning_labels([])):
            summary = await promote_candidate_clusters("tenant_a", force=True)
        assert summary["enabled"] is True
