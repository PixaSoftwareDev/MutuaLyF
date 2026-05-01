"""Fixed-size document chunking for MVP (Etapa 1).

Strategy: RecursiveCharacterTextSplitter with 512 tokens / 64 overlap.
Etapa 3 will introduce semantic and hierarchical chunking.
"""

import hashlib
import logging
import uuid
from dataclasses import dataclass, field
from functools import lru_cache

from langchain_text_splitters import RecursiveCharacterTextSplitter

from core.config import settings

logger = logging.getLogger(__name__)


@dataclass
class Chunk:
    """A single document chunk ready for embedding and storage."""

    id: str
    document_id: str
    tenant_id: str
    text: str
    token_count: int
    chunk_index: int
    total_chunks: int
    # Etapa 3 fields — null in MVP
    parent_id: str | None = None
    chunk_level: str = "flat"
    metadata: dict = field(default_factory=dict)

    @property
    def text_hash(self) -> str:
        return hashlib.sha256(self.text.encode()).hexdigest()


@lru_cache(maxsize=1)
def _build_splitter() -> RecursiveCharacterTextSplitter:
    """Build the text splitter once and cache. Settings are fixed at startup."""
    return RecursiveCharacterTextSplitter(
        chunk_size=settings.chunk_size_tokens,
        chunk_overlap=settings.chunk_overlap_tokens,
        length_function=_count_tokens,
        separators=["\n\n", "\n", ". ", " ", ""],
    )


def _count_tokens(text: str) -> int:
    """Approximate token count using whitespace split.

    tiktoken would be more accurate but adds latency. This is sufficient
    for the fixed-size MVP strategy where exact boundaries are not critical.
    """
    return len(text.split())


def chunk_document(
    text: str,
    document_id: str,
    tenant_id: str,
    metadata: dict | None = None,
) -> list[Chunk]:
    """Split a document's text into fixed-size overlapping chunks.

    Args:
        text: Full document text, already extracted from the original file.
        document_id: UUID of the parent document.
        tenant_id: Tenant that owns this document.
        metadata: Optional metadata propagated to each chunk (e.g., doc title, source).

    Returns:
        List of Chunk objects ordered by position in the source document.
    """
    if not text.strip():
        logger.warning("chunk_document_empty_text document_id=%s", document_id)
        return []

    splitter = _build_splitter()
    raw_chunks = splitter.split_text(text)

    # Build chunks, filtering empty strings first
    chunks: list[Chunk] = []
    for raw in raw_chunks:
        stripped = raw.strip()
        if not stripped:
            continue
        chunks.append(
            Chunk(
                id=str(uuid.uuid4()),
                document_id=document_id,
                tenant_id=tenant_id,
                text=stripped,
                token_count=_count_tokens(stripped),
                chunk_index=0,       # assigned below after filtering
                total_chunks=0,      # assigned below after filtering
                parent_id=None,
                chunk_level="flat",
                metadata=metadata or {},
            )
        )

    # Assign final index/total after empty-chunk filtering
    total = len(chunks)
    for idx, chunk in enumerate(chunks):
        chunk.chunk_index = idx
        chunk.total_chunks = total

    logger.info(
        "chunk_document_complete document_id=%s tenant_id=%s total_chunks=%d",
        document_id, tenant_id, total,
    )
    return chunks


def extract_text_from_bytes(content: bytes, mime_type: str, filename: str) -> str:
    """Extract plain text from uploaded file bytes.

    Supports: text/plain, application/pdf, .docx.
    Etapa 3 will add structured extraction for tables and mixed content.
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
        paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
        return "\n\n".join(paragraphs)
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
