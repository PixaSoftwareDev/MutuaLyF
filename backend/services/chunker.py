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
from services.doc_classifier import ClassificationResult

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


# ── Contact / address block detection ────────────────────────────────────────
# Algunos chunks contienen datos de contacto (dirección postal, teléfono,
# email) sin que aparezcan literalmente las palabras "dirección" o "contacto"
# en el texto. Eso hace que queries tipo "¿dónde está?" / "dirección" no
# encuentren el chunk porque el embedding no tiene esas señales.
#
# Detectamos esos bloques por patrones (no por keywords) y le inyectamos al
# texto embebido un prefijo tipo "[Datos de contacto: dirección, teléfono]"
# para que el embedding capture la intención semántica del bloque.
#
# Genérico — no depende del nombre de la organización ni del idioma del cliente.

# Patrones que individualmente sugieren "info de contacto":
_PHONE_RE   = re.compile(r"(?:\+\d{1,3}[\s\-]?)?(?:\(?\d{2,4}\)?[\s\-]?)?\d{3,4}[\s\-]?\d{3,4}\b")
_EMAIL_RE   = re.compile(r"\b[\w.+\-]+@[\w\-]+\.[\w.\-]+\b")
_POSTAL_RE  = re.compile(r"\b(?:CP|C\.P\.|código postal)[\s:]*\d{3,5}\b", re.IGNORECASE)
# "Calle X 123" / "Av. X 567" / "Avenida X 89" — número al final tipico de calle
_STREET_RE  = re.compile(
    r"\b(?:Calle|Avenida|Av\.?|Boulevard|Bv\.?|Pasaje|Ruta|Camino|Diagonal|Plaza)\s+"
    r"[A-ZÁÉÍÓÚÑa-záéíóúñ\s\.]{2,40}\s+\d{1,5}\b"
)
_LOCATION_RE = re.compile(
    r"\b(?:Provincia|Departamento|Localidad|Ciudad|Municipio|Partido)\s+(?:de\s+)?[A-ZÁÉÍÓÚÑ]",
    re.IGNORECASE,
)
# Keywords explícitas de bloques de contacto/sede
_CONTACT_HEADER_RE = re.compile(
    r"\b(?:Sede(?:s)?(?:\s+(?:central|principal))?|Domicilio|Direcci[óo]n|"
    r"Datos\s+de\s+contacto|Contacto|Ubicaci[óo]n|D[óo]nde\s+estamos|How\s+to\s+find\s+us)\b",
    re.IGNORECASE,
)


def _detect_contact_block(text: str) -> dict[str, bool]:
    """Devuelve flags de qué tipos de contacto contiene el texto.

    Genérico: detecta por patrones (no keywords del dominio). Lo usamos para:
      1. Inyectar prefijo descriptivo al embedded_text → mejor retrieval
      2. Setear metadata flags para filtros futuros (queries de tipo contact)
    """
    has_phone   = bool(_PHONE_RE.search(text))
    has_email   = bool(_EMAIL_RE.search(text))
    has_street  = bool(_STREET_RE.search(text)) or bool(_POSTAL_RE.search(text))
    has_loc     = bool(_LOCATION_RE.search(text))
    has_header  = bool(_CONTACT_HEADER_RE.search(text))

    # Para considerar "bloque de contacto" requerimos al menos:
    # - un header explícito (alta confianza), O
    # - 2 señales fuertes combinadas (teléfono + dirección, etc.)
    signals = sum([has_phone, has_email, has_street, has_loc])
    is_contact = has_header or signals >= 2

    return {
        "is_contact": is_contact,
        "has_phone": has_phone,
        "has_email": has_email,
        "has_street": has_street,
        "has_location": has_loc,
    }


def _build_contact_prefix(flags: dict[str, bool]) -> str:
    """Construye un prefijo semántico para chunks de contacto.

    Resultado típico: '[Datos de contacto: dirección, teléfono, ubicación]'.
    Se inyecta al texto embebido para que el embedding capte la intención
    sin depender de que el texto literal mencione esas palabras.
    """
    parts: list[str] = []
    if flags["has_street"]:   parts.append("dirección")
    if flags["has_phone"]:    parts.append("teléfono")
    if flags["has_email"]:    parts.append("email")
    if flags["has_location"]: parts.append("ubicación")
    if not parts:
        parts.append("información de contacto")
    return f"[Datos de contacto: {', '.join(parts)}]"


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


