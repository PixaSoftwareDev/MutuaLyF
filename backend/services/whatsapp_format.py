"""Conversión de Markdown → formato de WhatsApp.

El bot genera Markdown (lo mismo que el widget renderiza lindo): `**negrita**`,
`[texto](url)`, encabezados `##`, viñetas `*`. WhatsApp NO renderiza Markdown —
muestra los símbolos crudos ("los links se forman mal", reporte Gustavo). Su
formato propio es distinto: negrita con UN asterisco `*x*`, itálica `_x_`, y las
URLs sueltas se autolinkean (los links Markdown hay que aplanarlos).

Esta conversión se aplica en `send_text` (único punto de salida a Meta) para que
al afiliado le llegue texto limpio. Es idempotente sobre texto plano: sin
Markdown, no cambia nada.
"""

import re

# [texto](url)  ó  [texto](<url> "title")  → capturamos label y url
_LINK = re.compile(r'\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)')
# ***negrita+itálica*** (triple) → *x*. DEBE ir antes que el doble, si no el
# doble deja un asterisco suelto ("**x**" literal en WhatsApp).
_BOLD_ITALIC = re.compile(r'\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*')
# **negrita** y __negrita__ (Markdown) → *negrita* (WhatsApp). Sin `*`/`_` adentro.
_BOLD_STARS = re.compile(r'\*\*(?=\S)(.+?)(?<=\S)\*\*')
_BOLD_UNDER = re.compile(r'__(?=\S)(.+?)(?<=\S)__')
# Regla horizontal: línea de solo ---, ***, ___ (3+)
_HR = re.compile(r'^\s*([-*_])\1{2,}\s*$')
# Encabezado ATX: #..###### Título  (con o sin # de cierre)
_HEADER = re.compile(r'^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$')
# Código inline `x` — WhatsApp no tiene monospace inline, quitamos backticks
_INLINE_CODE = re.compile(r'`([^`]+)`')
# Viñeta Markdown al inicio de línea: "* item" ó "+ item" → "- item"
_BULLET = re.compile(r'^(\s*)[*+]\s+')
# Cita Markdown "> texto": WhatsApp no la renderiza, muestra el ">" crudo → lo quitamos.
_BLOCKQUOTE = re.compile(r'^\s*>\s?')
_MULTI_BLANK = re.compile(r'\n{3,}')


def markdown_a_whatsapp(text: str) -> str:
    """Aplana Markdown al formato que WhatsApp entiende. Best-effort y seguro:
    ante texto plano devuelve lo mismo."""
    if not text:
        return text

    # 1) Links: "[texto](url)" → SIEMPRE solo la URL, descartando el texto
    #    (decisión Alejo: uniforme en todos los casos y confiable al tocar —
    #    antes salía a veces "texto (url)" y a veces la URL pelada según cómo
    #    etiquetara el bot). La URL conserva su http(s):// para que WhatsApp la
    #    abra directo (sin scheme el redirect disparaba captchas). mailto:/tel:
    #    se muestran por su destino legible, sin el prefijo.
    def _flatten_link(m: "re.Match") -> str:
        url = m.group(2).strip()
        for scheme in ("mailto:", "tel:"):
            if url.lower().startswith(scheme):
                return url[len(scheme):]
        return url

    text = _LINK.sub(_flatten_link, text)

    # 2) Línea por línea: encabezados, reglas horizontales, viñetas.
    #    (Las viñetas se normalizan ANTES de tocar la negrita para que un
    #    "* item" no se confunda con un asterisco de énfasis.)
    lines = []
    for line in text.split("\n"):
        if _HR.match(line):
            continue  # las reglas horizontales no aportan nada en WhatsApp
        h = _HEADER.match(line)
        if h:
            titulo = h.group(1).strip()
            lines.append(f"*{titulo}*" if titulo else "")
            continue
        line = _BLOCKQUOTE.sub("", line)
        lines.append(_BULLET.sub(r"\1- ", line))
    text = "\n".join(lines)

    # 3) Negrita: primero el triple (***), después el doble (**) y __.
    text = _BOLD_ITALIC.sub(r"*\1*", text)
    text = _BOLD_STARS.sub(r"*\1*", text)
    text = _BOLD_UNDER.sub(r"*\1*", text)

    # 4) Código inline: quitar backticks.
    text = _INLINE_CODE.sub(r"\1", text)

    # 5) Colapsar 3+ saltos de línea seguidos.
    text = _MULTI_BLANK.sub("\n\n", text)

    return text.strip()
