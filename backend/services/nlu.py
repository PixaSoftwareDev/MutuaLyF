"""Named Entity Recognition via GLiNER (local model).

Used in the query path to detect entities that should trigger Neo4j lookups.
GLiNER runs locally — no external API call.
"""

import logging
import threading
from dataclasses import dataclass
from typing import Any

from core.config import settings

# Pre-import gliner at module level so transformers is fully loaded before uvicorn
# forks worker processes. Without this, concurrent forks race on transformers'
# __pycache__ files and hit "cannot import name 'AutoConfig' from 'transformers'".
try:
    from gliner import GLiNER as _GLiNER_CLASS
    _GLINER_AVAILABLE = True
except ImportError:
    _GLiNER_CLASS = None  # type: ignore[assignment,misc]
    _GLINER_AVAILABLE = False

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


_nlu_model = None
_nlu_model_lock = threading.Lock()
_nlu_model_ready = False


def _load_model():
    """Load GLiNER model once and cache in memory. Thread-safe."""
    global _nlu_model, _nlu_model_ready
    if _nlu_model_ready:
        return _nlu_model
    with _nlu_model_lock:
        if _nlu_model_ready:
            return _nlu_model
        try:
            if not _GLINER_AVAILABLE:
                logger.warning("gliner_not_installed nlu_disabled")
                _nlu_model = None
            else:
                logger.info("nlu_model_loading model=%s", settings.nlu_model)
                _nlu_model = _GLiNER_CLASS.from_pretrained(settings.nlu_model)  # type: ignore[union-attr]
                logger.info("nlu_model_loaded model=%s", settings.nlu_model)
        except Exception as exc:
            logger.error("nlu_model_load_failed error=%s", exc)
            _nlu_model = None
        finally:
            _nlu_model_ready = True
    return _nlu_model


def extract_entities(text: str, threshold: float = 0.5) -> list[Entity]:
    """Extract named entities from text using GLiNER.

    Memory hygiene: wrapped in torch.inference_mode() + gc.collect after each call.
    Without these, PyTorch retains hidden state and leaks ~50-100MB per query.
    """
    import gc
    if not settings.nlu_enabled:
        return []

    model = _load_model()
    if model is None:
        return []

    truncated = text[:1000]

    try:
        import torch
        with torch.inference_mode():
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
        del raw_entities
        gc.collect()
        logger.debug("nlu_entities_extracted count=%d", len(entities))
        return entities
    except Exception as exc:
        logger.error("nlu_extraction_failed error=%s", exc)
        return []