# ── JSON aplanado: secciones alineadas a registros ────────────────────────────
# El extractor de JSON emite líneas "base[N].campo: valor". Para una lista de
# registros (nómina, catálogo), los splitters por tokens podían partir un
# registro al medio (mitad de los campos en un chunk, mitad en otro). Acá se
# corta SIEMPRE en el límite de un registro.
_JSON_RECORD_RE = re.compile(r"^([\w.]+)\[(\d+)\]")

# Palabras objetivo por parent al empaquetar registros — alineado al cap
# general de parents (~700), con margen para el header.
_JSON_PARENT_TARGET_WORDS = 600


def _json_record_sections(text: str) -> list[tuple[str, str]] | None:
    """Secciones (header, body) alineadas a registros para texto aplanado de JSON.

    Detecta si el texto es una lista de registros (≥3 índices del mismo array
    dominante). Agrupa registros ENTEROS en parents de hasta ~600 palabras y
    separa cada registro con línea en blanco — el split de children luego hace
    1 registro = 1 child, así cada embedding representa un solo registro.

    Devuelve None si el texto no tiene esa forma (sigue el camino estructural
    normal). Solo se invoca para mime application/json.
    """
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return None

    preamble: list[str] = []
    records: dict[tuple[str, str], list[str]] = {}   # (base, idx) → líneas
    order: list[tuple[str, str]] = []
    for ln in lines:
        m = _JSON_RECORD_RE.match(ln)
        if m:
            key = (m.group(1), m.group(2))
            if key not in records:
                records[key] = []
                order.append(key)
            records[key].append(ln)
        else:
            preamble.append(ln)

    if len(records) < 3:
        return None
    # Base dominante: si el JSON mezcla varios arrays, exigimos que uno
    # concentre el grueso de los registros para tratarlo como lista.
    from collections import Counter
    base_counts = Counter(base for base, _ in order)
    dominant_base, dominant_n = base_counts.most_common(1)[0]
    record_lines = sum(len(v) for v in records.values())
    if dominant_n < 3 or record_lines < 0.6 * len(lines):
        return None

    # Registros que no son del base dominante van al preámbulo (raro: JSON con
    # dos arrays grandes — preferimos no inventar dos listas).
    record_blocks: list[str] = []
    for key in order:
        block = "\n".join(records[key])
        if key[0] == dominant_base:
            record_blocks.append(block)
        else:
            preamble.append(block)

    sections: list[tuple[str, str]] = []
    if preamble:
        sections.append(("", "\n".join(preamble)))

    # Empaquetar registros enteros hasta el target — nunca partir uno.
    current: list[str] = []
    current_words = 0
    for block in record_blocks:
        block_words = _count_tokens(block)
        if current and current_words + block_words > _JSON_PARENT_TARGET_WORDS:
            sections.append((dominant_base, "\n\n".join(current)))
            current, current_words = [], 0
        current.append(block)
        current_words += block_words
    if current:
        sections.append((dominant_base, "\n\n".join(current)))

    return sections


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

    # ── SHORT: entire document is one parent ──────────────────────────────────
    # Trust the classifier result — it already checked total_words < threshold.
    # Do NOT re-check word count here; a short structured doc (e.g. a 3-article
    # internal memo) should still be split by article boundaries.
    if doc_type == "short":
        return _build_single_parent(text, document_id, tenant_id, doc_type, meta)

    # ── FAQ: split by question/answer pairs ──────────────────────────────────
    is_json_records = False
    if doc_type == "faq":
        sections = _faq_split(text)
    elif doc_type == "entity_list":
        # Lista de entidades: una sección por ítem (no agrupar por tamaño).
        sections = _entity_split(text)
    else:
        # JSON aplanado con forma de lista de registros → cortar por registro,
        # nunca por tokens ciegos. Solo aplica a uploads application/json.
        json_sections = (
            _json_record_sections(text)
            if meta.get("mime_type") == "application/json" else None
        )
        if json_sections:
            sections = json_sections
            is_json_records = True
        else:
            # 1. Split into structural parent sections (type-aware cap)
            sections = _structural_split(text, doc_type)

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

        # 2. Split parent body into small children for embedding.
        # Para entity_list, la entidad NO se sub-divide: cada ítem es UN child, así
        # su embedding representa una sola entidad y no una mezcla de varias.
        if doc_type == "entity_list":
            child_texts = [body] if body.strip() else []
        elif is_json_records:
            # 1 registro = 1 child (los registros vienen separados por línea en
            # blanco). El splitter genérico los re-empaquetaría hasta llenar el
            # chunk_size, mezclando varios registros en un embedding. Solo un
            # registro anómalamente largo se sub-divide.
            child_texts = []
            for r in body.split("\n\n"):
                r = r.strip()
                if not r:
                    continue
                if _count_tokens(r) > settings.child_chunk_size_words * 2:
                    child_texts.extend(t for t in _build_child_splitter().split_text(r) if t.strip())
                else:
                    child_texts.append(r)
            if not child_texts:
                child_texts = [body] if body.strip() else []
        else:
            child_texts = [t for t in _build_child_splitter().split_text(body) if t.strip()]
            if not child_texts:
                child_texts = [body] if body.strip() else []

        for c_text in child_texts:
            # Inject section header into child text before embedding.
            # This anchors the child's embedding to its document context:
            # "5.1 Plan de capacitación\nCada colaborador define..." embeds
            # much better than the fragment alone.
            #
            # Adicionalmente: si el chunk contiene datos de contacto/dirección
            # (detectado por patrones genéricos, no por keywords del dominio),
            # prependemos un prefijo descriptivo. Sin esto, queries tipo
            # "¿dónde está la sede?" no matchean el chunk si literalmente no
            # menciona "dirección" o "ubicación".
            contact_flags = _detect_contact_block(c_text)
            contact_prefix = _build_contact_prefix(contact_flags) if contact_flags["is_contact"] else ""

            header_prefix = f"[{header}]" if header else ""
            embedded_text = "\n".join(p for p in [contact_prefix, header_prefix, c_text] if p)

            # Para listas de entidades: extraer atributos "Campo: valor" del ítem a
            # metadata estructurada (attr_*). Habilita filtros/agregaciones a futuro
            # (Capa 3 Parte B) sin re-ingestar. Genérico, sin IA.
            entity_attrs = _extract_entity_attributes(c_text) if doc_type == "entity_list" else {}

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
                metadata={
                    **meta,
                    "section_header": header,
                    **entity_attrs,
                    # Flags semánticos para retrieval / análisis futuros
                    **({"has_contact_info": True, **{k: True for k, v in contact_flags.items() if v and k != "is_contact"}}
                       if contact_flags["is_contact"] else {}),
                },
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
    if mime_type == "application/json":
        return _extract_json(content, filename)
    logger.warning("unsupported_mime_type mime=%s filename=%s", mime_type, filename)
    return content.decode("utf-8", errors="replace")


