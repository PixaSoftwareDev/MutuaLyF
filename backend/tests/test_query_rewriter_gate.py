"""Tests del gate selectivo del query rewriter (2026-08-20).

Hasta ese día, "hay historial → reescribir SIEMPRE" hacía que toda consulta
dentro de una conversación pagara el LLM del rewriter + la búsqueda de su
variante (~2 s en serie). El gate v2 reescribe solo cuando hay señal de que
aporta: corta, interrogativa, continuación o anáfora.

Los casos son consultas REALES de afiliados de la semana del 18-20/08.
"""

from services.query_rewriter import should_rewrite, _gate_reason


class TestSiempreReescribe:
    """Señales que justifican el costo del rewriter."""

    def test_corta_una_palabra(self):
        # Carolina 20/08: "Turno" — elíptica, necesita expansión
        assert _gate_reason("Turno", has_history=True) == "corta"

    def test_corta_sin_historial(self):
        assert _gate_reason("horarios odontologia", has_history=False) == "corta"

    def test_apellido_de_profesional_corta(self):
        # Carolina 20/08: el gate la deja pasar por corta; que el rewriter no
        # "corrija" el apellido lo cubre la regla nueva del prompt.
        assert should_rewrite("Turno con gitron", has_history=True)

    def test_interrogativa(self):
        assert _gate_reason(
            "¿Qué documentación necesito para incorporar a mi hijo recién nacido?",
            has_history=False,
        ) == "interrogativa"

    def test_continuacion_con_historial(self):
        # Naty 18/08: repregunta que depende del turno anterior (plan materno)
        assert _gate_reason(
            "Bien,una vez que nazca mi hijo que debo presentar",
            has_history=True,
        ) == "continuacion"

    def test_continuacion_y(self):
        assert _gate_reason(
            "y cómo debo hacer para declarar el correo electrónico nuevo",
            has_history=True,
        ) == "continuacion"

    def test_anafora_con_historial(self):
        assert _gate_reason(
            "quisiera saber si eso tiene algún costo para el afiliado",
            has_history=True,
        ) == "anafora"

    def test_anafora_ahi(self):
        assert _gate_reason(
            "me confirmás si ahí atienden también los sábados a la mañana",
            has_history=True,
        ) == "anafora"


class TestSaltea:
    """Consultas autosuficientes: el rewriter solo agregaría latencia."""

    def test_declarativa_larga_autosuficiente(self):
        # Afiliada real 18/08 (plan materno) — 8+ palabras, sin señales
        assert _gate_reason(
            "Quisiera conocer que debo presentar para el plan materno",
            has_history=True,
        ) is None

    def test_declarativa_con_detalle(self):
        assert _gate_reason(
            "necesito asistir a kinesiología sin pedido médico urgente esta semana",
            has_history=True,
        ) is None

    def test_muy_larga_siempre_skip(self):
        larga = " ".join(["palabra"] * 35)
        assert _gate_reason(larga, has_history=True) is None

    def test_vacia(self):
        assert not should_rewrite("", has_history=True)
        assert not should_rewrite("   ", has_history=False)


class TestReglaMultiTenant:
    """El gate no puede contener vocabulario de negocio (contrato multi-tenant)."""

    def test_sets_solo_palabras_funcionales(self):
        from services.query_rewriter import _CONTINUATION_STARTS, _DEIXIS_WORDS
        # Ninguna palabra de dominio (salud, trámites, etc.) en los sets:
        # todas deben ser ≤3 sílabas funcionales del español. Chequeo simple:
        # nada de sustantivos largos.
        for palabra in _CONTINUATION_STARTS | _DEIXIS_WORDS:
            assert len(palabra) <= 10, f"sospechosa de ser dominio: {palabra}"
