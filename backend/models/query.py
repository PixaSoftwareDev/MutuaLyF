"""Pydantic schemas for the query endpoint."""

from pydantic import BaseModel, Field


class ConversationTurn(BaseModel):
    role: str   # "user" | "bot"
    content: str = Field(..., max_length=2000)


class QueryRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    language: str = Field(default="es", max_length=10)
    conversation_history: list[ConversationTurn] = Field(default_factory=list, max_length=20)


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