# ── Hierarchical splitting helpers ────────────────────────────────────────────

_MAX_PARENT_WORDS = settings.max_parent_words
_MIN_PARENT_WORDS = settings.min_parent_words

# Per-type caps: structured and faq respect semantic units over word count.
# freeform/mixed keep the original 700-word cap.
_MAX_PARENT_WORDS_BY_TYPE: dict[str, int] = {
    "structured": 2000,   # full legal article / policy section
    "faq":         600,   # one Q+A pair (long answers)
    "mixed":       700,
    "freeform":    700,
    "short":       400,
    "unknown":     700,
}

# Threshold below which the whole document is a single parent.
# Must match _SHORT_DOC_THRESHOLD in doc_classifier.py.
_SHORT_DOC_THRESHOLD = 200

# FAQ question detector — same logic as doc_classifier but used for paragraph-level split
_FAQ_Q_RE = re.compile(
    r"^(?:\d+[\.\)]\s+[¿\w]"          # "1. ¿Qué..." / "1. What..."
    r"|[Pp]regunta\s*\d*\s*[:\.\-]"   # "Pregunta:" / "Pregunta 3."
    r"|[Qq][:\.\-]\s+"                 # "Q: "
    r"|[Pp][:\.\-]\s+"                 # "P: "
    r"|¿)",                            # starts with ¿
)


