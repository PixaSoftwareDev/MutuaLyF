"""Tests de composición del prompt modular (services/prompt_builder.py).

Validan QUÉ módulos entran según las señales del turno — sin LLM, puro
ensamblado. La regla general es la poda cobarde: ante la duda, el módulo entra.
"""

from services.prompt_builder import (
    REFUSAL_PHRASE,
    PromptInputs,
    build_system_prompt,
    is_small_talk,
    tool_domain_summary,
)


def _build(**kw):
    base = dict(personality="Sos el asistente.", question="¿cuál es el horario de la sede?")
    base.update(kw)
    return build_system_prompt(PromptInputs(**base))


# ── Small talk ────────────────────────────────────────────────────────────────

def test_saludo_puro_es_small_talk():
    for q in ["hola", "Hola!", "buenas tardes", "muchas gracias", "chau", "dale", "buen día"]:
        assert is_small_talk(q), q


def test_consulta_no_es_small_talk():
    for q in ["hola, ¿atienden hoy?", "gracias, y el horario?", "horarios", "¿hola?"]:
        assert not is_small_talk(q), q


def test_small_talk_poda_reglas_pesadas():
    _, modules = _build(question="hola", context_block="(vacío)", has_tools=True)
    assert "tono" in modules and "alcance" in modules and "idioma" in modules
    for pesado in ("grounding", "nombres", "horarios", "urls", "tools"):
        assert pesado not in modules, pesado


# ── Composición normal ────────────────────────────────────────────────────────

def test_consulta_normal_incluye_grounding():
    prompt, modules = _build(context_block="Contexto disponible:\nla sede atiende lunes",
                             context_text="la sede atiende lunes", has_context=True)
    assert "grounding" in modules
    assert "nombres" in modules          # hay contexto → cobarde: entra
    assert "horarios" in modules         # la query menciona horario
    assert "ALCANCE Y FUENTES" in prompt


def test_horarios_entra_por_contexto_aunque_query_no_lo_mencione():
    _, modules = _build(question="¿puedo ir el sábado a cardiología?",
                        context_text="atiende lunes y miércoles de 8 a 12", has_context=True,
                        context_block="Contexto disponible:\natiende lunes y miércoles")
    assert "horarios" in modules


def test_urls_entra_por_query_o_contexto():
    _, m1 = _build(question="¿me pasás el link del formulario?")
    assert "urls" in m1
    _, m2 = _build(question="¿dónde me inscribo?",
                   context_text="inscripción en https://ejemplo.com", has_context=True,
                   context_block="Contexto disponible:\ninscripción en https://ejemplo.com")
    assert "urls" in m2
    _, m3 = _build(question="¿quién es el director?")
    assert "urls" not in m3


def test_sin_contexto_no_entra_nombres():
    _, modules = _build(question="¿quién es el responsable?", has_context=False)
    assert "nombres" not in modules
    assert "grounding" in modules


# ── Alcance dinámico ──────────────────────────────────────────────────────────

def test_alcance_declara_dominios_de_tools():
    prompt, modules = _build(
        has_tools=True,
        tool_domains=["Movies: Películas populares, Buscar película"],
    )
    assert "tools" in modules
    assert "Movies: Películas populares" in prompt
    assert "datos en vivo" in prompt


def test_sin_tools_el_alcance_no_menciona_herramientas():
    prompt, modules = _build(has_tools=False)
    assert "tools" not in modules
    assert "(a) los resultados de tus herramientas" not in prompt
    assert "(a) el bloque \"Contexto disponible\"" in prompt


def test_bot_scope_entra_como_tema_no_como_guion_propio():
    prompt, _ = _build(bot_scope="beneficios y afiliaciones")
    assert "beneficios y afiliaciones" in prompt
    # Un solo guion de rechazo (el del sistema), no el viejo bloque ALCANCE TEMÁTICO.
    assert "ALCANCE TEMÁTICO" not in prompt
    assert prompt.count(REFUSAL_PHRASE) == 1


def test_guion_de_rechazo_mantiene_frase_contrato():
    # La frase la matchean el skip de cache y el trigger de handoff.
    prompt, _ = _build()
    assert REFUSAL_PHRASE == "fuera de mi área de conocimiento"
    assert REFUSAL_PHRASE in prompt


# ── Resumen de dominios ───────────────────────────────────────────────────────

def test_tool_domain_summary_agrupa_por_conector():
    catalog = [
        {"connector_name": "Movies", "display_name": "Películas populares", "slug": "pop"},
        {"connector_name": "Movies", "display_name": "Buscar película", "slug": "search"},
        {"connector_name": "CRM", "display_name": "Mis órdenes", "slug": "ordenes"},
    ]
    out = tool_domain_summary(catalog)
    assert any(s.startswith("CRM: Mis órdenes") for s in out)
    assert any(s.startswith("Movies: Películas populares, Buscar película") for s in out)


def test_tool_domain_summary_trunca_listas_largas():
    catalog = [
        {"connector_name": "CRM", "display_name": f"Tool {i}", "slug": f"t{i}"}
        for i in range(7)
    ]
    (linea,) = tool_domain_summary(catalog)
    assert "y 3 más" in linea


# ── Orden y registro de módulos ───────────────────────────────────────────────

# ── Registro de prompts ───────────────────────────────────────────────────────

def test_registry_es_la_fuente_unica():
    from services.prompt_registry import BUILDER_SLUGS, REGISTRY, default
    # Todo prompt resuelve a texto no vacío (inline o por ref) y declara consumidor.
    for slug, p in REGISTRY.items():
        assert default(slug).strip(), f"{slug}: default vacío (¿ref rota?)"
        assert p.consumer, slug
        assert p.db_name, f"{slug}: todos los prompts deben ser editables (db_name)"
    # Los módulos que compone el builder existen en el registro.
    for slug in BUILDER_SLUGS:
        assert slug in REGISTRY
    # db_name sin duplicados (dos slugs no pueden pisar la misma fila).
    db_names = [p.db_name for p in REGISTRY.values() if p.db_name]
    assert len(db_names) == len(set(db_names))


def test_refs_del_registro_resuelven():
    # Las referencias lazy apuntan a constantes reales de sus módulos.
    from services.prompt_registry import REGISTRY, default
    refs = [p.slug for p in REGISTRY.values() if p.ref]
    assert set(refs) == {"tool_router", "trust_gate_juez", "query_rewriter",
                         "discovery_clasificador", "discovery_rutas"}
    for slug in refs:
        assert len(default(slug)) > 100, slug


def test_quality_gate_default_viene_del_registro():
    from services.groq_client import DEFAULT_PROMPT_QUALITY_GATE
    from services.prompt_registry import default
    assert DEFAULT_PROMPT_QUALITY_GATE == default("quality_gate")
    assert "is_coherent" in DEFAULT_PROMPT_QUALITY_GATE


def test_modules_reporta_lo_que_entro_en_orden():
    _, modules = _build(context_block="Contexto disponible:\nx", context_text="x",
                        has_context=True, facts_note="DATOS VERIFICADOS: y",
                        has_tools=True, tool_domains=["CRM: Órdenes"])
    assert modules.index("tono") == 0
    assert modules.index("alcance") < modules.index("grounding")
    assert modules.index("contexto") < modules.index("tools")
    assert "facts" in modules
    assert modules[-1] == "idioma"
