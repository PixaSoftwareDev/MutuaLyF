"""Named Entity Recognition via GLiNER (local model).

Used in the query path to detect entities that should trigger Neo4j lookups.
GLiNER runs locally — no external API call.
"""

import logging
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from core.config import settings

logger = logging.getLogger(__name__)

# Generic terms that GLiNER misclassifies as named entities
_GENERIC_TERMS: frozenset[str] = frozenset({
    "empleado", "empleados", "paciente", "pacientes", "profesional", "profesionales",
    "personal", "técnico", "técnicos", "institución", "la institución", "la clínica",
    "el sistema", "el área", "el servicio", "familiares", "compañeros", "cónyuge",
    "usuario", "usuarios", "cliente", "clientes", "equipo", "personal médico",
})


def _is_valid_entity(text: str, score: float) -> bool:
    """Filter out low-quality entities before writing to Neo4j.

    Rejects:
    - Too short (< 3 chars) or too long (> 6 words) — phrases aren't entities
    - Starts lowercase — named entities start with uppercase in Spanish
    - In generic terms blocklist
    - Score below 0.60 (raised from default 0.5)
    """
    text = text.strip()
    if len(text) < 3:
        return False
    if len(text.split()) > 6:
        return False
    if text[0].islower():
        return False
    if text.lower() in _GENERIC_TERMS:
        return False
    if score < 0.60:
        return False
    return True


# Entity types we extract for Neo4j graph traversal
_ENTITY_TYPES = [
    "persona",
    "rol",
    "departamento",
    "horario",
    "dominio",
    "organizacion",
    "fecha",
    "lugar",
]


@dataclass
class Entity:
    text: str
    label: str
    score: float
    start: int
    end: int


@lru_cache(maxsize=1)
def _load_model():
    """Load GLiNER model once and cache in memory."""
    try:
        from gliner import GLiNER
        logger.info("nlu_model_loading model=%s", settings.nlu_model)
        model = GLiNER.from_pretrained(settings.nlu_model)
        logger.info("nlu_model_loaded model=%s", settings.nlu_model)
        return model
    except ImportError:
        logger.warning("gliner_not_installed nlu_disabled")
        return None
    except Exception as exc:
        logger.error("nlu_model_load_failed error=%s", exc)
        return None


def extract_entities(text: str, threshold: float = 0.5) -> list[Entity]:
    """Extract named entities from text using GLiNER.

    Args:
        text: Input text (query or document chunk).
        threshold: Minimum confidence score for an entity to be included.

    Returns:
        List of Entity objects. Empty list if model unavailable.
    """
    model = _load_model()
    if model is None:
        return []

    # Truncate to avoid memory issues on very long texts
    truncated = text[:1000]

    try:
        raw_entities: list[dict[str, Any]] = model.predict_entities(
            truncated, _ENTITY_TYPES, threshold=threshold
        )
        entities = [
            Entity(
                text=e["text"],
                label=e["label"],
                score=float(e["score"]),
                start=e["start"],
                end=e["end"],
            )
            for e in raw_entities
            if _is_valid_entity(e["text"], float(e["score"]))
        ]
        logger.debug("nlu_entities_extracted count=%d", len(entities))
        return entities
    except Exception as exc:
        logger.error("nlu_extraction_failed error=%s", exc)
        return []


def has_named_entities(text: str) -> bool:
    """Quick check: does this query contain named entities that warrant a Neo4j lookup?"""
    entities = extract_entities(text)
    return len(entities) > 0


def extract_entities_batch(
    texts: list[str],
    threshold: float = 0.5,
) -> list[list[Entity]]:
    """Extract entities from multiple texts in a single GLiNER forward pass.

    Significantly faster than calling extract_entities() N times because GLiNER
    processes a batch in one model forward pass rather than N separate ones.

    Args:
        texts: List of texts to process.
        threshold: Minimum confidence score.

    Returns:
        List of Entity lists, one per input text. Empty list per text on failure.
    """
    model = _load_model()
    if model is None:
        return [[] for _ in texts]

    truncated = [t[:1000] for t in texts]

    try:
        # GLiNER's batch prediction: one forward pass for all texts
        batch_results = model.batch_predict_entities(
            truncated, _ENTITY_TYPES, threshold=threshold
        )
        out: list[list[Entity]] = []
        for raw_list in batch_results:
            out.append([
                Entity(
                    text=e["text"],
                    label=e["label"],
                    score=float(e["score"]),
                    start=e["start"],
                    end=e["end"],
                )
                for e in raw_list
                if _is_valid_entity(e["text"], float(e["score"]))
            ])
        logger.debug("nlu_batch_done texts=%d total_entities=%d", len(texts), sum(len(x) for x in out))
        return out
    except AttributeError:
        # Fallback: older GLiNER versions may not have batch_predict_entities
        logger.warning("gliner_batch_not_available falling_back_to_sequential")
        return [extract_entities(t, threshold) for t in texts]
    except Exception as exc:
        logger.error("nlu_batch_failed error=%s", exc)
        return [[] for _ in texts]
