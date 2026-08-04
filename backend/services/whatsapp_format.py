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
_MULTI_BLANK = re.compile(r'\n{3,}')
# Para comparar si el texto de un link es la MISMA dirección que su URL,
# ignorando esquema (http/https) y www. y la barra final.
_SCHEME_WWW = re.compile(r'^(?:https?://)?(?:www\.)?', re.I)


def _norm_url(s: str) -> str:
    return _SCHEME_WWW.sub("", s.strip().lower()).rstrip("/")


def markdown_a_whatsapp(text: str) -> str:
    """Aplana Markdown al formato que WhatsApp entiende. Best-effort y seguro:
    ante texto plano devuelve lo mismo."""
    if not text:
        return text

    # 1) Links: "[texto](url)" → "texto (url)". Casos especiales:
    #    - texto vacío → solo la URL (WhatsApp la autolinkea).
    #    - texto == la MISMA dirección que la URL (aunque una tenga http(s)://
    #      o www. y la otra no) → un SOLO link, sin repetir la dirección entre
    #      paréntesis (reporte Alejo: salía "linkedin.com/x (https://linkedin.com/x)").
    #    - mailto:/tel: → se muestran por su destino legible, sin el prefijo.
    def _flatten_link(m: "re.Match") -> str:
        label = (m.group(1) or "").strip()
        url = m.group(2).strip()
        bare = url
        for scheme in ("mailto:", "tel:"):
            if bare.lower().startswith(scheme):
                bare = bare[len(scheme):]
                break
        if not label:
            return bare
        if _norm_url(label) == _norm_url(bare):
            return label  # texto y URL son la misma dirección → un solo link
        return f"{label} ({bare})"

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
        lines.append(_BULLET.sub(r"\1- ", line))
    text = "\n".join(lines)

    # 3) Negrita **x**/__x__ → *x* (formato WhatsApp).
    text = _BOLD_STARS.sub(r"*\1*", text)
    text = _BOLD_UNDER.sub(r"*\1*", text)

    # 4) Código inline: quitar backticks.
    text = _INLINE_CODE.sub(r"\1", text)

    # 5) Colapsar 3+ saltos de línea seguidos.
    text = _MULTI_BLANK.sub("\n\n", text)

    return text.strip()
