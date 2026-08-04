"""Tests de la conversión Markdown → WhatsApp (services.whatsapp_format)."""

from services.whatsapp_format import markdown_a_whatsapp


def test_link_con_texto_distinto():
    r = markdown_a_whatsapp("Turnos en [el portal](https://mimutual.com.ar/turnos)")
    assert r == "Turnos en el portal (https://mimutual.com.ar/turnos)"


def test_link_texto_igual_a_url_queda_solo_url():
    r = markdown_a_whatsapp("Web: [https://mimutual.com.ar](https://mimutual.com.ar)")
    assert r == "Web: https://mimutual.com.ar"


def test_link_con_title_se_ignora():
    r = markdown_a_whatsapp('[Contacto](https://x.com/c "Ir a contacto")')
    assert r == "Contacto (https://x.com/c)"


def test_link_texto_es_misma_url_sin_scheme_no_se_duplica():
    # Caso real (Enzo): el texto es la URL sin https:// → un solo link, no duplicado
    r = markdown_a_whatsapp("[linkedin.com/in/enzo-italo-batistelli-5516b1177](https://linkedin.com/in/enzo-italo-batistelli-5516b1177)")
    assert r == "linkedin.com/in/enzo-italo-batistelli-5516b1177"
    assert "(" not in r  # sin paréntesis con la dirección repetida


def test_link_texto_con_www_igual_a_url():
    r = markdown_a_whatsapp("[www.pixs.dev](https://pixs.dev)")
    assert r == "www.pixs.dev"


def test_link_mailto_muestra_email_sin_scheme():
    r = markdown_a_whatsapp("Escribinos a [soporte@mimutual.com.ar](mailto:soporte@mimutual.com.ar)")
    assert r == "Escribinos a soporte@mimutual.com.ar"


def test_link_tel_muestra_numero_sin_scheme():
    r = markdown_a_whatsapp("[Llamar](tel:+543424520074)")
    assert r == "Llamar (+543424520074)"


def test_negrita_doble_asterisco():
    assert markdown_a_whatsapp("El horario es **de 8 a 14hs**") == "El horario es *de 8 a 14hs*"


def test_negrita_italica_triple_asterisco():
    # ***x*** no debe dejar asteriscos crudos ("**x**" literal en WhatsApp)
    r = markdown_a_whatsapp("Esto es ***muy importante*** che")
    assert r == "Esto es *muy importante* che"
    assert "**" not in r


def test_cita_blockquote_se_limpia():
    assert markdown_a_whatsapp("> Esto es una cita\nNormal") == "Esto es una cita\nNormal"


def test_negrita_underscore():
    assert markdown_a_whatsapp("__Importante__: traer DNI") == "*Importante*: traer DNI"


def test_encabezado_a_negrita():
    assert markdown_a_whatsapp("## Autorizaciones\nTexto") == "*Autorizaciones*\nTexto"


def test_vinetas_asterisco_a_guion():
    r = markdown_a_whatsapp("Documentación:\n* DNI\n* Carnet\n+ Orden médica")
    assert r == "Documentación:\n- DNI\n- Carnet\n- Orden médica"


def test_vineta_no_se_confunde_con_negrita():
    # "* DNI" es viñeta, no el comienzo de una negrita
    r = markdown_a_whatsapp("* DNI\n* Carnet")
    assert r == "- DNI\n- Carnet"


def test_regla_horizontal_se_elimina():
    assert markdown_a_whatsapp("Arriba\n---\nAbajo") == "Arriba\nAbajo"


def test_codigo_inline_pierde_backticks():
    assert markdown_a_whatsapp("Escribí `hola` para empezar") == "Escribí hola para empezar"


def test_telefono_en_parentesis_intacto():
    # Los teléfonos de los docs NO son links Markdown, no deben tocarse
    txt = "Llamá al (0342) 452-0074/75 de 8 a 14hs"
    assert markdown_a_whatsapp(txt) == txt


def test_texto_plano_no_cambia():
    txt = "Hola, ¿en qué puedo ayudarte hoy?"
    assert markdown_a_whatsapp(txt) == txt


def test_vacio_y_none_safe():
    assert markdown_a_whatsapp("") == ""
    assert markdown_a_whatsapp(None) is None


def test_colapsa_saltos_multiples():
    assert markdown_a_whatsapp("A\n\n\n\nB") == "A\n\nB"


def test_caso_realista_completo():
    entrada = (
        "## Autorización de prácticas\n"
        "Para autorizar necesitás:\n"
        "* DNI\n"
        "* **Orden médica** vigente\n\n"
        "Más info en [el portal](https://mimutual.com.ar). "
        "Consultas al (0342) 452-0074."
    )
    salida = markdown_a_whatsapp(entrada)
    assert "*Autorización de prácticas*" in salida
    assert "- DNI" in salida
    assert "*Orden médica*" in salida
    assert "el portal (https://mimutual.com.ar)" in salida
    assert "(0342) 452-0074" in salida
    assert "##" not in salida and "**" not in salida and "](" not in salida
