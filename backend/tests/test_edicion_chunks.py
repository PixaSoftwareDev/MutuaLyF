"""Tests de la edición de chunks del panel y la reconstrucción del texto vigente.

Cubren los dos bugs hallados el 2026-08-18:
- edit_chunk_text pisaba el parent ENTERO con el texto del fragmento editado
  (destructivo cuando el parent tiene varios fragmentos).
- _texto_vigente reconstruía desde los fragmentos de Qdrant, que se guardan
  con solapamiento → cada reproceso duplicaba las palabras de las costuras.
"""

from api.v1.ingest import (
    _cuerpo_del_fragmento,
    _parent_con_fragmento_editado,
    _sin_prefijos_del_indexador,
)


class TestCuerpoDelFragmento:
    def test_sin_prefijos_queda_igual(self):
        assert _cuerpo_del_fragmento("Texto plano\nsegunda línea") == "Texto plano\nsegunda línea"

    def test_descarta_encabezado_entre_corchetes(self):
        assert _cuerpo_del_fragmento("[5.1 Plan de obra]\nEl plan cubre...") == "El plan cubre..."

    def test_descarta_prefijo_de_contacto(self):
        texto = "[Datos de contacto: teléfono]\nLlamar al (0342) 452-0074."
        assert _cuerpo_del_fragmento(texto) == "Llamar al (0342) 452-0074."

    def test_descarta_ambos_prefijos(self):
        texto = "[Datos de contacto: dirección]\n[Sede central]\nJunín 2961, Santa Fe."
        assert _cuerpo_del_fragmento(texto) == "Junín 2961, Santa Fe."


class TestParentConFragmentoEditado:
    def test_caso_1a1_reemplaza_entero(self):
        # FAQ: parent = pregunta + respuesta; único fragmento = "[pregunta]\nrespuesta"
        parent = "¿Atienden Pediatría?\nSí, cuentan con atención pediátrica."
        viejo = "[¿Atienden Pediatría?]\nSí, cuentan con atención pediátrica."
        nuevo = "[¿Atienden Pediatría?]\nSí, de lunes a viernes de 8 a 15."
        assert _parent_con_fragmento_editado(parent, viejo, nuevo) == \
            "¿Atienden Pediatría?\nSí, de lunes a viernes de 8 a 15."

    def test_caso_1a1_sin_encabezado(self):
        parent = "Texto único del parent."
        assert _parent_con_fragmento_editado(parent, "Texto único del parent.", "Texto corregido.") == \
            "Texto corregido."

    def test_multi_fragmento_conserva_el_resto(self):
        # El bug original: editar el fragmento del medio pisaba TODO el parent.
        parent = (
            "5.2 Martes\n"
            "Nombre: Aguirre Natalia. Especialidad: Psicologia. Horario: 12:20 a 15:50.\n"
            "Nombre: Berardi Cristian. Especialidad: Psiquiatria. Horario: 13:00 a 18:00.\n"
            "Nombre: Zarate Camila. Especialidad: Terapeuta. Horario: 9:00 a 12:00."
        )
        viejo = "[5.2 Martes]\nNombre: Berardi Cristian. Especialidad: Psiquiatria. Horario: 13:00 a 18:00."
        nuevo = "[5.2 Martes]\nNombre: Berardi Cristian. Especialidad: Psiquiatria. Horario: 14:00 a 19:00."
        resultado = _parent_con_fragmento_editado(parent, viejo, nuevo)
        assert resultado is not None
        assert "Horario: 14:00 a 19:00" in resultado
        assert "Aguirre Natalia" in resultado          # el resto sigue ahí
        assert "Zarate Camila" in resultado
        assert "Horario: 13:00 a 18:00" not in resultado

    def test_fragmento_no_ubicable_devuelve_none(self):
        parent = "Contenido del parent que no contiene al fragmento."
        assert _parent_con_fragmento_editado(parent, "texto que no está", "nuevo") is None

    def test_fragmento_viejo_vacio_devuelve_none(self):
        assert _parent_con_fragmento_editado("parent", "", "nuevo") is None

    def test_reemplaza_solo_la_primera_aparicion(self):
        parent = "A repetido. B. A repetido."
        resultado = _parent_con_fragmento_editado(parent, "A repetido.", "A editado.")
        assert resultado == "A editado. B. A repetido."


class TestSinPrefijos:
    def test_conserva_encabezado_sin_corchetes(self):
        # Contrato existente: reconstrucción del documento conserva la pregunta.
        assert _sin_prefijos_del_indexador("[¿Cómo me afilio?]\nCon el CODEM.") == \
            "¿Cómo me afilio?\nCon el CODEM."
