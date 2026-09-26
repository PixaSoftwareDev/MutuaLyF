"""Pedido explícito de operador y liberación de frenos (bug 2026-09-26).

Síntoma: en la misma conversación, después de una oferta, el afiliado volvía a
pedir operador y el bot "esquivaba". Causas confirmadas con loop de diagnóstico:
(1) el detector determinístico no reconocía formas comunes de pedirlo; (2) el
freno de 1 h de la Regla 5 sobrevivía a "Volver al asistente".
"""

import pytest

from services.handoff import is_explicit_human_request

PIDE_OPERADOR = [
    "quiero hablar con un operador",
    "operador",
    "quiero un humano",
    "hablar con una persona",
    "necesito hablar con alguien",
    "pasame con alguien",
    "me comunicas con un operador?",
    "me comunicás con un operador",
    "hablar con un operador por favor",
    "atencion humana",
    "atención humana",
    "quiero que me atienda una persona",
    "comunicame con un asesor",
    "me pasas con un agente?",
    "operador por favor",
    "quiero hablar con un operador por un reintegro",
    "podria hablar con una persona real",
]

NO_PIDE = [
    "el operador atiende los sábados?",
    "a qué hora atienden los operadores",
    "cuánto sale la cuota",
    "la persona titular del plan puede sumar a su hija?",
    "hola",
    "gracias",
]


@pytest.mark.parametrize("texto", PIDE_OPERADOR)
def test_reconoce_pedido_de_operador(texto):
    assert is_explicit_human_request(texto), texto


@pytest.mark.parametrize("texto", NO_PIDE)
def test_no_confunde_preguntas_informativas(texto):
    assert not is_explicit_human_request(texto), texto


@pytest.mark.asyncio
async def test_reset_libera_el_freno_de_palabra_clave(monkeypatch):
    """Volver al asistente / devolver al bot / cerrar resetean TODO el estado de
    derivación, incluida la supresión de 1 h de la Regla 5: si el afiliado ya
    pidió operador, volver a nombrar el tema tiene que poder ofrecerlo."""
    import services.handoff as h
    llamadas = []

    async def noop(*a, **k):
        return None

    async def clear_kw(cid):
        llamadas.append(cid)

    monkeypatch.setattr(h, "_reset_insufficient", noop)
    monkeypatch.setattr(h, "clear_offer_pending", noop)
    monkeypatch.setattr(h, "_consume_pending_offers", noop)
    monkeypatch.setattr(h, "clear_keyword_offered", clear_kw, raising=False)
    await h.reset_handoff_signals("c1", "t1")
    assert llamadas == ["c1"]
