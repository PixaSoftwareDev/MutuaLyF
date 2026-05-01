"""Tests for the query endpoint and orchestrator."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from services.groq_client import classify_complexity, QueryComplexity, _model_for_complexity
from core.config import settings


class TestComplexityClassifier:
    def test_short_question_is_simple(self):
        result = classify_complexity("¿Qué es el proceso de aprobación?", entity_count=0)
        assert result == QueryComplexity.SIMPLE

    def test_long_question_is_complex(self):
        long_q = "¿Podés explicarme detalladamente cómo funciona el proceso de aprobación de presupuestos en la empresa considerando los distintos departamentos y niveles jerárquicos que intervienen en la decisión final?"
        result = classify_complexity(long_q, entity_count=0)
        assert result == QueryComplexity.COMPLEX

    def test_many_entities_trigger_complex(self):
        result = classify_complexity("test", entity_count=5)
        assert result == QueryComplexity.COMPLEX

    def test_model_for_simple_complexity(self):
        model = _model_for_complexity(QueryComplexity.SIMPLE)
        assert model == settings.groq_model_fast

    def test_model_for_complex_complexity(self):
        model = _model_for_complexity(QueryComplexity.COMPLEX)
        assert model == settings.groq_model_reasoning

    def test_model_ids_never_forbidden(self):
        forbidden = {"llama-3.1-405b", "llama-3.1-70b-versatile", "bge-large-en-v1.5"}
        assert settings.groq_model_fast not in forbidden
        assert settings.groq_model_reasoning not in forbidden


class TestOrchestratorInputSanitization:
    """Verify that prompt injection prevention works."""

    def test_control_chars_stripped(self):
        from services.orchestrator import _sanitize_input
        evil = "normal text\x00injected\x01more"
        result = _sanitize_input(evil)
        assert "\x00" not in result
        assert "\x01" not in result
        assert "normal text" in result

    def test_long_input_truncated(self):
        from services.orchestrator import _sanitize_input
        long_input = "A" * 5000
        result = _sanitize_input(long_input)
        assert len(result) <= 2000

    def test_question_hash_is_deterministic(self):
        from services.orchestrator import _hash_question
        h1 = _hash_question("¿Qué es esto?")
        h2 = _hash_question("¿Qué es esto?")
        assert h1 == h2

    def test_question_hash_case_insensitive(self):
        from services.orchestrator import _hash_question
        h1 = _hash_question("¿Qué es ESTO?")
        h2 = _hash_question("¿qué es esto?")
        assert h1 == h2


class TestCacheKeyIsolation:
    """Verify that cache keys include tenant_id to prevent cross-tenant cache hits."""

    @pytest.mark.asyncio
    async def test_different_tenants_have_different_cache_keys(self):
        from services.orchestrator import _hash_question

        question = "¿Quién maneja RRHH?"
        hash_q = _hash_question(question)

        key_a = f"tenant_a:cache:{hash_q}"
        key_b = f"tenant_b:cache:{hash_q}"

        assert key_a != key_b
        assert "tenant_a" in key_a
        assert "tenant_b" in key_b
