"""Query normalization: expand acronyms and abbreviations before embedding.

Runs in microseconds — pure Python, no model calls.
Applied before semantic cache lookup and retrieval so that "RRHH" and
"Recursos Humanos" land in the same embedding space.

Tenant-specific acronyms can be passed via extra_acronyms dict.
"""

import re

# ── Base acronym dictionary ────────────────────────────────────────────────────
# Keys: uppercase canonical form (with optional dots/spaces stripped).
# Values: full expansion used for embedding — keep natural Spanish phrasing.
_BASE_ACRONYMS: dict[str, str] = {
    # Áreas y departamentos
    "RRHH":   "Recursos Humanos",
    "RRHH.":  "Recursos Humanos",
    "RR.HH.": "Recursos Humanos",
    "RRLL":   "Relaciones Laborales",
    "RR.LL.": "Relaciones Laborales",
    "RRPP":   "Relaciones Públicas",
    "RR.PP.": "Relaciones Públicas",
    "IT":     "Tecnología de la Información",
    "TI":     "Tecnología de la Información",
    "TIC":    "Tecnología de la Información y Comunicación",
    "TICS":   "Tecnologías de la Información y Comunicación",
    "UX":     "experiencia de usuario",
    "UI":     "interfaz de usuario",
    "QA":     "control de calidad",
    "CEO":    "director ejecutivo",
    "CFO":    "director financiero",
    "CTO":    "director de tecnología",
    "COO":    "director de operaciones",
    "RRHH":   "Recursos Humanos",

    # Documentos y normativa
    "CV":     "currículum vitae",
    "DNI":    "documento nacional de identidad",
    "CUIL":   "Clave Única de Identificación Laboral",
    "CUIT":   "Clave Única de Identificación Tributaria",
    "CBU":    "Clave Bancaria Uniforme",
    "NDA":    "acuerdo de confidencialidad",
    "SLA":    "acuerdo de nivel de servicio",
    "KPI":    "indicador clave de desempeño",
    "KPI'S":  "indicadores clave de desempeño",
    "KPIS":   "indicadores clave de desempeño",
    "OKR":    "objetivo y resultado clave",
    "OKRS":   "objetivos y resultados clave",
    "FAQ":    "preguntas frecuentes",
    "FAQS":   "preguntas frecuentes",

    # Términos laborales
    "ART":    "Aseguradora de Riesgos del Trabajo",
    "SAC":    "sueldo anual complementario",
    "LCT":    "Ley de Contrato de Trabajo",
    "CCT":    "Convenio Colectivo de Trabajo",
    "UOM":    "Unión Obrera Metalúrgica",
    "SMVM":   "salario mínimo vital y móvil",
    "AUH":    "Asignación Universal por Hijo",

    # Finanzas y administración
    "IVA":    "Impuesto al Valor Agregado",
    "IIBB":   "Ingresos Brutos",
    "AFIP":   "Administración Federal de Ingresos Públicos",
    "ANSES":  "Administración Nacional de la Seguridad Social",
    "PYME":   "pequeña y mediana empresa",
    "PYMES":  "pequeñas y medianas empresas",
    "ERP":    "sistema de planificación de recursos empresariales",
    "CRM":    "gestión de relaciones con clientes",

    # Abreviaciones textuales comunes
    "ART.":   "artículo",
    "INC.":   "inciso",
    "CAP.":   "capítulo",
    "SEC.":   "sección",
    "PÁG.":   "página",
    "PAG.":   "página",
    "NRO.":   "número",
    "NR.":    "número",
    "NÚM.":   "número",
    "NUM.":   "número",
    "EJ.":    "ejemplo",
    "APROX.": "aproximadamente",
    "CF.":    "conforme",
    "INC":    "inciso",
}

# Pre-compile a single regex that matches any known acronym at word boundaries.
# Pattern: \b(KEY1|KEY2|...)\b — keys sorted longest-first to avoid prefix shadowing.
def _build_pattern(acronyms: dict[str, str]) -> re.Pattern:
    keys = sorted(acronyms.keys(), key=len, reverse=True)
    escaped = [re.escape(k) for k in keys]
    return re.compile(r"\b(" + "|".join(escaped) + r")\b", re.IGNORECASE)


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
            token = match.group(0)
            return merged.get(token.upper(), token)

        normalized = pattern.sub(_replace, text)
        # Collapse multiple spaces introduced by expansions
        normalized = re.sub(r" {2,}", " ", normalized).strip()
        return normalized
    except Exception:
        return text
