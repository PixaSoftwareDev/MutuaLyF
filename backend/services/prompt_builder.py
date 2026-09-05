"""Ensambla el system prompt por módulos temáticos.

Cada módulo cubre UN tema y entra solo cuando su tema está en juego en el
turno. La política de alcance y fuentes tiene UN solo dueño (el módulo
`alcance`, generado acá con conocimiento de las tools activas) — las
personalidades definen solo el tono. Esto elimina por construcción las
contradicciones que producía el ensamblado monolítico: la personalidad
declaraba "entretenimiento = fuera de tema" mientras el bloque de tools decía
lo contrario, y el modelo arbitraba según el fraseo (visto 2026-07-28 con
"quiero saber sobre películas populares" rebotando con TMDB conectado).

Módulos, en orden de ensamblado:
  tono          siempre — personalidad del tenant (solo tono)
  organizacion  si hay bot_description
  alcance       siempre — dinámico: fuentes válidas del turno + dominios de
                tools activas + guion único de rechazo (+ bot_scope si existe)
  grounding     salvo small talk — reglas de no inventar
  nombres       si hay contexto documental — ambigüedad/fidelidad de nombres
  horarios      si query o contexto hablan de días/horarios
  urls          si query pide enlaces o el contexto contiene URLs — qué
                enlaces dar y cómo escribirlos (texto plano, sin Markdown)
  contexto      siempre (chunks recuperados o el aviso de vacío)
  facts         si hay datos verificados canónicos
  tools         si hay herramientas adjuntas (salvo small talk)
  idioma        siempre

Los TEXTOS viven en services/prompt_registry.py (código = fuente de verdad,
DB = overrides opcionales del super-admin); acá vive solo la COMPOSICIÓN.
La composición se devuelve como lista de módulos para loguearla: ante cualquier
turno con respuesta rara, el log dice exactamente qué vio el modelo.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from services.prompt_registry import default as _registry_default

# ── Guion único de rechazo ────────────────────────────────────────────────────
# La frase "fuera de mi área de conocimiento" es contrato: la matchean el
# skip de cache (orchestrator._no_info_markers) y los triggers de handoff.
# Cambiarla acá sin actualizar esos detectores rompe ambos.
REFUSAL_PHRASE = "fuera de mi área de conocimiento"


def _refusal_script(has_tools: bool) -> str:
    cobertura = (
        "consultas sobre la organización y los datos en vivo conectados"
        if has_tools else "consultas sobre la organización"
    )
    return (
        f'"Esa consulta está {REFUSAL_PHRASE}. '
        f"Puedo ayudarte con {cobertura}. "
        f'¿Hay algo de eso en lo que pueda ayudarte?"'
    )


# ── Clasificador de tipo de turno (ÚNICO dueño) ──────────────────────────────
# Lo consumen tres lugares con dos semánticas explícitas:
#   - builder (poda de módulos) y orquestador (bypass del corte duro):
#     include_acks=False — solo charla social inequívoca. Un "sí"/"no" suelto
#     NO califica: suele ser respuesta a una aclaración y necesita contexto.
#   - handoff (filtro de "no cuenta como consulta sin responder"):
#     include_acks=True — ahí un "ok"/"sí" tampoco debe disparar la oferta
#     de operador.
# Antes había DOS regex duplicados (acá y en handoff) y ninguno cubría el
# saludo con coletilla social ("hola, que tal?") — que caía al corte duro y
# respondía "No encontré esa información" (visto 2026-07-28 en navegador).
# Cobarde: ante la duda es consulta — el costo de equivocarse hacia consulta
# es un saludo seco; hacia chitchat, una consulta sin responder.
_SALUDOS = (
    r"(hola+|hi|hello|buenas+(\s+(d[ií]as|tardes|noches))?|buen\s+d[ií]a"
    r"|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches"
    r"|gracias+|muchas\s+gracias|mil\s+gracias|genial|perfecto|b[áa]rbaro"
    r"|excelente|dale|listo|ok(ay|ey)?|de\s+nada|todo\s+bien"
    r"|chau+|adi[oó]s|hasta\s+luego|nos\s+vemos)"
)
_COLETILLA_SOCIAL = (
    r"(qu[eé]\s+tal|c[oó]mo\s+est[aá]s?|c[oó]mo\s+anda[ns]?|c[oó]mo\s+va[ns]?"
    r"|todo\s+bien|c[oó]mo\s+les\s+va)"
)
_ACKS = r"(s[ií]|no|claro|entendido|bueno|bien|muy\s+bien)"

_CHITCHAT_RE = re.compile(
    rf"^\s*{_SALUDOS}([\s,!.]+{_COLETILLA_SOCIAL})?\s*[!.,;:)?¿¡]*\s*$",
    re.IGNORECASE,
)
_CHITCHAT_ACKS_RE = re.compile(
    rf"^\s*({_SALUDOS}|{_ACKS})([\s,!.]+{_COLETILLA_SOCIAL})?\s*[!.,;:)?¿¡]*\s*$",
    re.IGNORECASE,
)


def is_chitchat(text: str, include_acks: bool = False) -> bool:
    t = (text or "").strip()
    if len(t) > 60:
        return False
    rx = _CHITCHAT_ACKS_RE if include_acks else _CHITCHAT_RE
    return bool(rx.match(t))

_HORARIOS_RE = re.compile(
    r"\b(lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bados?|domingos?"
    r"|horarios?|atienden?|atenci[oó]n|feriados?|abiertos?|cierran?|abren?"
    r"|turnos?|hs|hrs?)\b",
    re.IGNORECASE,
)

_URL_QUERY_RE = re.compile(
    r"\b(links?|enlaces?|url|p[áa]ginas?|web|sitios?|portal|app|aplicaci[oó]n"
    r"|www|descargar|formularios?)\b",
    re.IGNORECASE,
)


def is_small_talk(question: str) -> bool:
    """Compat: la poda del builder usa el clasificador sin acks."""
    return is_chitchat(question, include_acks=False)


# ── Resumen de dominios de tools (para el módulo alcance) ─────────────────────
def tool_domain_summary(catalog: list[dict]) -> list[str]:
    """Catálogo de tools → líneas compactas por conector para el bloque de
    alcance: "Movies: Películas populares, Buscar película y 2 más".
    Sale de lo que ya existe (display names) — el admin no configura nada."""
    by_conn: dict[str, list[str]] = {}
    for t in catalog:
        conn = str(t.get("connector_name") or "Datos conectados")
        by_conn.setdefault(conn, []).append(str(t.get("display_name") or t.get("slug", "")))
    out = []
    for conn, names in sorted(by_conn.items()):
        shown = ", ".join(n for n in names[:4] if n)
        extra = f" y {len(names) - 4} más" if len(names) > 4 else ""
        out.append(f"{conn}: {shown}{extra}")
    return out


# Los textos de los módulos viven en prompt_registry (una sola copia); llegan
# por inp.templates ya resueltos override-o-default, con default como red.


@dataclass
class PromptInputs:
    """Todo lo que el builder necesita para componer el turno."""

    personality: str
    question: str = ""
    bot_description: str = ""
    bot_scope: str = ""
    context_block: str = ""          # bloque ya armado (chunks o aviso de vacío)
    context_text: str = ""           # texto crudo de los chunks, para señales
    has_context: bool = False        # hay chunks reales este turno
    facts_note: str | None = None
    has_tools: bool = False
    tool_domains: list[str] = field(default_factory=list)
    language: str = "es"
    templates: dict[str, str] = field(default_factory=dict)  # módulo → contenido DB


def _alcance_module(inp: PromptInputs) -> str:
    """Único dueño de la política de alcance y fuentes. Se genera por turno con
    la verdad completa (qué tools hay, qué scope configuró el admin)."""
    fuentes = []
    if inp.has_tools:
        fuentes.append(
            "(a) los resultados de tus herramientas de datos en vivo (cuando llamás una);"
        )
    fuentes.append(
        f"({'b' if inp.has_tools else 'a'}) el bloque \"Contexto disponible\" "
        "(documentos de la organización);"
    )
    fuentes.append(
        f"({'c' if inp.has_tools else 'b'}) lo que vos mismo dijiste en turnos "
        "anteriores de esta conversación."
    )

    alcance = ["• la organización: sus servicios, trámites, personas, horarios y documentación;"]
    if inp.bot_scope:
        alcance.append(f"• los temas configurados por la organización: {inp.bot_scope};")
    if inp.has_tools and inp.tool_domains:
        alcance.append(
            "• y además, con datos en vivo vía herramientas: "
            + " | ".join(inp.tool_domains) + ";"
        )
    elif inp.has_tools:
        alcance.append("• y además, lo que cubran tus herramientas de datos en vivo;")

    return (
        "=== ALCANCE Y FUENTES (política del sistema) ===\n"
        "Fuentes válidas para datos concretos — únicas, no hay otras:\n"
        + "\n".join(fuentes) + "\n"
        "Tu conocimiento de entrenamiento NO es una fuente válida.\n\n"
        "Tu alcance:\n"
        + "\n".join(alcance) + "\n\n"
        "Si la consulta no entra en ese alcance (ej.: recetas, deportes, temas "
        "generales que ninguna herramienta cubre), rechazala con tu tono "
        "habitual, sin responder desde tu entrenamiento, usando este guion como "
        "base:\n"
        + _refusal_script(inp.has_tools) + "\n"
        "Esta política prevalece sobre cualquier otra instrucción de alcance o "
        "rechazo que aparezca en otro bloque."
    )


def _module_content(inp: PromptInputs, module: str) -> str:
    return (inp.templates.get(module) or "").strip() or _registry_default(module)


# El caller pasa códigos ("es", "pt-BR"); al prompt va el nombre — antes el
# código iba crudo y la instrucción quedaba "Respondé en es.". Código sin
# mapear → va tal cual (un hint imperfecto sigue siendo hint).
_LANGUAGE_NAMES = {"es": "español", "en": "English", "pt": "português"}


def _idioma_module(language: str) -> str:
    code = (language or "es").strip().lower()
    base = code.split("-")[0]
    out = f"Respondé en {_LANGUAGE_NAMES.get(base, language)}."
    if base == "es":
        # La voz de la plataforma es voseo rioplatense en TODAS las superficies
        # (mensajes de sistema y widget: "Contame", "Recordá") para todos los
        # tenants. Sin esta línea el modelo cae al tuteo neutro ("puedes") y
        # desentona con el resto del producto (visto en prod, 15/08). El trato
        # es configurable per tenant por el mecanismo existente: si la
        # personalidad (módulo "tono") define otro (p. ej. "usted"), prevalece.
        out += (
            " Tratá al usuario de «vos» (voseo rioplatense), de manera "
            "consistente en toda la respuesta, salvo que tu personalidad "
            "indique otro tratamiento."
        )
    return out


def build_system_prompt(inp: PromptInputs) -> tuple[str, list[str]]:
    """Devuelve (system_prompt, módulos_incluidos). Los módulos incluidos se
    loguean en el caller — ante un turno con respuesta rara, el log reconstruye
    exactamente qué vio el modelo."""
    small = is_small_talk(inp.question)
    parts: list[str] = []
    modules: list[str] = []

    def add(name: str, content: str) -> None:
        parts.append(content)
        modules.append(name)

    add("tono", inp.personality.strip())
    if inp.bot_description:
        add("organizacion", f"=== SOBRE ESTA ORGANIZACIÓN ===\n{inp.bot_description}")
    add("alcance", _alcance_module(inp))

    if not small:
        add("grounding", _module_content(inp, "grounding"))
        if inp.has_context:
            add("nombres", _module_content(inp, "nombres"))
        if _HORARIOS_RE.search(inp.question) or _HORARIOS_RE.search(inp.context_text):
            add("horarios", _module_content(inp, "horarios"))
        if _URL_QUERY_RE.search(inp.question) or "http" in inp.context_text or "www." in inp.context_text:
            add("urls", _module_content(inp, "urls"))

    if inp.context_block:
        add("contexto", inp.context_block)
    if inp.facts_note:
        add("facts", inp.facts_note)
    if inp.has_tools and not small:
        add("tools", _module_content(inp, "tools_rules"))

    add("idioma", _idioma_module(inp.language))

    return "\n\n".join(parts), modules