def _is_faq_question(para: str) -> bool:
    """Return True if a paragraph looks like a FAQ question."""
    s = para.strip()
    ends_with_q = s.rstrip('"\'»)').endswith("?")
    has_marker = bool(_FAQ_Q_RE.match(s))
    # Questions are usually concise; cap at 80 words to avoid false positives
    return (ends_with_q or has_marker) and len(s.split()) <= 80


def _faq_split(text: str) -> list[tuple[str, str]]:
    """Split FAQ text into (question, answer) pairs.

    Works line-by-line so it handles both formats:
      - "¿Pregunta?\nRespuesta." (single newline)
      - "¿Pregunta?\n\nRespuesta." (paragraph-separated)

    Each line that looks like a question starts a new pair.
    Answer lines accumulate until the next question line.
    Blank lines within an answer are preserved as paragraph breaks.
    """
    lines = text.splitlines()
    if not lines:
        return [("", text)]

    sections: list[tuple[str, str]] = []
    current_q = ""
    current_a: list[str] = []

    for line in lines:
        stripped = line.strip()
        if stripped and _is_faq_question(stripped):
            if current_q or current_a:
                sections.append((current_q, "\n".join(current_a).strip()))
            current_q = stripped
            current_a = []
        else:
            current_a.append(line)

    if current_q or current_a:
        sections.append((current_q, "\n".join(current_a).strip()))

    # Drop pairs where both question and answer are empty
    sections = [(q, a) for q, a in sections if q.strip() or a.strip()]

    return sections if sections else [("", text)]


# Marcador de ítem de una lista de entidades — espejo del de doc_classifier.
_ENTITY_MARKER_RE = re.compile(r"^\d+\.\d+(?:\.\d+)?[\s\)\.\-]")


def _entity_split(text: str) -> list[tuple[str, str]]:
    """Divide una lista de entidades en una sección por ítem.

    Cada ítem (bloque que empieza con 'N.M …') es su propia sección. El texto previo
    al primer ítem (título/preámbulo de la lista) se usa como header de contexto
    compartido, así cada chunk embebe '[título]\\n<entidad>' y su vector representa
    una sola entidad. Genérico: sirve para nóminas, catálogos, listados.
    """
    lines = text.splitlines()
    header_lines: list[str] = []
    entities: list[list[str]] = []
    current: list[str] | None = None
    for line in lines:
        if _ENTITY_MARKER_RE.match(line.strip()):
            if current is not None:
                entities.append(current)
            current = [line]
        elif current is None:
            header_lines.append(line)
        else:
            current.append(line)
    if current is not None:
        entities.append(current)

    # Header de contexto: SOLO el título de la lista (primera línea no vacía del
    # preámbulo), recortado. Un prefijo largo común a TODOS los ítems dominaría el
    # embedding y diluiría la discriminación entre entidades. La info general
    # (dirección, etc.) ya viene repetida dentro de cada entidad.
    header = next((h.strip().lstrip("[").rstrip("]") for h in header_lines if h.strip()), "")[:80]
    if not entities:
        return [(header, text)]
    return [(header, "\n".join(e).strip()) for e in entities]


# Línea "Campo: valor" — clave al inicio (letras/espacios, hasta 40 chars), valor
# hasta el fin de línea. Captura "Especialidad: Cardiología", "Precio: $100", etc.
_KV_RE = re.compile(
    r"^[ \t]*([A-Za-zÁÉÍÓÚÑáéíóúñ][\w áéíóúñÁÉÍÓÚÑ]{1,40}?)\s*:\s*(\S.*?)\s*$",
    re.MULTILINE,
)


def _normalize_attr_key(key: str) -> str:
    """Normaliza una clave de atributo: sin acentos, snake_case, ascii."""
    import unicodedata
    k = unicodedata.normalize("NFKD", key).encode("ascii", "ignore").decode().lower().strip()
    k = re.sub(r"[^a-z0-9]+", "_", k).strip("_")
    return k


def _extract_entity_attributes(text: str) -> dict[str, str]:
    """Extrae atributos 'Campo: valor' de una entidad → {attr_<clave>: valor}.

    Genérico y determinístico (regex, sin IA): sirve para nóminas, catálogos,
    listados de cualquier tenant. La clave se normaliza (sin acentos, snake_case)
    con prefijo 'attr_' para no colisionar con otros campos del payload de Qdrant.
    Primera ocurrencia gana; valores muy largos (>300) se descartan (no son atributos).
    """
    attrs: dict[str, str] = {}
    for m in _KV_RE.finditer(text):
        key = _normalize_attr_key(m.group(1))
        val = m.group(2).strip()
        if not key or not val or len(val) > 300:
            continue
        attr_key = f"attr_{key}"
        if attr_key not in attrs:
            attrs[attr_key] = val
    return attrs


