"""SQLAlchemy declarative base shared across all ORM models."""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass
