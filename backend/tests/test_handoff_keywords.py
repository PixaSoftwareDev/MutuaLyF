"""Regla 5 del handoff: derivación proactiva por palabras clave del tenant.

Cubre el matcher (palabra completa, tildes, frases, falsos positivos tipo
"saturno") y la integración en evaluate_handoff (responder-y-ofrecer:
keep_answer=True, sin tocar el contador de insuficientes, supresión 1h).
"""

import pytest

from services.handoff import (
    HandoffTrigger,
    evaluate_handoff,
    match_keyword_trigger,
)

TURNOS = [{"words": ["turno", "turnos", "agenda", "reserva"], "message": "¿Te derivo con un operador para gestionar tu turno?"}]


# ── Matcher ───────────────────────────────────────────────────────────────────

class TestMatchKeywordTrigger:
    def test_match_simple(self):
        assert match_keyword_trigger("quiero un turno con el médico", TURNOS) is not None

    def test_match_plural(self):
        assert match_keyword_trigger("hay turnos disponibles?", TURNOS) is not None

    def test_match_insensible_mayusculas(self):
        assert match_keyword_trigger("TURNO", TURNOS) is not None

    def test_match_insensible_tildes(self):
        # El afiliado escribe con tilde de más; la config está sin tilde
        assert match_keyword_trigger("necesito la agénda", TURNOS) is not None

    def test_match_con_puntuacion_pegada(self):
        assert match_keyword_trigger("¿turno?", TURNOS) is not None
        assert match_keyword_trigger("turno.", TURNOS) is not None

    def test_no_match_subcadena(self):
        # "turno" adentro de "saturno" o "reserva" adentro de "reservado" NO disparan
        assert match_keyword_trigger("me gusta el planeta saturno", TURNOS) is None
        assert match_keyword_trigger("el salón está reservado", TURNOS) is None

    def test_no_match_texto_sin_tema(self):
        assert match_keyword_trigger("¿cuánto sale la cuota social?", TURNOS) is None

    def test_frase_completa(self):
        groups = [{"words": ["sacar turno"], "message": ""}]
        assert match_keyword_trigger("quiero sacar turno para mañana", groups) is not None
        # Palabras sueltas de la frase no alcanzan
        assert match_keyword_trigger("quiero sacar la basura", groups) is None

    def test_primer_grupo_gana(self):
        groups = [
            {"words": ["reclamo"], "message": "mensaje reclamos"},
            {"words": ["turno"], "message": "mensaje turnos"},
        ]
        g = match_keyword_trigger("tengo un reclamo por mi turno", groups)
        assert g is not None and g["message"] == "mensaje reclamos"

    def test_grupos_vacios_o_nulos(self):
        assert match_keyword_trigger("quiero un turno", []) is None
        assert match_keyword_trigger("quiero un turno", None) is None
        assert match_keyword_trigger("", TURNOS) is None
        assert match_keyword_trigger("quiero un turno", [{"words": [], "message": "x"}]) is None


# ── Integración en evaluate_handoff ───────────────────────────────────────────

@pytest.fixture
def patch_config(monkeypatch):
    """Config del tenant con keyword_triggers y sin tocar la DB/Redis."""
    async def fake_config(tenant_id):
        return {
            "consecutive_insufficient_count": 2,
            "attention_hours": None,
            "contact_info": None,
            "transition_messages": {"handoff_offer": "¿Querés que te conecte con un operador?"},
            "keyword_triggers": TURNOS,
        }
    import services.handoff as h
    monkeypatch.setattr(h, "_get_handoff_config", fake_config)

    # Redis fuera: sin ofertas pendientes ni supresión previa
    async def no_pending(cid): return False
    async def zero(cid): return 0
    monkeypatch.setattr(h, "_is_offer_pending", no_pending)
    monkeypatch.setattr(h, "_is_keyword_offered", no_pending)
    monkeypatch.setattr(h, "_get_insufficient", zero)
    return h


@pytest.mark.asyncio
async def test_keyword_dispara_con_respuesta_buena(patch_config):
    """Responder-y-ofrecer: aunque el bot tenga buena respuesta, si el tema es
    derivable la señal sale con keep_answer=True."""
    signal = await evaluate_handoff(
        conversation_id="c1", tenant_id="t1",
        user_message="¿cómo saco un turno con cardiología?",
        sources=[{"low_confidence": False}],  # respuesta CON fuentes buenas
        bot_answer="Para sacar turno llamá al...",
    )
    assert signal.trigger == HandoffTrigger.KEYWORD
    assert signal.keep_answer is True
    assert "operador" in signal.offer_message.lower()


@pytest.mark.asyncio
async def test_keyword_usa_mensaje_del_grupo(patch_config):
    signal = await evaluate_handoff(
        conversation_id="c1", tenant_id="t1",
        user_message="quiero reserva",
        sources=[], bot_answer="",
    )
    assert signal.offer_message == TURNOS[0]["message"]


@pytest.mark.asyncio
async def test_sin_keyword_no_dispara(patch_config, monkeypatch):
    import services.handoff as h
    async def noop(cid): return None
    monkeypatch.setattr(h, "_reset_insufficient", noop)
    monkeypatch.setattr(h, "clear_offer_pending", noop)
    monkeypatch.setattr(h, "_consume_pending_offers", lambda cid, tid: noop(cid))
    signal = await evaluate_handoff(
        conversation_id="c1", tenant_id="t1",
        user_message="¿cuánto sale la cuota?",
        sources=[{"low_confidence": False}],
        bot_answer="La cuota sale...",
    )
    assert signal.trigger == HandoffTrigger.NONE


@pytest.mark.asyncio
async def test_keyword_suprimido_si_ya_ofrecido(patch_config, monkeypatch):
    """Si ya se ofreció por keyword en esta conversación (ventana 1h), no re-ofrecer."""
    import services.handoff as h
    async def already(cid): return True
    async def noop(cid): return None
    monkeypatch.setattr(h, "_is_keyword_offered", already)
    monkeypatch.setattr(h, "_reset_insufficient", noop)
    monkeypatch.setattr(h, "clear_offer_pending", noop)
    monkeypatch.setattr(h, "_consume_pending_offers", lambda cid, tid: noop(cid))
    signal = await evaluate_handoff(
        conversation_id="c1", tenant_id="t1",
        user_message="dame un turno",
        sources=[{"low_confidence": False}],
        bot_answer="ok",
    )
    assert signal.trigger == HandoffTrigger.NONE


@pytest.mark.asyncio
async def test_keyword_no_pisa_cartel_pendiente(patch_config, monkeypatch):
    """Con una oferta ya en pantalla (cooldown 90s), no apilar otro cartel."""
    import services.handoff as h
    async def pending(cid): return True
    monkeypatch.setattr(h, "_is_offer_pending", pending)
    signal = await evaluate_handoff(
        conversation_id="c1", tenant_id="t1",
        user_message="turno por favor",
        sources=[], bot_answer="",
    )
    assert signal.trigger != HandoffTrigger.KEYWORD


@pytest.mark.asyncio
async def test_tenant_sin_keywords_configuradas(monkeypatch):
    """Tenant sin la feature configurada: comportamiento idéntico al actual."""
    import services.handoff as h
    async def fake_config(tenant_id):
        return {
            "consecutive_insufficient_count": 2,
            "attention_hours": None, "contact_info": None,
            "transition_messages": {"handoff_offer": "x"},
            "keyword_triggers": [],
        }
    async def no(cid): return False
    async def zero(cid): return 0
    async def noop(cid): return None
    monkeypatch.setattr(h, "_get_handoff_config", fake_config)
    monkeypatch.setattr(h, "_is_offer_pending", no)
    monkeypatch.setattr(h, "_get_insufficient", zero)
    monkeypatch.setattr(h, "_reset_insufficient", noop)
    monkeypatch.setattr(h, "clear_offer_pending", noop)
    monkeypatch.setattr(h, "_consume_pending_offers", lambda cid, tid: noop(cid))
    signal = await evaluate_handoff(
        conversation_id="c1", tenant_id="t1",
        user_message="quiero un turno",
        sources=[{"low_confidence": False}],
        bot_answer="ok",
    )
    assert signal.trigger == HandoffTrigger.NONE
