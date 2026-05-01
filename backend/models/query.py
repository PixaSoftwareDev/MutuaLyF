"""Pydantic schemas for the query endpoint."""

from typing import Any
from pydantic import BaseModel, Field


class QueryRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    language: str = Field(default="es", max_length=10)


class SourceChunk(BaseModel):
    chunk_id: str
    document_id: str
    document_title: str
    content_excerpt: str
    score: float


class QueryResponse(BaseModel):
    answer: str
    sources: list[SourceChunk]
    intent_label: str | None = None
    intent_confidence: float | None = None
    from_cache: bool = False
    latency_ms: int
