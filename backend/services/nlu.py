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
