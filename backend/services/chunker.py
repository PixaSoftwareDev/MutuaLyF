"""Adaptive document chunking pipeline (Etapa 3).

Strategies by document type (determined by doc_classifier.py):
  structured  → fixed-size 512t/64 overlap (preserves numbered sections)
  mixed       → fixed-size 256t/32 overlap (smaller chunks, better precision)
  freeform    → semantic chunking via sentence embeddings (cosine threshold)

Hierarchical chunking (parent_id):
  - Parent chunk: full logical section (up to 1024 tokens)
  - Child chunks: sub-splits of the parent for fine-grained retrieval
  - Both stored in Qdrant; parent chunks stored in PostgreSQL for context

Fixed-size is the guaranteed fallback if semantic chunking fails.
"""

import hashlib
import logging
import os
import re
import uuid
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Literal

from langchain_text_splitters import RecursiveCharacterTextSplitter

from core.config import settings
from services.doc_classifier import ClassificationResult, DocType

logger = logging.getLogger(__name__)

SEMANTIC_COSINE_THRESHOLD = float(
    os.getenv("SEMANTIC_CHUNK_COSINE_THRESHOLD", "0.75")
)

# Separate lightweight model for semantic boundary detection.
# Uses 384-dim vectors (vs 1024 for e5-large) — only needs relative similarity,
# not absolute semantic quality. ~5x faster than multilingual-e5-large.
_SPLIT_MODEL_NAME = os.getenv("SEMANTIC_SPLIT_MODEL", "paraphrase-multilingual-MiniLM-L12-v2")


@lru_cache(maxsize=1)
def _build_split_model():
    """Load the lightweight model used only for semantic boundary detection."""
    try:
        from sentence_transformers import SentenceTransformer
        logger.info("split_model_loading model=%s", _SPLIT_MODEL_NAME)
        m = SentenceTransformer(_SPLIT_MODEL_NAME)
        logger.info("split_model_loaded model=%s", _SPLIT_MODEL_NAME)
        return m
    except Exception as exc:
        logger.warning("split_model_load_failed error=%s fallback=e5_large", exc)
        return None


@dataclass
class Chunk:
    """A single document chunk ready for embedding and storage."""

    id:           str
    document_id:  str
    tenant_id:    str
    text:         str
    token_count:  int
    chunk_index:  int
    total_chunks: int
    parent_id:    str | None = None   # set for hierarchical child chunks
    chunk_level:  str = "flat"        # 'flat' | 'parent' | 'child'
    doc_type:     str = "unknown"     # from doc_classifier
    strategy:     str = "fixed"       # 'fixed' | 'fixed_small' | 'semantic'
    metadata:     dict = field(default_factory=dict)

    @property
    def text_hash(self) -> str:
        return hashlib.sha256(self.text.encode()).hexdigest()


@dataclass
class HierarchicalChunk:
    """A parent chunk stored in PostgreSQL for LLM context.

    Parents are large (up to 700 words), aligned to structural document
    boundaries (chapters, numbered sections, separator lines).  Their children
    (Chunk objects with chunk_level='child') are embedded and stored in Qdrant
    for precise semantic search.  At query time the retrieval layer fetches the
    parent text from PG so the LLM receives rich context, not fragments.
    """

    id:            str
    document_id:   str
    tenant_id:     str
    text:          str          # full parent text sent to LLM
    token_count:   int
    chunk_index:   int
    total_chunks:  int = 0
    section_header: str = ""   # e.g. "5.1 Plan de capacitación anual"
    metadata:      dict = field(default_factory=dict)


# ── Splitter cache ─────────────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def _build_fixed_splitter() -> RecursiveCharacterTextSplitter:
    return RecursiveCharacterTextSplitter(
        chunk_size=settings.chunk_size_tokens,
        chunk_overlap=settings.chunk_overlap_tokens,
        length_function=_count_tokens,
        separators=["\n\n", "\n", ". ", " ", ""],
    )