def _build_single_parent(
    text: str,
    document_id: str,
    tenant_id: str,
    doc_type: str,
    meta: dict,
) -> tuple[list[HierarchicalChunk], list[Chunk]]:
    """Return one parent (the full document) with its children.

    Used for short documents where splitting would hurt coherence.
    Children are still created for fine-grained embedding search.
    """
    parent_id = str(uuid.uuid4())
    clean = text.strip()

    parent = HierarchicalChunk(
        id=parent_id,
        document_id=document_id,
        tenant_id=tenant_id,
        text=clean,
        token_count=_count_tokens(clean),
        chunk_index=0,
        total_chunks=1,
        section_header="",
        metadata=meta,
    )

    child_texts = [t for t in _build_child_splitter().split_text(clean) if t.strip()]
    if not child_texts:
        child_texts = [clean]

    children: list[Chunk] = []
    for idx, c_text in enumerate(child_texts):
        contact_flags = _detect_contact_block(c_text)
        contact_prefix = _build_contact_prefix(contact_flags) if contact_flags["is_contact"] else ""
        embedded_text = "\n".join(p for p in [contact_prefix, c_text] if p)

        children.append(Chunk(
            id=str(uuid.uuid4()),
            document_id=document_id,
            tenant_id=tenant_id,
            text=embedded_text,
            token_count=_count_tokens(embedded_text),
            chunk_index=idx,
            total_chunks=len(child_texts),
            parent_id=parent_id,
            chunk_level="child",
            doc_type=doc_type,
            strategy="single",
            metadata={**meta, "section_header": ""},
        ))

    logger.info(
        "chunk_hierarchical_complete document_id=%s parents=1 children=%d strategy=single",
        document_id, len(children),
    )
    return [parent], children


def _structural_split(text: str, doc_type: str = "unknown") -> list[tuple[str, str]]:
    """Detect document structural boundaries and split into (header, body) pairs.

    Boundaries recognised (in priority order):
      - Explicit ---CHUNK--- markers
      - Separator lines (4+ box-drawing or ASCII dash/equals chars)
      - Chapter-level keywords (CAPÍTULO, SECCIÓN, ARTÍCULO, …)
      - Numbered subsections (1.1 text, 2.3.4 text)
      - Single-level numbered headings (1. TITLE)
      - Markdown headers (## Title)

    For structured documents the per-section cap is raised to
    _MAX_PARENT_WORDS_BY_TYPE["structured"] (default 2000) so that a long
    article or clause is kept whole instead of being cut mid-sentence.
    Sections shorter than _MIN_PARENT_WORDS are merged into the previous one.

    Returns:
        List of (section_header, section_body) tuples.
        section_header is the boundary line itself (e.g. "5.1 Plan de…").
        section_body is all text until the next boundary.
    """
    max_words = _MAX_PARENT_WORDS_BY_TYPE.get(doc_type, _MAX_PARENT_WORDS)

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
        elif words <= max_words:
            result.append((header, body))
        else:
            # Section too long — split at paragraph boundaries, keep header on first part
            parts = _split_long_section(body, max_words)
            for i, part in enumerate(parts):
                part_header = header if i == 0 else f"{header} (cont. {i + 1})" if header else ""
                result.append((part_header, part))

    return result if result else [("", text)]


def _split_long_section(text: str, max_words: int | None = None) -> list[str]:
    """Split a section that exceeds max_words at paragraph boundaries.

    Falls back to the fixed splitter if there are no paragraph breaks.
    Never cuts mid-paragraph — always at a blank-line boundary.
    """
    cap = max_words if max_words is not None else _MAX_PARENT_WORDS
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if len(paragraphs) <= 1:
        return _fixed_split(text, "fixed")

    parts: list[str] = []
    current: list[str] = []
    current_words = 0

    for para in paragraphs:
        para_words = _count_tokens(para)
        if current_words + para_words > cap and current_words >= _MIN_PARENT_WORDS:
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


