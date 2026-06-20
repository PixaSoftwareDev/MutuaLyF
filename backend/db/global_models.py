"""SQLAlchemy ORM models for global (non-tenant) tables."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Index,
    Integer,
    String,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Tenant(Base):
    """Global tenant registry.

    NOTA (deuda conocida): este modelo está INTENCIONALMENTE incompleto. La tabla
    real ``public.tenants`` tiene muchas más columnas (branding, config de WhatsApp,
    límites, contacto, etc.) que se gestionan por SQL crudo en ``api/v1/tenants.py``
    y en las migraciones, no por este ORM. Solo se mapean acá las columnas que algún
    código consume vía ORM. NO usar este modelo como fuente de verdad del schema y,
    en particular, NO habilitar autogenerate de Alembic contra él sin revisar el
    diff a mano: creería que faltan columnas y propondría DROPs destructivos.
    """

    __tablename__ = "tenants"

    id: Mapped[str] = mapped_column(String(50), primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    plan: Mapped[str] = mapped_column(String(20), nullable=False, default="starter")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="onboarding")
    admin_email: Mapped[str] = mapped_column(String(320), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now, onupdate=_now)
    widget_token_hash: Mapped[str | None] = mapped_column(String(256), nullable=True)


class PlatformUser(Base):
    """Global super-admin accounts — not tied to any tenant."""

    __tablename__ = "platform_users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(256), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now, onupdate=_now)


class UsageEvent(Base):
    """Per-query usage tracking for billing and quota enforcement."""

    __tablename__ = "usage_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    tenant_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    event_type: Mapped[str] = mapped_column(String(20), nullable=False)  # 'query' | 'ingest' | 'llm_tokens'
    value: Mapped[int] = mapped_column(Integer, nullable=False)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now, index=True
    )

    __table_args__ = (
        Index("ix_usage_events_tenant_created", "tenant_id", "created_at"),
    )
