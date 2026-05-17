"""Pydantic schemas for document ingestion and management."""

from datetime import datetime
from enum import Enum
from pydantic import BaseModel, Field


class DocumentStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"


class QualityGateStatus(str, Enum):
    PENDING = "pending"
    PASSED = "passed"
    SKIPPED = "skipped"


class DocumentIngestResponse(BaseModel):
    document_id: str
    status: DocumentStatus
    message: str


class DocumentResponse(BaseModel):
    id: str
    title: str
    filename: str | None = None
    status: DocumentStatus
    chunk_count: int
    quality_gate_status: QualityGateStatus
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


def document_response_from_row(row: dict) -> DocumentResponse:
    return DocumentResponse(**{k: str(v) if hasattr(v, "hex") else v for k, v in row.items()})
