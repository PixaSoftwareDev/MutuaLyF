"""SQLAlchemy ORM models for per-tenant schema tables.

These are created inside each tenant's schema (tenant_{id}) via
the provisioning script, not via global Alembic migrations.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    """Tenant-scoped user accounts."""

    __tablename__ = "usuarios"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(256), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False, default="operator")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now, onupdate=_now)


class Document(Base):
    """Tenant-scoped document registry."""

    __tablename__ = "documentos"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    chunk_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    quality_gate_status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    uploaded_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now, onupdate=_now)


class ConsultaLog(Base):
    """Query audit log used for intent classification, clustering, and billing."""

    __tablename__ = "consultas_log"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    question_hash: Mapped[str] = mapped_column(String(64), nullable=False)  # SHA-256
    question_text: Mapped[str | None] = mapped_column(String(500), nullable=True)  # Truncated — for HDBSCAN
    intent_label: Mapped[str | None] = mapped_column(String(200), nullable=True)
    intent_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    cluster_candidate_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    cluster_status: Mapped[str] = mapped_column(String(20), nullable=False, default="unassigned")
    auto_learning_blocked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    quality_gate_status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    from_cache: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)

    __table_args__ = (
        Index("ix_consultas_log_cluster_created", "cluster_status", "created_at"),
        Index("ix_consultas_log_created", "created_at"),
    )


class Intention(Base):
    """Validated intentions (labels) discovered from user queries."""

    __tablename__ = "intenciones"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    label: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    example_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    auto_learned_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    model_version: Mapped[str | None] = mapped_column(String(50), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now, onupdate=_now)
