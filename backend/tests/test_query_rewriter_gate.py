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


class TestConservaTema:
    """Control de deriva temática del rewriter (incidente 2026-08-25): una
    reescritura que pierde el tema de la pregunta se descarta y no se cachea."""

    def _conserva(self, original, reescrita):
        from services.query_rewriter import rewrite_conserva_tema
        return rewrite_conserva_tema(original, reescrita)

    # --- Reescrituras VÁLIDAS (deben pasar) ---
    def test_expansion_legitima(self):
        assert self._conserva(
            '¿puedo elegir libremente mi médico?',
            '¿Puedo elegir libremente a mi médico dentro de la Mutual Provincial de Luz y Fuerza?',
        )

    def test_repregunta_con_contexto_agregado(self):
        # El rewriter agrega contexto: los términos de la original sobreviven
        assert self._conserva(
            'y los sábados atienden?',
            '¿Los dermatólogos atienden los sábados en el Centro Médico?',
        )

    def test_sinonimo_tolerado(self):
        # Pierde "saco" pero conserva "turno": 2 términos, tolerancia 0 → debe
        # conservar el término principal
        assert self._conserva('turnos odontologia', 'turnos de odontología en el Centro Médico')

    def test_flexion_no_cuenta_como_perdida(self):
        # "turno" sobrevive dentro de "turnos": la flexión no es deriva
        assert self._conserva('turno kinesiología', 'turnos de kinesiología en el Centro')

    def test_sin_tolerancia_a_perder_terminos(self):
        # Perder un término distintivo YA es señal: con tolerancia, la deriva
        # médico→odontólogo del incidente se colaba (perdía exactamente uno).
        assert not self._conserva(
            'necesito solicitar una férula',
            'necesito una prótesis ortopédica',   # pierde "solicitar" y "ferula"
        )

    # --- Reescrituras que DERIVAN de tema (deben descartarse) ---
    def test_deriva_medico_a_odontologo(self):
        # EL CASO REAL del incidente
        assert not self._conserva(
            '¿puedo elegir libremente mi médico?',
            '¿Puedo elegir libremente cualquier odontólogo de la provincia?',
        )

    def test_deriva_tema_completo(self):
        assert not self._conserva(
            '¿cuánto cuesta el plan materno?',
            '¿Cuáles son los horarios del Centro Médico?',
        )

    def test_pierde_el_sujeto(self):
        assert not self._conserva(
            '¿qué días atiende el traumatólogo?',
            '¿Cuáles son los días de atención?',
        )

    # --- Pronombres que refieren a la organización (2026-09-05) ---
    # "ustedes" no es tema: resolverlo por su referente es el trabajo del
    # rewriter. Antes esta reescritura se descartaba y el bot terminaba
    # atribuyendo el horario de la sede al sujeto que más aparecía en el
    # contexto.
    def test_ustedes_se_resuelve_a_la_organizacion(self):
        assert self._conserva(
            '¿Qué horario de atención tienen ustedes?',
            '¿Cuál es el horario de atención de la Mutual Provincial de Luz y Fuerza?',
        )

    def test_su_direccion_se_resuelve(self):
        assert self._conserva(
            '¿cuál es su dirección?',
            '¿Cuál es la dirección de la organización?',
        )

    def test_resolver_el_pronombre_no_habilita_cambiar_el_tema(self):
        assert not self._conserva(
            '¿Qué horario de atención tienen ustedes?',
            '¿Cuál es la dirección de la organización?',
        )

    # --- Casos borde ---
    def test_pregunta_sin_terminos_distintivos(self):
        assert self._conserva('¿y eso?', 'cualquier cosa')

    def test_reescritura_identica(self):
        assert self._conserva('turno para kinesiología', 'turno para kinesiología')
