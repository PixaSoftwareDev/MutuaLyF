"""Document type classifier: decides chunking strategy per document.

Five document types:
  short       — total word count < 400; entire document is one parent
  faq         — Q&A pairs; each question+answer is one parent
  structured  — tables, forms, numbered lists, clear headers
                → structural split respecting article/section boundaries
  mixed       — combination of prose and structured elements
                → fixed-size with smaller chunks
  freeform    — continuous prose (manuals, policies, narratives)
                → semantic chunking (split on meaning boundaries)

Classification uses heuristics on the extracted text:
  - Total word count (short detection)
  - FAQ marker density (question patterns)
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

# Words below which the whole document is a single parent (no split needed).
# 200 covers emails, memos, short notices. Above this, structural splits
# (FAQ pairs, articles) provide better precision than a single parent.
_SHORT_DOC_THRESHOLD = 200

# Structural section markers: Artículo, Cláusula, Capítulo, etc. (mixed-case)
# These appear in reglamentos, contracts, policies — high-confidence structured signal.
_ARTICLE_MARKER_RE = re.compile(
    r"^(?:Art[íi]culo|Cl[áa]usula|Cap[íi]tulo|Secci[óo]n|Secci[oó]n|Anexo|T[íi]tulo|Parte)\s+\w",
    re.IGNORECASE,
)

# FAQ: lines/paragraphs that look like questions
# Matches: "1. ¿Cómo...", "Pregunta 3:", "Q:", "P:", lines starting with ¿
_FAQ_MARKER_RE = re.compile(
    r"(?:^|\n)"
    r"(?:\d+[\.\)]\s+[¿\w]"         # "1. ¿Qué..." or "1. What..."
    r"|[Pp]regunta\s*\d*\s*[:\.\-]"  # "Pregunta:" / "Pregunta 3."
    r"|[Qq][:\.\-]\s+"               # "Q: " / "Q. "
    r"|[Pp][:\.\-]\s+"               # "P: " / "P. "
    r"|¿)",                          # Starts with inverted question mark
    re.MULTILINE,
)


# ENTITY_LIST: nómina/catálogo/listado donde cada ítem es una entidad con
# atributos (profesional→especialidad→horario, producto→precio, sucursal→dirección).
# Se detecta por numeración jerárquica densa "N.M ..." (3.1, 3.2…) repetida muchas
# veces. Genérico: reconoce la FORMA (lista de ítems), no el contenido del dominio.
_ENTITY_MARKER_RE = re.compile(r"^\d+\.\d+(?:\.\d+)?[\s\)\.\-]")
_ENTITY_MIN_ITEMS = 5   # mínimo de ítems para tratar el doc como lista de entidades


class DocType(str, Enum):
    SHORT       = "short"
    FAQ         = "faq"
    ENTITY_LIST = "entity_list"
    STRUCTURED  = "structured"
    MIXED       = "mixed"
    FREEFORM    = "freeform"


@dataclass
class ClassificationResult:
    doc_type:          DocType
    confidence:        float          # 0–1
    chunking_strategy: Literal["single", "faq", "entity", "fixed", "fixed_small", "semantic"]
    features:          dict           # raw feature values for debugging


def classify_document(text: str) -> ClassificationResult:
    """Classify document type based on text heuristics.

    Args:
        text: Full extracted document text.

    Returns:
        ClassificationResult with doc_type and recommended chunking_strategy.
    """
    if not text or len(text.strip()) < 100:
        return ClassificationResult(
            doc_type=DocType.SHORT,
            confidence=1.0,
            chunking_strategy="single",
            features={"reason": "too_short"},
        )

    lines = text.splitlines()
    non_empty = [l for l in lines if l.strip()]
    total = max(len(non_empty), 1)
    total_words = len(text.split())

    features = _extract_features(text, non_empty, total, total_words)

    # ── FAQ: check before SHORT so a 5-question FAQ isn't collapsed to one parent
    # FAQ detection: explicit question markers OR high density of ?-ending lines ─
    # Require either explicit markers (high confidence) or very high ? density
    # to avoid false positives from contracts with rhetorical questions.
    faq_markers = len(_FAQ_MARKER_RE.findall(text))
    question_lines = sum(1 for l in non_empty if l.strip().rstrip('"\'»)').endswith("?"))
    faq_marker_density = faq_markers / total
    faq_question_density = question_lines / total

    is_faq = (
        faq_marker_density >= 0.08          # ≥8% of lines have explicit FAQ marker
        or faq_question_density >= 0.20     # ≥20% of lines end with ?
        or (faq_markers >= 5 and faq_question_density >= 0.10)  # mixed signal
    )
    if is_faq:
        confidence = min((faq_marker_density + faq_question_density) * 3, 1.0)
        logger.debug(
            "doc_classify type=faq marker_density=%.3f question_density=%.3f",
            faq_marker_density, faq_question_density,
        )
        return ClassificationResult(
            doc_type=DocType.FAQ,
            confidence=round(confidence, 3),
            chunking_strategy="faq",
            features=features,
        )

    # ── SHORT: check after FAQ so short FAQs keep their Q+A structure ────────
    if total_words < _SHORT_DOC_THRESHOLD:
        logger.debug("doc_classify type=short words=%d", total_words)
        return ClassificationResult(
            doc_type=DocType.SHORT,
            confidence=1.0,
            chunking_strategy="single",
            features=features,
        )

    # ── ENTITY_LIST: lista de entidades con numeración jerárquica densa ──────
    # Va ANTES de structured porque estos docs tienen mucha numeración/headers que
    # los haría 'structured' (y entonces se agruparían varias entidades por chunk).
    # Cada ítem "N.M ..." debe terminar en su propio chunk para no mezclar entidades.
    entity_markers = sum(1 for l in non_empty if _ENTITY_MARKER_RE.match(l.strip()))
    if entity_markers >= _ENTITY_MIN_ITEMS:
        logger.debug("doc_classify type=entity_list markers=%d total_lines=%d", entity_markers, total)
        return ClassificationResult(
            doc_type=DocType.ENTITY_LIST,
            confidence=round(min(0.6 + entity_markers / max(total, 1), 1.0), 3),
            chunking_strategy="entity",
            features={**features, "entity_markers": entity_markers},
        )

    # ── STRUCTURED (early exit): signals that are unambiguous ────────────────
    # Article/clause markers (Artículo, Cláusula, etc.) are legal-doc signals —
    # even a low density (2%) confirms a structured regulatory document.
    # Similarly, high header density (≥8%) with markdown or numbered headings.
    # These checks happen before scoring because legal text always has long
    # sentences that inflate freeform_score and would otherwise win.
    if features["article_density"] >= 0.02 or features["header_density"] >= 0.08:
        confidence = max(features["article_density"] * 20, features["header_density"] * 10, 0.7)
        logger.debug(
            "doc_classify type=structured (early) article_density=%.3f header_density=%.3f",
            features["article_density"], features["header_density"],
        )
        return ClassificationResult(
            doc_type=DocType.STRUCTURED,
            confidence=round(min(confidence, 1.0), 3),
            chunking_strategy="fixed",
            features=features,
        )

    # ── STRUCTURED / MIXED / FREEFORM (score-based) ───────────────────────────
    structured_score = (
        features["header_density"] * 3.0
        + features["article_density"] * 5.0   # strong: unambiguous legal/regulatory markers
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


def _extract_features(text: str, non_empty_lines: list[str], total: int, total_words: int = 0) -> dict:
    """Extract numerical features from text for classification."""
    # Header density: lines starting with # or "N. " or "TÍTULO EN MAYUSCULAS"
    header_re = re.compile(r"^(#{1,6}\s|[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{4,}$|\d+\.\s|\d+\)\s)")
    headers = sum(1 for l in non_empty_lines if header_re.match(l.strip()))
    header_density = headers / total

    # Article/legal marker density: "Artículo 15", "Cláusula X", etc.
    # Stronger structured signal than generic header_density because these are
    # unambiguous section delimiters in regulatory and legal documents.
    articles = sum(1 for l in non_empty_lines if _ARTICLE_MARKER_RE.match(l.strip()))
    article_density = articles / total

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
        "article_density":                round(article_density, 3),
        "list_density":                   round(list_density, 3),
        "table_density":                  round(table_density, 3),
        "paragraph_density":              round(paragraph_density, 3),
        "avg_sentence_length":            round(avg_sentence_len, 1),
        "avg_sentence_length_normalized": round(avg_sentence_length_normalized, 3),
        "total_lines":                    total,
        "total_words":                    total_words,
    }
