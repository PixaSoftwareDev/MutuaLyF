"""Registro único de prompts del sistema.

MODELO (decisión 2026-07-28): el CÓDIGO es la fuente de verdad — cada prompt
vive acá, versionado por git, con una sola copia. La DB
(`system_prompt_templates`) es una capa de OVERRIDES opcional: un prompt tiene
override solo si existe una fila ACTIVA cuyo `nombre` coincide con su
`db_name`; sin fila, rige el default de este archivo. Se acabaron las
migraciones de contenido y la triple copia (fallback en código + migración +
fila DB).

TODOS los prompts del registro son editables desde el panel del super-admin
(decisión 2026-07-28): cada entrada tiene un `db_name` y su override pisa al
default. El texto default vive o bien acá (`text`) o bien junto a su
consumidor referenciado con `ref="modulo:CONSTANTE"` — refs para los prompts
cuyo texto está entretejido con la lógica que lo rodea (discovery, router);
el registro los resuelve lazy, así que siguen siendo una sola copia.

Qué NO vive acá:
  - Las personalidades (tono): son contenido por tenant, elegibles/editables
    desde el panel — siguen en `system_prompt_templates` con is_system=FALSE.
  - El bloque de alcance: es dinámico por turno (prompt_builder._alcance_module).

Política de alta: un prompt nuevo requiere un consumidor nuevo o una condición
de entrada nueva en el builder. Si un caso límite nuevo no amerita condición
propia, es una regla más dentro de `grounding` — el prompt de un turno no
debería pasar de ~10 módulos.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PromptDef:
    slug: str
    consumer: str               # dónde se usa
    text: str | None = None     # default inline…
    ref: str | None = None      # …o referencia lazy "services.modulo:CONSTANTE"
    db_name: str | None = None  # nombre de la fila de override en DB
    descripcion: str = ""


# ── Camino de respuesta: módulos con override ────────────────────────────────

_GROUNDING = (
    "REGLAS DE GROUNDING — aplican a todo dato concreto que respondas "
    "(nombres, fechas, números, montos, direcciones, contactos, plazos, pasos):\n\n"
    "1. FUENTE ÚNICA: usá exclusivamente las fuentes válidas del bloque "
    "\"ALCANCE Y FUENTES\". Si un dato no aparece en ninguna, para vos no existe.\n"
    "2. COINCIDENCIA SEMÁNTICA: aceptá sinónimos y variantes léxicas cuando el "
    "referente es claramente el mismo (empleado/trabajador, sucursal/sede, "
    "licencia/permiso). No rechaces información válida por diferencia de palabras.\n"
    "3. SIN INFERENCIAS: si las fuentes mencionan un tema relacionado pero no el "
    "dato exacto, no lo completes con lógica ni suposiciones — el dato debe estar "
    "explícitamente presente.\n"
    "4. INFORMACIÓN PARCIAL: si encontrás datos relevantes pero incompletos, "
    "respondé con lo que tenés y aclará qué parte no encontraste. No inventes el resto.\n"
    "5. FUENTES EN CONFLICTO: si dos fuentes se contradicen sobre el mismo punto, "
    "mencioná ambas versiones y recomendá confirmar con el área responsable.\n"
    "6. SIN INFORMACIÓN: si el dato no aparece en ninguna fuente válida (y ninguna "
    "herramienta lo cubre), respondé exactamente:\n"
    "\"No encontré esa información en las fuentes disponibles. Te recomiendo "
    "consultar directamente con el área correspondiente.\"\n"
    "7. NUNCA INVENTES: inventar un dato concreto, aunque parezca razonable, es el "
    "error más grave que podés cometer.\n"
    "8. ESTADO DEL SISTEMA Y OPERADORES: nunca afirmes por tu cuenta si hay o no "
    "operadores/personas disponibles, ni el estado de la fila de atención, ni si un "
    "aviso anterior del sistema sigue vigente — esa información cambia en tiempo real "
    "y vos no la conocés; los avisos de sistema del historial describen un momento "
    "pasado. Si piden hablar con una persona, respondé que podés derivar la consulta "
    "y el sistema la pondrá en la fila — la disponibilidad la resuelve el sistema, no vos."
)
# La regla 8 porta la "Regla 13" de la migración 046_no_afirmar_estado_sistema
# (rama dev): esa migración apendea al blob "Reglas anti-alucinación" que la 049
# elimina — sin este port, la feature moría en la limpieza del registro.
# Nota: la política de CITADO de fuentes no vive acá — es una decisión de tono
# y la define cada personalidad (la profesional exige cita siempre; la estándar
# solo ante posible confusión). Tenerla en ambos lados generaba instrucciones
# contradictorias cuando la personalidad activa pedía otra cosa.

_NOMBRES = (
    "NOMBRES Y ENTIDADES:\n"
    "• AMBIGÜEDAD: si el usuario menciona un nombre o referencia y el Contexto "
    "contiene VARIAS entidades que coinciden (dos personas con el mismo apellido, "
    "dos elementos con el mismo nombre), NO elijas una sola ni mezcles sus datos: "
    "presentá TODAS las coincidencias por separado, distinguidas por su atributo "
    "diferenciador (especialidad, rol, categoría).\n"
    "• DATO CON VARIOS DUEÑOS: si el Contexto trae el mismo TIPO de dato "
    "(contacto, dirección, horario, precio) para VARIOS sujetos — la "
    "organización, un producto, una sede —, respondé con el del sujeto que la "
    "consulta pide y decí de quién es. \"Nuestro\", \"de ustedes\" o \"de la "
    "organización\" refieren a la ORGANIZACIÓN, no a sus productos. Si no está "
    "claro cuál piden, dá cada dato etiquetado con su dueño — nunca elijas uno "
    "en silencio.\n"
    "• FIDELIDAD: no alteres las LETRAS de los nombres propios — no cambies, "
    "agregues ni quites letras ni acentos respecto del Contexto. Podés normalizar "
    "la capitalización (Mayúscula Inicial). Cambiar una letra de un apellido es un "
    "error grave."
)

_HORARIOS = (
    "DISPONIBILIDAD EN UN DÍA U HORARIO:\n"
    "Si preguntan si algo o alguien está disponible un día u horario específico y "
    "el Contexto tiene los días/horarios de atención, respondé comparando: si el "
    "día consultado NO figura entre los horarios listados, la respuesta es que NO "
    "atiende ese día (\"No, atiende [días reales]\"). Que un día no aparezca NO es "
    "\"falta de información\": es un no. Aplica también con varios elementos del "
    "mismo tipo: si ninguno cubre ese día, decilo."
)

_URLS = (
    "URLS Y ENLACES:\n"
    "• QUÉ enlaces dar: nunca escribas una URL que no aparezca TEXTUALMENTE en el "
    "Contexto o en un mensaje anterior tuyo de esta conversación. No construyas ni "
    "deduzcas direcciones a partir del nombre de un sitio o aplicación (que el "
    "portal se llame \"Mi Ejemplo Web\" NO significa que exista "
    "www.miejemplo.com.ar). Un enlace inventado puede llevar a un sitio falso: es "
    "tan grave como inventar un teléfono. Si piden un enlace que no está en el "
    "Contexto, decí que no tenés el enlace exacto y ofrecé la vía que sí figure "
    "(sitio oficial, teléfono o área de contacto).\n"
    "• CÓMO escribirlos: la URL completa en texto plano (por ejemplo "
    "https://www.ejemplo.com/pagina). NUNCA uses formato Markdown de enlaces como "
    "[texto](url): no se renderiza en WhatsApp ni en el chat y queda con "
    "corchetes y paréntesis a la vista."
)

# Frontera tools/documentos — redacción ÚNICA compartida por las reglas de
# herramientas (llamada unificada) y el router del fallback. Antes vivía
# duplicada con distinta redacción en ambos y era cuestión de tiempo que
# divergieran (mismo patrón que el bug de las personalidades).
# OJO al editar: los ejemplos explícitos de "contacto propio vs contactos del
# sistema" son la parte que trabaja — una versión resumida de esta frontera
# hizo rutear "el mail del comercial" a la tool de clientes (4 dangerous_fp en
# eval_tool_routing, 2026-07-28). Ese eval es la regresión de este texto.
FRONTERA_TOOLS_DOCS = (
    "Frontera entre herramientas y documentos: los datos VIVOS del sistema "
    "conectado (cuentas, pedidos, turnos, saldos, listados internos) salen de "
    "las herramientas. La información sobre la organización misma sale de los "
    "documentos institucionales, NUNCA de una herramienta: qué es y qué ofrece, "
    "quiénes la integran (quién es alguien, su rol, su experiencia, qué sabe o "
    "en qué trabaja) y los "
    "datos de contacto PROPIOS — el email, teléfono o WhatsApp del equipo, de "
    "un área (comercial, ventas, soporte) o de la organización entera. No "
    "confundas esos contactos propios con los contactos o clientes que una "
    "herramienta lista: esos registros son TERCEROS cargados en el sistema, "
    "no la organización."
)

# ── Camino de respuesta: textos estáticos (sin override) ─────────────────────

_TOOLS_RULES = (
    "=== DATOS EN VIVO (HERRAMIENTAS) — TIENEN PRIORIDAD ===\n"
    "Tenés herramientas adjuntas que consultan datos EN VIVO de sistemas "
    "conectados por la organización. Lo que cada una cubre está en su "
    "descripción. REGLAS:\n"
    "• Lo que una herramienta cubre está dentro de tu alcance (ya figura en "
    "ALCANCE Y FUENTES): usá la herramienta. NUNCA digas que el tema está fuera "
    "de tu área ni que no tenés información si una herramienta lo cubre.\n"
    "• Si nombra el SISTEMA conectado o su dominio pero sin decir qué dato "
    "quiere («necesito datos del CRM», «algo del sistema de turnos»), no lo "
    "rechaces ni inventes: ofrecé en una línea qué podés traerle de ese sistema "
    "y pedile que elija.\n"
    "• Si la consulta está en PRIMERA PERSONA o pide algo PROPIO del usuario "
    "(«mi/mis/mío», «yo», «cuánto tengo», «cómo vengo», «qué me falta»), "
    "DEBÉS llamar la herramienta que corresponda. NUNCA respondas eso desde "
    "el contexto documental ni digas que no lo encontraste: esos datos SOLO "
    "están en la herramienta.\n"
    "• Si pide el estado ACTUAL, la lista VIVA o la CANTIDAD de algo que una "
    "herramienta lista («cuántos X hay», «cuántas X existen»), llamá la "
    "herramienta aunque el contexto documental mencione algo parecido: el "
    "contexto puede estar incompleto o desactualizado. NUNCA ofrezcas "
    "buscarlo como pregunta («¿querés que lo busque?»): buscalo y respondé.\n"
    "• El pedido puede venir como INTENCIÓN y no como pregunta («quiero ver los "
    "pedidos», «mostrame las órdenes», «necesito el listado»). Si el objeto "
    "pedido es EXACTAMENTE lo que lista una herramienta, llamala: que esté "
    "redactado como deseo no lo vuelve tema documental. Esto NO aplica a "
    "consultas sobre personas, servicios o conocimiento de la organización.\n"
    "• REPREGUNTAS sobre datos que ya trajiste con una herramienta (un total, un "
    "conteo, «y cuántos son», «cuánto suma», «y el segundo»): volvé a llamar la "
    "herramienta. Tu respuesta anterior fue un RESUMEN para leer, no la fuente: "
    "puede haber mostrado solo algunos ítems, y contar sobre ella da números "
    "equivocados con cara de certeza.\n"
    "• " + FRONTERA_TOOLS_DOCS
)

# ── Pipelines internos (código puro, cambios con deploy + tests) ─────────────
# Texto heredado de la fila DB "Validador de documentos" (la versión curada de
# la migración 006) — la fila se elimina en la migración 046.

_QUALITY_GATE = (
    "Sos un filtro de ruido para fragmentos de documentos. Tu única tarea es "
    "detectar si el fragmento tiene información que un lector humano pueda "
    "aprovechar. No importa el tema — técnico, legal, institucional, operativo, "
    "lo que sea.\n\n"
    "APROBÁ (is_coherent: true) si el fragmento contiene:\n"
    "- Texto coherente con información factual, descriptiva o instructiva\n"
    "- Nombres, fechas, cifras, contactos, roles o procesos — aunque esté incompleto\n"
    "- Definiciones, normativas, procedimientos, especificaciones o instrucciones\n"
    "- Tablas con datos o listas con ítems descriptivos\n"
    "- Contenido parcial que claramente pertenece a un documento más largo\n\n"
    "RECHAZÁ (is_coherent: false) SOLO si el fragmento es ruido puro sin valor:\n"
    "- Solo números de página (ej: \"— 47 —\") sin texto acompañante\n"
    "- Solo encabezados o pies de página repetidos sin cuerpo (ej: \"Confidencial | Versión 2.1\")\n"
    "- Texto ilegible por OCR fallido: caracteres aleatorios, símbolos sin sentido\n"
    "- Contenido vacío o en blanco\n"
    "- Línea única de título sin ningún cuerpo (ej: solo \"CAPÍTULO 3\")\n"
    "- Entradas de índice sin descripción (ej: \"3.1 Introducción ........... 12\")\n\n"
    "EN CASO DE DUDA: aprobá. Es preferible indexar contenido imperfecto que "
    "perder información.\n\n"
    "Respondé ÚNICAMENTE con JSON válido:\n"
    "{\"is_coherent\": true/false, \"confidence\": 0.0-1.0, \"reason\": \"una oración en español\"}\n\n"
    "Confianza: 0.9+ cuando es claramente útil o claramente ruido. 0.5-0.8 para "
    "contenido mixto o parcial."
)


REGISTRY: dict[str, PromptDef] = {
    p.slug: p
    for p in [
        PromptDef("grounding", "respuesta (prompt_builder)", text=_GROUNDING,
                  db_name="Grounding documental",
                  descripcion="Núcleo de reglas de no-invención; las fuentes las define el bloque ALCANCE Y FUENTES"),
        PromptDef("nombres", "respuesta (prompt_builder)", text=_NOMBRES,
                  db_name="Casos límite: nombres",
                  descripcion="Ambigüedad y fidelidad de nombres propios; entra con contexto documental"),
        PromptDef("horarios", "respuesta (prompt_builder)", text=_HORARIOS,
                  db_name="Casos límite: horarios",
                  descripcion="Disponibilidad por día/horario; entra si query o contexto hablan de días/horarios"),
        PromptDef("urls", "respuesta (prompt_builder)", text=_URLS,
                  db_name="Casos límite: URLs",
                  descripcion="Enlaces: cuáles dar (solo los textuales del contexto) y cómo escribirlos (texto plano, sin Markdown); entra si piden links o el contexto trae URLs"),
        PromptDef("tools_rules", "respuesta (prompt_builder)", text=_TOOLS_RULES,
                  db_name="Reglas de herramientas",
                  descripcion="Reglas de uso de herramientas de datos en vivo; comparte la frontera tools/docs con el router"),
        PromptDef("quality_gate", "ingesta (groq_client.complete_quality_gate)", text=_QUALITY_GATE,
                  db_name="Validador de documentos",
                  descripcion="Filtro de ruido de chunks en la ingesta; debe seguir devolviendo el JSON {is_coherent, confidence, reason}"),
        PromptDef("tool_router", "ruteo (orchestrator._try_tool_pick vía select_tool)",
                  ref="services.connector_router:TOOL_ROUTER_SYSTEM",
                  db_name="Router de tools",
                  descripcion="Decide tool-vs-RAG en el fallback duro; eval_tool_routing.py mide este texto"),
        PromptDef("trust_gate_juez", "retrieval (trust_gate)",
                  ref="services.trust_gate:_JUDGE_SYSTEM",
                  db_name="Juez de relevancia (trust gate)",
                  descripcion="Decide qué fragmentos recuperados responden la pregunta; debe devolver el JSON {responden, motivo}"),
        PromptDef("query_rewriter", "retrieval (query_rewriter)",
                  ref="services.query_rewriter:_REWRITE_SYSTEM_PROMPT",
                  db_name="Reescritor de consultas",
                  descripcion="Reescribe la query con sinónimos/contexto. OJO: mantener {n}, {org_context} y las llaves dobles {{}} del JSON"),
        PromptDef("discovery_clasificador", "conectores (connector_discovery.classify_routes)",
                  ref="services.connector_discovery:_CLASSIFY_SYSTEM",
                  db_name="Discovery: clasificador de rutas",
                  descripcion="Clasifica las rutas del proveedor (include, identidad, lookup); debe devolver el JSON array documentado"),
        PromptDef("discovery_rutas", "conectores (connector_discovery.routes_from_document)",
                  ref="services.connector_discovery:_EXTRACT_ROUTES_SYSTEM",
                  db_name="Discovery: extractor de rutas",
                  descripcion="Extrae rutas GET desde la documentación del proveedor; debe devolver el JSON array documentado"),
    ]
}

# Módulos que compone prompt_builder (subset que carga el orquestador por turno).
BUILDER_SLUGS = ["grounding", "nombres", "horarios", "urls", "tools_rules"]

# Compat: todos los prompts del registro admiten override.
OVERRIDABLE_SLUGS = [s for s, p in REGISTRY.items() if p.db_name]


def default(slug: str) -> str:
    """Texto default (código) de un prompt del registro. Los `ref` se resuelven
    lazy (import del módulo consumidor) — nunca rompe: ante error devuelve ""."""
    p = REGISTRY[slug]
    if p.text is not None:
        return p.text
    try:
        import importlib

        module_name, attr = (p.ref or "").split(":")
        return getattr(importlib.import_module(module_name), attr)
    except Exception:
        return ""


_CACHE_TTL = 300  # 5 min — mismo criterio que el resto de los caches de prompts


async def _load_override(db_name: str) -> str | None:
    """Fila activa en system_prompt_templates con ese nombre (cualquier origen).
    Redis-cached; ante cualquier fallo devuelve None → rige el default."""
    from core.database import get_redis_cache

    redis = get_redis_cache()
    cache_key = f"platform:prompt_override:{db_name}"
    try:
        raw = await redis.get(cache_key)
        if raw is not None:
            return raw.decode() or None
    except Exception:
        pass

    contenido: str | None = None
    try:
        from sqlalchemy import text

        from core.database import get_pg_session
        async with get_pg_session(None) as session:
            row = (await session.execute(text("""
                SELECT contenido FROM system_prompt_templates
                WHERE nombre = :nombre AND is_active = TRUE
                LIMIT 1
            """), {"nombre": db_name})).fetchone()
            contenido = row[0] if row else None
    except Exception:
        return None

    try:
        await redis.setex(cache_key, _CACHE_TTL, contenido or "")
    except Exception:
        pass
    return contenido


async def get_text(slug: str) -> str:
    """Texto final de un prompt: override DB si existe, si no el default
    (inline o resuelto por ref)."""
    p = REGISTRY[slug]
    if p.db_name:
        override = await _load_override(p.db_name)
        if override and override.strip():
            return override
    return default(slug)


async def get_texts(slugs: list[str]) -> dict[str, str]:
    import asyncio

    values = await asyncio.gather(*(get_text(s) for s in slugs))
    return dict(zip(slugs, values))