@lru_cache(maxsize=1)
def _build_small_splitter() -> RecursiveCharacterTextSplitter:
    """Smaller chunks for mixed documents — better precision."""
    return RecursiveCharacterTextSplitter(
        chunk_size=max(settings.chunk_size_tokens // 2, 128),
        chunk_overlap=max(settings.chunk_overlap_tokens // 2, 16),
        length_function=_count_tokens,
        separators=["\n\n", "\n", ". ", " ", ""],
    )


def _count_tokens(text: str) -> int:
    return len(text.split())


@lru_cache(maxsize=1)
def _build_child_splitter() -> RecursiveCharacterTextSplitter:
    """Small splitter for hierarchical children — optimised for semantic search precision.

    150 words ≈ 200 LLM tokens: large enough for coherent embeddings, small
    enough that the embedding captures a single idea rather than many mixed ones.
    Overlap is small (15 words) because the parent provides full context at
    query time — we don't need overlap to reconstruct context.
    """
    return RecursiveCharacterTextSplitter(
        chunk_size=settings.child_chunk_size_words,
        chunk_overlap=settings.child_chunk_overlap_words,
        length_function=_count_tokens,
        separators=["\n\n", "\n", ". ", " ", ""],
    )


# ── Structural boundary patterns for parent splitting ─────────────────────────
# Order matters: more specific patterns first.
_BOUNDARY_RE = re.compile(
    r"^(?:"
    r"---CHUNK---|"                                              # explicit marker
    r"[═─=\-]{4,}|"                                            # separator lines (box-drawing or ASCII)
    r"(?:CAPÍTULO|CAPITULO|SECCIÓN|SECCION|ARTÍCULO|ARTICULO|"
    r"TÍTULO|TITULO|PARTE|ANEXO|CHAPTER|SECTION|ARTICLE)\b|"   # chapter-level keywords
    r"\d+(?:\.\d+)+\s+\S|"                                     # "1.1 text", "2.3.4 text"
    r"\d+\.\s+[A-ZÁÉÍÓÚÑA-Z]|"                                 # "1. TÍTULO"
    r"#{1,3}\s+\S"                                              # markdown ## headers
    r")",
    re.IGNORECASE,
)

# Lines that are pure separators (no header text to propagate to children)
_SEPARATOR_ONLY_RE = re.compile(r"^(?:---CHUNK---|[═─=\-]{4,})$")


# ── Public API ─────────────────────────────────────────────────────────────────

def chunk_document(
    text: str,
    document_id: str,
    tenant_id: str,
    metadata: dict | None = None,
    classification: ClassificationResult | None = None,
) -> list[Chunk]:
    """Split document text into chunks using the appropriate strategy.

    Args:
        text:           Full document text.
        document_id:    UUID of the parent document.
        tenant_id:      Tenant that owns this document.
        metadata:       Propagated to each chunk.
        classification: Result from doc_classifier.classify_document().
                        If None, defaults to fixed-size chunking.

    Returns:
        List of Chunk objects ordered by position.
    """
    if not text.strip():
        logger.warning("chunk_document_empty_text document_id=%s", document_id)
        return []

    strategy = classification.chunking_strategy if classification else "fixed"
    doc_type  = classification.doc_type.value   if classification else "unknown"

    if strategy == "semantic":
        raw_texts = _semantic_split(text)
        if not raw_texts:
            logger.warning("semantic_split_empty fallback_to_fixed document_id=%s", document_id)
            raw_texts = _fixed_split(text, "fixed")
    elif strategy == "fixed_small":
        raw_texts = _fixed_split(text, "fixed_small")
    else:
        raw_texts = _fixed_split(text, "fixed")

    chunks = _build_chunks(
        raw_texts, document_id, tenant_id,
        metadata or {}, doc_type, strategy,
    )

    logger.info(
        "chunk_document_complete document_id=%s tenant_id=%s "
        "strategy=%s doc_type=%s total_chunks=%d",
        document_id, tenant_id, strategy, doc_type, len(chunks),
    )
    return chunks


def chunk_document_hierarchical(
    text: str,
    document_id: str,
    tenant_id: str,
    metadata: dict | None = None,
    classification: ClassificationResult | None = None,
) -> tuple[list[HierarchicalChunk], list[Chunk]]:
    """Split document into parent (context) + child (search) chunks.

    Parents (≤700 words) are aligned to structural document boundaries
    (chapters, numbered sections, separator lines) and stored in PostgreSQL.
    They are fetched at query time and sent whole to the LLM for rich context.

    Children (≤150 words) are sub-splits of each parent.  They are embedded
    with a section-header prefix and stored in Qdrant for precise semantic
    search.  Each child carries `parent_id` so retrieval can expand back to
    the parent.

    Quality gate, NLU, and Neo4j entity writes operate on children (same
    Chunk interface).  Quality gate runs once per parent — children of a
    failed parent are dropped before embedding, cutting Groq calls ≈5×.

    Returns:
        (parents, children) — children already have parent_id and chunk_level='child'.
    """
    if not text.strip():
        logger.warning("chunk_hierarchical_empty_text document_id=%s", document_id)
        return [], []

    doc_type = classification.doc_type.value if classification else "unknown"
    meta = metadata or {}

    # 1. Split into structural parent sections
    sections = _structural_split(text)  # list of (section_header, body_text)

    parents: list[HierarchicalChunk] = []
    children: list[Chunk] = []
    child_index = 0

    for p_idx, (header, body) in enumerate(sections):
        parent_id = str(uuid.uuid4())
        # Parent text = header (if any) + full body — this is what the LLM reads
        parent_text = f"{header}\n{body}".strip() if header else body

        parent = HierarchicalChunk(
            id=parent_id,
            document_id=document_id,
            tenant_id=tenant_id,
            text=parent_text,
            token_count=_count_tokens(parent_text),
            chunk_index=p_idx,
            total_chunks=len(sections),
            section_header=header,
            metadata=meta,
        )
        parents.append(parent)

        # 2. Split parent body into small children for embedding
        child_texts = [t for t in _build_child_splitter().split_text(body) if t.strip()]
        if not child_texts:
            child_texts = [body] if body.strip() else []

        for c_text in child_texts:
            # Inject section header into child text before embedding.
            # This anchors the child's embedding to its document context:
            # "5.1 Plan de capacitación\nCada colaborador define..." embeds
            # much better than the fragment alone.
            embedded_text = f"[{header}]\n{c_text}" if header else c_text

            child = Chunk(
                id=str(uuid.uuid4()),
                document_id=document_id,
                tenant_id=tenant_id,
                text=embedded_text,
                token_count=_count_tokens(embedded_text),
                chunk_index=child_index,
                total_chunks=0,  # filled after loop
                parent_id=parent_id,
                chunk_level="child",
                doc_type=doc_type,
                strategy="hierarchical",
                metadata={**meta, "section_header": header},
            )
            children.append(child)
            child_index += 1

    # Back-fill total_chunks now that we know the final count
    total = len(children)
    for c in children:
        c.total_chunks = total

    logger.info(
        "chunk_hierarchical_complete document_id=%s parents=%d children=%d",
        document_id, len(parents), len(children),
    )
    return parents, children


def extract_text_from_bytes(content: bytes, mime_type: str, filename: str) -> str:
    """Extract plain text from uploaded file bytes.

    Supports: text/plain, application/pdf, .docx, text/html.
    """
    if mime_type == "text/plain":
        return content.decode("utf-8", errors="replace")
    if mime_type == "application/pdf":
        return _extract_pdf(content, filename)
    if mime_type in (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ):
        return _extract_docx(content, filename)
    if mime_type == "text/html":
        return _extract_html(content, filename)
    logger.warning("unsupported_mime_type mime=%s filename=%s", mime_type, filename)
    return content.decode("utf-8", errors="replace")


# ── Hierarchical splitting helpers ────────────────────────────────────────────

_MAX_PARENT_WORDS = settings.max_parent_words
_MIN_PARENT_WORDS = settings.min_parent_words


def _structural_split(text: str) -> list[tuple[str, str]]:
    """Detect document structural boundaries and split into (header, body) pairs.

    Boundaries recognised (in priority order):
      - Explicit ---CHUNK--- markers
      - Separator lines (4+ box-drawing or ASCII dash/equals chars)
      - Chapter-level keywords (CAPÍTULO, SECCIÓN, ARTÍCULO, …)
      - Numbered subsections (1.1 text, 2.3.4 text)
      - Single-level numbered headings (1. TITLE)
      - Markdown headers (## Title)

    Each resulting section is capped at _MAX_PARENT_WORDS.  Sections shorter
    than _MIN_PARENT_WORDS are merged into the previous one to avoid tiny
    orphan parents.

    Returns:
        List of (section_header, section_body) tuples.
        section_header is the boundary line itself (e.g. "5.1 Plan de…").
        section_body is all text until the next boundary.
    """
    lines = text.splitlines(keepends=True)
    sections: list[tuple[str, str]] = []
    current_header = ""
    current_lines: list[str] = []

    def _flush() -> None:
        body = "".join(current_lines).strip()
        if body:
            sections.append((current_header, body))

    for line in lines:
        stripped = line.strip()
        if stripped and _BOUNDARY_RE.match(stripped):
            _flush()
            # Pure separator lines (═══, ---) carry no meaningful header text
            current_header = "" if _SEPARATOR_ONLY_RE.match(stripped) else stripped
            current_lines = []
        else:
            current_lines.append(line)

    _flush()  # last section

    # Apply size constraints
    result: list[tuple[str, str]] = []
    for header, body in sections:
        words = _count_tokens(body)
        if words < _MIN_PARENT_WORDS:
            if result:
                # Merge short section into previous parent
                prev_h, prev_b = result[-1]
                merged_body = f"{prev_b}\n\n{header}\n{body}".strip() if header else f"{prev_b}\n\n{body}"
                result[-1] = (prev_h, merged_body)
            else:
                result.append((header, body))
        elif words <= _MAX_PARENT_WORDS:
            result.append((header, body))
        else:
            # Section too long — split at paragraph boundaries, keep header on first part
            parts = _split_long_section(body)
            for i, part in enumerate(parts):
                part_header = header if i == 0 else f"{header} (cont. {i + 1})" if header else ""
                result.append((part_header, part))

    return result if result else [("", text)]


def _split_long_section(text: str) -> list[str]:
    """Split a section that exceeds _MAX_PARENT_WORDS at paragraph boundaries.

    Falls back to the fixed splitter if there are no paragraph breaks.
    """
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if len(paragraphs) <= 1:
        return _fixed_split(text, "fixed")

    parts: list[str] = []
    current: list[str] = []
    current_words = 0

    for para in paragraphs:
        para_words = _count_tokens(para)
        if current_words + para_words > _MAX_PARENT_WORDS and current_words >= _MIN_PARENT_WORDS:
            parts.append("\n\n".join(current))
            current = [para]
            current_words = para_words
        else:
            current.append(para)
            current_words += para_words

    if current:
        if parts and current_words < _MIN_PARENT_WORDS:
            parts[-1] = parts[-1] + "\n\n" + "\n\n".join(current)
        else:
            parts.append("\n\n".join(current))

    return parts


# ── Splitting strategies ───────────────────────────────────────────────────────

def _fixed_split(text: str, size: Literal["fixed", "fixed_small"]) -> list[str]:
    splitter = _build_small_splitter() if size == "fixed_small" else _build_fixed_splitter()
    return [r.strip() for r in splitter.split_text(text) if r.strip()]


def _semantic_split(text: str) -> list[str]:
    """Split by semantic similarity between consecutive sentences.

    Groups sentences into chunks until cosine similarity with the next
    sentence drops below SEMANTIC_COSINE_THRESHOLD.
    Falls back to fixed-size if embeddings fail.
    """
    try:
        import numpy as np

        model = _build_split_model()
        if model is None:
            from services.embeddings import _load_model
            model = _load_model()
        if model is None:
            return []

        # Split into sentences
        import re
        sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if len(s.split()) >= 4]
        if len(sentences) < 2:
            return [text] if text.strip() else []

        # Embed all sentences in batch
        vectors = model.encode(
            [f"passage: {s}" for s in sentences],
            normalize_embeddings=True,
            batch_size=64,
            show_progress_bar=False,
        )

        # Group sentences greedily by cosine similarity
        groups: list[list[str]] = [[sentences[0]]]
        for i in range(1, len(sentences)):
            sim = float(np.dot(vectors[i - 1], vectors[i]))
            if sim >= SEMANTIC_COSINE_THRESHOLD:
                groups[-1].append(sentences[i])
            else:
                groups.append([sentences[i]])

        # Merge very short groups with previous
        merged: list[str] = []
        for group in groups:
            chunk_text = " ".join(group)
            if merged and _count_tokens(chunk_text) < 30:
                merged[-1] = merged[-1] + " " + chunk_text
            else:
                merged.append(chunk_text)

        # Cap max chunk size — split oversized semantic chunks with fixed splitter
        result: list[str] = []
        for chunk in merged:
            if _count_tokens(chunk) > settings.chunk_size_tokens * 1.5:
                result.extend(_fixed_split(chunk, "fixed"))
            else:
                result.append(chunk)

        logger.debug("semantic_split sentences=%d chunks=%d", len(sentences), len(result))
        return [r for r in result if r.strip()]

    except Exception as exc:
        logger.error("semantic_split_failed error=%s", exc)
        return []


# ── Chunk builder ──────────────────────────────────────────────────────────────

def _build_chunks(
    raw_texts: list[str],
    document_id: str,
    tenant_id: str,
    metadata: dict,
    doc_type: str,
    strategy: str,
) -> list[Chunk]:
    total = len(raw_texts)
    return [
        Chunk(
            id=str(uuid.uuid4()),
            document_id=document_id,
            tenant_id=tenant_id,
            text=text,
            token_count=_count_tokens(text),
            chunk_index=idx,
            total_chunks=total,
            parent_id=None,
            chunk_level="flat",
            doc_type=doc_type,
            strategy=strategy,
            metadata=metadata,
        )
        for idx, text in enumerate(raw_texts)
    ]


# ── File extractors ────────────────────────────────────────────────────────────

def _extract_pdf(content: bytes, filename: str) -> str:
    try:
        import io
        import pypdf
        reader = pypdf.PdfReader(io.BytesIO(content))
        pages = [page.extract_text() or "" for page in reader.pages]
        return "\n\n".join(pages)
    except ImportError:
        logger.warning("pypdf_not_installed falling_back_to_raw filename=%s", filename)
        return content.decode("utf-8", errors="replace")
    except Exception as exc:
        logger.error("pdf_extraction_failed filename=%s error=%s", filename, exc)
        return ""


def _extract_docx(content: bytes, filename: str) -> str:
    try:
        import io
        import docx
        doc = docx.Document(io.BytesIO(content))

        # Namespace prefix varies by docx version — strip it dynamically
        _W = doc.element.nsmap.get("w", "http://schemas.openxmlformats.org/wordprocessingml/2006/main")
        TAG_P   = f"{{{_W}}}p"
        TAG_TBL = f"{{{_W}}}tbl"
        TAG_TR  = f"{{{_W}}}tr"
        TAG_TC  = f"{{{_W}}}tc"

        # Map paragraph XML elements to their Paragraph objects for style access
        para_map = {p._element: p for p in doc.paragraphs}

        parts: list[str] = []
        for child in doc.element.body:
            tag = child.tag

            if tag == TAG_P:
                para = para_map.get(child)
                if para is None:
                    continue
                text = para.text.strip()
                if not text:
                    continue
                # Mark heading paragraphs so classifier sees header_density > 0
                if para.style and para.style.name.startswith("Heading"):
                    parts.append(f"## {text}")
                else:
                    parts.append(text)

            elif tag == TAG_TBL:
                for row in child.iter(TAG_TR):
                    cells = [
                        tc.text_content().strip() if hasattr(tc, "text_content") else
                        "".join(n.text or "" for n in tc.iter() if n.text)
                        for tc in row.iter(TAG_TC)
                    ]
                    cells = [c for c in cells if c]
                    if cells:
                        parts.append(" | ".join(cells))

        return "\n\n".join(parts)

    except ImportError:
        logger.warning("python_docx_not_installed falling_back_to_raw filename=%s", filename)
        return content.decode("utf-8", errors="replace")
    except Exception as exc:
        logger.error("docx_extraction_failed filename=%s error=%s", filename, exc)
        return ""


def _extract_html(content: bytes, filename: str) -> str:
    try:
        from html.parser import HTMLParser

        class _TextExtractor(HTMLParser):
            def __init__(self):
                super().__init__()
                self._parts: list[str] = []
                self._skip = False

            def handle_starttag(self, tag, attrs):
                if tag in ("script", "style"):
                    self._skip = True

            def handle_endtag(self, tag):
                if tag in ("script", "style"):
                    self._skip = False

            def handle_data(self, data):
                if not self._skip and data.strip():
                    self._parts.append(data.strip())

        extractor = _TextExtractor()
        extractor.feed(content.decode("utf-8", errors="replace"))
        return " ".join(extractor._parts)
    except Exception as exc:
        logger.error("html_extraction_failed filename=%s error=%s", filename, exc)
        return content.decode("utf-8", errors="replace")
