"""Señal léxica para re-rankear candidatos del clasificador de intenciones.

Motivación: multilingual-e5 pone consultas de "turno" y "horario" muy cerca en el
espacio de embeddings (coseno ~0.83), así que el top-1 por coseno se equivoca en
los casos límite ("¿a qué hora termina el traumatólogo?" caía en sacar_turno).

Solución: además del coseno, medir cuánto se solapan las PALABRAS de la consulta
con los tokens del LABEL de cada intención candidata (con expansión de sinónimos de
dominio). Es un desempate barato y determinista que inclina solo los empates
cercanos — no reemplaza al embedding, lo complementa.

Tenant-agnóstico: no hardcodea labels, opera sobre los tokens del propio label.
El único conocimiento de dominio son sinónimos de verbos/consulta comunes en
español que NO comparten raíz con el sustantivo del dominio (atiende→horario,
sacar→turno, afilio→afiliacion).
"""

import re
import unicodedata

# Palabras vacías / de pregunta que no aportan señal.
_STOP = {
    "que", "cual", "cuales", "como", "donde", "cuando", "cuanto", "cuanta", "por",
    "para", "los", "las", "del", "una", "uno", "unos", "unas", "mi", "me", "el",
    "la", "de", "un", "es", "en", "con", "se", "su", "tu", "al", "lo", "hay",
    "necesito", "quiero", "puedo", "tengo", "hacer", "sobre", "esta", "este",
}

# palabra de la consulta → token de dominio que suele aparecer en el label.
# Solo sinónimos que NO comparten raíz (esos ya los capta el stem-match).
_SYNONYMS = {
    # dominio horario
    "hora": "horario", "horas": "horario", "atiende": "horario",
    "atienden": "horario", "atendes": "horario", "abre": "horario",
    "abren": "horario", "cierra": "horario", "cierran": "horario",
    "dia": "horario", "dias": "horario", "sabado": "horario",
    "sabados": "horario", "domingo": "horario", "manana": "horario",
    "tarde": "horario",
    # dominio turno
    "saco": "turno", "sacar": "turno", "sacarme": "turno", "reservar": "turno",
    "reserva": "turno", "pedir": "turno", "pido": "turno", "agendar": "turno",
    "agenda": "turno", "cita": "turno",
    # dominio afiliacion
    "afilio": "afiliacion", "afiliar": "afiliacion", "afiliarme": "afiliacion",
    "socio": "afiliacion", "asociar": "afiliacion", "alta": "afiliacion",
    "inscribir": "afiliacion",
    # dominio receta
    "remedio": "receta", "remedios": "receta", "medicamento": "receta",
    "medicamentos": "receta",
    # contacto / linea
    "telefono": "linea", "llamar": "linea", "llamo": "linea", "numero": "linea",
    "gratuita": "linea", "whatsapp": "whatsapp",
    # app
    "aplicacion": "app", "celular": "app", "descargar": "app", "descargo": "app",
}


def _deaccent(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def _tokens(text: str) -> list[str]:
    t = _deaccent(text.lower())
    return [w for w in re.split(r"[^a-z0-9]+", t) if len(w) >= 3 and w not in _STOP]


def _stem_match(a: str, b: str) -> bool:
    """True si comparten prefijo de >=4 chars (hora~horarios, receta~recetas,
    afili~afiliacion). Para tokens cortos exige igualdad."""
    if min(len(a), len(b)) < 4:
        return a == b
    return a[:4] == b[:4]


def keyword_signal(query: str, label: str | None) -> float:
    """Fracción de tokens del label con evidencia léxica en la consulta ∈ [0, 1]."""
    if not label:
        return 0.0
    q = _tokens(query)
    if not q:
        return 0.0
    q_expanded = set(q) | {_SYNONYMS[w] for w in q if w in _SYNONYMS}
    l_tokens = [_deaccent(t) for t in label.lower().split("_") if len(t) >= 3 and t not in _STOP]
    if not l_tokens:
        return 0.0
    matched = sum(1 for lt in l_tokens if any(_stem_match(lt, qt) for qt in q_expanded))
    return matched / len(l_tokens)