def _dedup_cell(s: str) -> str:
    """If s is the same string repeated N≥2 times consecutively, return one copy.

    Word exports table cells via lxml in a way that repeats each cell's text
    once per XML run/paragraph nesting level, producing "EliteEliteElite".
    This function detects and collapses any such N-repetition.
    """
    n = len(s)
    if n < 2:
        return s
    for period in range(1, n // 2 + 1):
        if n % period == 0:
            candidate = s[:period]
            if candidate * (n // period) == s:
                return candidate
    return s


def _row_to_natural(headers: list[str], values: list[str]) -> str:
    """Convert a table data row to natural language using its column headers.

    Domain-agnostic: works for any table structure in any document.
    Only pairs where both header and value are non-empty are included.
    Falls back to pipe-delimited if there aren't enough valid pairs.

    Example:
      headers = ["Certificacion", "Duracion", "Costo"]
      values  = ["NSA", "60 horas", "USD 199"]
      → "Certificacion: NSA. Duracion: 60 horas. Costo: USD 199."
    """
    pairs = [
        (h.strip(), v.strip())
        for h, v in zip(headers, values)
        if h.strip() and v.strip()
    ]
    if len(pairs) < 2:
        return " | ".join(v for v in values if v.strip())
    return ". ".join(f"{h}: {v}" for h, v in pairs) + "."


def _naturalize_pipe_tables(text: str) -> str:
    """Post-process extracted text: convert pipe-delimited table blocks to natural language.

    Identifies table regions (consecutive lines containing ' | '), treats the
    first row as the header, then rewrites each subsequent data row as
    'Header1: Value1. Header2: Value2.' — a format the embedding model and
    cross-encoder reranker both handle much better than raw pipe notation.

    The original pipe-delimited header row is preserved for BM25 / keyword
    matching; only data rows are converted.  Works for any domain.
    """
    lines = text.split("\n")
    result: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if " | " not in line:
            result.append(line)
            i += 1
            continue

        # Collect consecutive pipe-delimited lines as a table block
        block_start = i
        while i < len(lines) and " | " in lines[i]:
            i += 1
        block = lines[block_start:i]

        if len(block) < 2:
            # Single pipe row — keep as-is (no data rows to naturalize)
            result.extend(block)
            continue

        headers = [c.strip() for c in block[0].split(" | ")]
        result.append(block[0])  # keep original header for keyword search
        for data_line in block[1:]:
            values = [c.strip() for c in data_line.split(" | ")]
            natural = _row_to_natural(headers, values)
            result.append(natural)

    return "\n".join(result)


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
                    cells = []
                    for tc in row.iter(TAG_TC):
                        raw = "".join(n.text or "" for n in tc.iter() if n.text).strip()
                        cell_text = _dedup_cell(raw)
                        if cell_text:
                            cells.append(cell_text)
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


def _extract_json(content: bytes, filename: str) -> str:
    """Flatten JSON to readable text for chunking and embedding.

    Recursively walks the structure and emits key: value lines so the
    chunker and embeddings see natural language rather than raw syntax.
    Arrays of objects are expanded; primitive arrays are joined inline.
    """
    import json

    def _flatten(obj, prefix: str = "") -> list[str]:
        lines: list[str] = []
        if isinstance(obj, dict):
            for k, v in obj.items():
                label = f"{prefix}{k}" if not prefix else f"{prefix}.{k}"
                if isinstance(v, (dict, list)):
                    lines.extend(_flatten(v, label))
                else:
                    lines.append(f"{label}: {v}")
        elif isinstance(obj, list):
            for i, item in enumerate(obj):
                if isinstance(item, (dict, list)):
                    lines.extend(_flatten(item, f"{prefix}[{i}]"))
                else:
                    lines.append(f"{prefix}[{i}]: {item}")
        else:
            lines.append(f"{prefix}: {obj}")
        return lines

    try:
        raw = content.decode("utf-8", errors="replace")
        data = json.loads(raw)
        lines = _flatten(data)
        return "\n".join(lines)
    except json.JSONDecodeError:
        logger.warning("json_parse_failed filename=%s — treating as plain text", filename)
        return content.decode("utf-8", errors="replace")
    except Exception as exc:
        logger.error("json_extraction_failed filename=%s error=%s", filename, exc)
        return ""
