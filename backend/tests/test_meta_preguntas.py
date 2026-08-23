"""Detector de meta-preguntas (2026-08-23, caso id_06): preguntas sobre el
PROPIO asistente esquivan el gate documental. Solo patrones de lenguaje —
nunca vocabulario de dominio (contrato multi-tenant)."""

from services.trust_gate import es_meta_pregunta


class TestEsMeta:
    def test_con_quien_estoy_hablando(self):
        assert es_meta_pregunta("¿con quién estoy hablando?")

    def test_quien_sos(self):
        assert es_meta_pregunta("quién sos?")
        assert es_meta_pregunta("¿Quién eres tú?")

    def test_sos_un_bot(self):
        assert es_meta_pregunta("sos un bot o una persona?")
        assert es_meta_pregunta("¿eres una inteligencia artificial?")

    def test_como_te_llamas(self):
        assert es_meta_pregunta("cómo te llamás")
        assert es_meta_pregunta("cual es tu nombre?")

    def test_capacidades(self):
        assert es_meta_pregunta("¿en qué me podés ayudar?")
        assert es_meta_pregunta("que podes hacer?")


class TestNoEsMeta:
    """Preguntas DOCUMENTALES que parecen meta pero no lo son — deben ir al gate."""

    def test_quien_es_un_profesional(self):
        assert not es_meta_pregunta("¿quién es el traumatólogo del centro médico?")

    def test_con_quien_me_comunico(self):
        assert not es_meta_pregunta("¿con quién me comunico para afiliaciones?")

    def test_quien_puede_afiliarse(self):
        assert not es_meta_pregunta("¿quién puede afiliarse a la mutual?")

    def test_que_puedo_hacer_yo(self):
        assert not es_meta_pregunta("¿qué puedo hacer si perdí mi credencial?")

    def test_consulta_comun(self):
        assert not es_meta_pregunta("¿qué días atienden los dermatólogos?")
