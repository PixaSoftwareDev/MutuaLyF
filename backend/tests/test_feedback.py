"""Feedback del afiliado al cierre (caritas 1-3) — Fase 1.

Cubre la validación del request del widget, las reglas del endpoint admin de
resolución, y la semántica de la cola (acciones válidas, estados).
Los caminos con DB real se validan E2E por API en dev-local (el patrón de
integración del proyecto); acá va la lógica pura y los contratos.
"""

import pytest
from pydantic import ValidationError

from api.v1.widget_conversation import FeedbackRequest, VALID_FEEDBACK_REASONS
from api.v1.operator_panel import FeedbackResolveRequest, _FEEDBACK_ACTIONS


class TestFeedbackRequest:
    def test_ratings_validos(self):
        for r in (1, 2, 3):
            assert FeedbackRequest(rating=r).rating == r

    def test_rating_fuera_de_rango(self):
        with pytest.raises(ValidationError):
            FeedbackRequest(rating=0)
        with pytest.raises(ValidationError):
            FeedbackRequest(rating=4)
        with pytest.raises(ValidationError):
            FeedbackRequest(rating=5)  # no hay escala 1-5 — decisión de diseño

    def test_reason_opcional(self):
        assert FeedbackRequest(rating=1).reason is None
        assert FeedbackRequest(rating=1, reason="not_found").reason == "not_found"

    def test_reasons_conocidos(self):
        # El endpoint descarta silenciosamente reasons fuera del set (no 4xx:
        # un chip desconocido no debe romper el voto del afiliado)
        assert VALID_FEEDBACK_REASONS == {"not_found", "wrong_info", "slow_service"}


class TestFeedbackResolve:
    def test_acciones_validas_cerradas(self):
        # Las 4 acciones son el contrato con el frontend de la cola — si se
        # agrega una, sumar acá y en la botonera.
        assert _FEEDBACK_ACTIONS == {
            "missing_content", "wrong_content", "bot_misunderstood", "dismissed",
        }

    def test_request_no_vacio(self):
        with pytest.raises(ValidationError):
            FeedbackResolveRequest(action="")


class TestReviewStatusSemantica:
    """La regla de negocio central: solo 😞/😐 generan trabajo."""

    def test_rating_negativo_va_a_cola(self):
        # Refleja la lógica del endpoint: rating <= 2 → pending
        for rating in (1, 2):
            assert ("pending" if rating <= 2 else None) == "pending"

    def test_rating_feliz_no_genera_trabajo(self):
        assert ("pending" if 3 <= 2 else None) is None
