"""Document type classifier: decides chunking strategy per document.

Three document types:
  structured  — tables, forms, numbered lists, clear headers
                → fixed-size chunking preserves structure
  mixed       — combination of prose and structured elements
                → fixed-size with smaller chunks to preserve context
  freeform    — continuous prose (manuals, policies, narratives)
                → semantic chunking (split on meaning boundaries)

Classification uses heuristics on the extracted text:
  - Header density (lines starting with # or digit+period)
  - Table density (lines with | separators)
  - Avg sentence length (short sentences → structured)
  - List density (lines starting with -, *, •, digit)

No LLM call — runs in milliseconds and is deterministic.
"""

import re
import logging
from dataclasses import dataclass
from enum import Enum
from typing import Literal

logger = logging.getLogger(__name__)


class DocType(str, Enum):
    STRUCTURED = "structured"
    MIXED      = "mixed"
    FREEFORM   = "freeform"


@dataclass
class ClassificationResult:
    doc_type:         DocType
    confidence:       float          # 0–1
    chunking_strategy: Literal["fixed", "fixed_small", "semantic"]
    features:         dict           # raw feature values for debugging


def classify_document(text: str) -> ClassificationResult:
    """Classify document type based on text heuristics.

    Args:
        text: Full extracted document text.

    Returns:
        ClassificationResult with doc_type and recommended chunking_strategy.
    """
    if not text or len(text.strip()) < 100:
        return ClassificationResult(
            doc_type=DocType.FREEFORM,
            confidence=0.5,
            chunking_strategy="fixed",
            features={"reason": "too_short"},
        )

    lines = text.splitlines()
    non_empty = [l for l in lines if l.strip()]
    total = max(len(non_empty), 1)

    features = _extract_features(text, non_empty, total)

    structured_score = (
        features["header_density"] * 3.0
        + features["list_density"] * 2.0
        + features["table_density"] * 4.0
        + (1 - features["avg_sentence_length_normalized"]) * 1.0
    )

    freeform_score = (
        features["avg_sentence_length_normalized"] * 3.0
        + features["paragraph_density"] * 2.0
        + (1 - features["list_density"]) * 1.0
    )

    total_score = structured_score + freeform_score
    if total_score == 0:
        total_score = 1

    struct_pct = structured_score / total_score
    free_pct   = freeform_score / total_score

    if struct_pct >= 0.60:
        doc_type = DocType.STRUCTURED
        strategy = "fixed"
        confidence = struct_pct
    elif free_pct >= 0.60:
        doc_type = DocType.FREEFORM
        strategy = "semantic"
        confidence = free_pct
    else:
        doc_type = DocType.MIXED
        strategy = "fixed_small"
        confidence = 1 - abs(struct_pct - free_pct)

    logger.debug(
        "doc_classify type=%s confidence=%.2f strategy=%s features=%s",
        doc_type, confidence, strategy, features,
    )
    return ClassificationResult(
        doc_type=doc_type,
        confidence=round(confidence, 3),
        chunking_strategy=strategy,
        features=features,
    )


def _extract_features(text: str, non_empty_lines: list[str], total: int) -> dict:
    """Extract numerical features from text for classification."""
    # Header density: lines starting with # or "N. " or "TÍTULO EN MAYUSCULAS"
    header_re = re.compile(r"^(#{1,6}\s|[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{4,}$|\d+\.\s|\d+\)\s)")
    headers = sum(1 for l in non_empty_lines if header_re.match(l.strip()))
    header_density = headers / total

    # List density: lines starting with -, *, •, or digit+.
    list_re = re.compile(r"^[\-\*•·]\s|^\d+[\.\)]\s")
    lists = sum(1 for l in non_empty_lines if list_re.match(l.strip()))
    list_density = lists / total

    # Table density: lines with pipe separators
    table_lines = sum(1 for l in non_empty_lines if l.count("|") >= 2)
    table_density = table_lines / total

    # Paragraph density: blank-line-separated blocks vs total lines
    paragraphs = len([b for b in text.split("\n\n") if b.strip()])
    paragraph_density = min(paragraphs / max(total / 5, 1), 1.0)

    # Average sentence length (words)
    sentences = re.split(r"[.!?]+", text)
    sentences = [s.strip() for s in sentences if len(s.split()) >= 3]
    avg_sentence_len = sum(len(s.split()) for s in sentences) / max(len(sentences), 1)
    # Normalize: 0 = very short (structured), 1 = very long (freeform)
    avg_sentence_length_normalized = min(avg_sentence_len / 40.0, 1.0)

    return {
        "header_density":                 round(header_density, 3),
        "list_density":                   round(list_density, 3),
        "table_density":                  round(table_density, 3),
        "paragraph_density":              round(paragraph_density, 3),
        "avg_sentence_length":            round(avg_sentence_len, 1),
        "avg_sentence_length_normalized": round(avg_sentence_length_normalized, 3),
        "total_lines":                    total,
    }
