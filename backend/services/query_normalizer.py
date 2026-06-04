"""Query normalization: expand acronyms and abbreviations before embedding.

Runs in microseconds — pure Python, no model calls.
Applied before semantic cache lookup and retrieval so that "RRHH" and
"Recursos Humanos" land in the same embedding space.

DISEÑO (post auditoría de casuística, 2026-06):
- **Case-sensitive a propósito.** Solo se expande una sigla si el usuario la
  escribió EN MAYÚSCULAS ("TI" sí, "ti" no). Sin esto, `re.IGNORECASE` hacía
  que palabras españolas comunes ("ti", "it", "art") matchearan siglas y se
  reemplazaran, deformando la consulta antes de embedear/clasificar/cachear.
  Regla de oro: ante la duda, NO tocar el input del usuario.
- **Diccionario base mínimo e inequívoco.** Solo siglas legales/laborales
  argentinas que casi nunca colisionan con palabras (DNI, CUIT, AFIP…). Las
  siglas de oficina/tech (TI, IT, UX, QA, CEO…) y las abreviaturas con punto
  ("art.", "inc.", "cf.") se sacaron: eran ambiguas y de un vertical que no es
  el de los tenants.
- **Lo específico de cada cliente va por tenant**, no acá: pasar `extra_acronyms`
  (futuro: poblado desde la config del tenant en el panel admin).
"""

import re

# ── Base acronym dictionary ────────────────────────────────────────────────────
# Keys: forma canónica EN MAYÚSCULAS. El match es case-sensitive (ver _build_pattern),
# así que estas claves solo disparan cuando el usuario escribe la sigla en mayúsculas.
# Criterio para estar acá: inequívoca (no colisiona con una palabra española común)
# y útil para el dominio de los tenants (mutuales / org. laborales argentinas).
_BASE_ACRONYMS: dict[str, str] = {
    # Áreas
    "RRHH":   "Recursos Humanos",
    "RRHH.":  "Recursos Humanos",
    "RR.HH.": "Recursos Humanos",
    "RRLL":   "Relaciones Laborales",
    "RR.LL.": "Relaciones Laborales",

    # Identificación / bancario
    "DNI":    "documento nacional de identidad",
    "CUIL":   "Clave Única de Identificación Laboral",
    "CUIT":   "Clave Única de Identificación Tributaria",
    "CBU":    "Clave Bancaria Uniforme",

    # Laboral / previsional
    "ART":    "Aseguradora de Riesgos del Trabajo",
    "SAC":    "sueldo anual complementario",
    "LCT":    "Ley de Contrato de Trabajo",
    "CCT":    "Convenio Colectivo de Trabajo",
    "SMVM":   "salario mínimo vital y móvil",
    "AUH":    "Asignación Universal por Hijo",

    # Impositivo / organismos
    "IVA":    "Impuesto al Valor Agregado",
    "IIBB":   "Ingresos Brutos",
    "AFIP":   "Administración Federal de Ingresos Públicos",
    "ANSES":  "Administración Nacional de la Seguridad Social",
}

# Pre-compile a single regex that matches any known acronym at word boundaries.
# Pattern: \b(KEY1|KEY2|...)\b — keys sorted longest-first to avoid prefix shadowing.
# CASE-SENSITIVE (sin re.IGNORECASE): solo matchea la sigla en mayúsculas, no la
# palabra española homógrafa en minúsculas.
def _build_pattern(acronyms: dict[str, str]) -> re.Pattern:
    keys = sorted(acronyms.keys(), key=len, reverse=True)
    escaped = [re.escape(k) for k in keys]
    return re.compile(r"\b(" + "|".join(escaped) + r")\b")


_BASE_PATTERN: re.Pattern = _build_pattern(_BASE_ACRONYMS)


def normalize_query(text: str, extra_acronyms: dict[str, str] | None = None) -> str:
    """Expand acronyms in `text` and clean whitespace.

    Args:
        text: Raw user query.
        extra_acronyms: Tenant-specific acronyms (uppercase key → expansion).

    Returns:
        Normalized query with acronyms expanded. Original text returned on error.
    """
    if not text or not text.strip():
        return text

    try:
        if extra_acronyms:
            merged = {**_BASE_ACRONYMS, **{k.upper(): v for k, v in extra_acronyms.items()}}
            pattern = _build_pattern(merged)
        else:
            merged = _BASE_ACRONYMS
            pattern = _BASE_PATTERN

        def _replace(match: re.Match) -> str:
            # El match ya viene en mayúsculas (pattern case-sensitive); .get directo.
            return merged.get(match.group(0), match.group(0))

        normalized = pattern.sub(_replace, text)
        # Collapse multiple spaces introduced by expansions
        normalized = re.sub(r" {2,}", " ", normalized).strip()
        return normalized
    except Exception:
        return text
