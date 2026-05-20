"""Tests for JWT creation, validation, RBAC, and password hashing."""

import pytest
from jose import jwt

from core.security import (
    Role,
    TokenScope,
    create_access_token,
    create_refresh_token,
    create_widget_token,
    decode_token,
    hash_password,
    verify_password,
)
from core.config import settings


class TestPasswordHashing:
    def test_hash_and_verify(self):
        hashed = hash_password("mysecretpassword")
        assert verify_password("mysecretpassword", hashed)

    def test_wrong_password_fails(self):
        hashed = hash_password("correct")
        assert not verify_password("wrong", hashed)

    def test_different_hashes_for_same_password(self):
        h1 = hash_password("same")
        h2 = hash_password("same")
        assert h1 != h2  # bcrypt includes random salt


class TestJWTCreation:
    def test_access_token_contains_expected_claims(self):
        token = create_access_token("user-123", "acme", Role.ADMIN)
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        assert payload["sub"] == "user-123"
        assert payload["tenant_id"] == "acme"
        assert payload["role"] == Role.ADMIN.value
        assert payload["scope"] == TokenScope.FULL.value

    def test_refresh_token_has_refresh_scope(self):
        token = create_refresh_token("user-123", "acme")
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        assert payload["scope"] == TokenScope.REFRESH.value

    def test_widget_token_has_widget_scope(self):
        token = create_widget_token("acme")
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        assert payload["scope"] == TokenScope.WIDGET.value
        assert payload["tenant_id"] == "acme"
        assert "sub" not in payload or payload.get("sub") is None or payload.get("sub") == ""

    def test_widget_token_expires_in_90_days(self):
        from datetime import datetime, timezone
        token = create_widget_token("acme")
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        exp = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
        iat = datetime.fromtimestamp(payload["iat"], tz=timezone.utc)
        diff_days = (exp - iat).days
        assert diff_days == settings.jwt_widget_expire_days


class TestJWTValidation:
    def test_decode_valid_token(self):
        token = create_access_token("u1", "acme", Role.OPERATOR)
        payload = decode_token(token)
        assert payload["sub"] == "u1"

    def test_decode_invalid_token_raises_http_exception(self):
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc_info:
            decode_token("not.a.valid.token")
        assert exc_info.value.status_code == 401

    def test_decode_tampered_token_raises(self):
        from fastapi import HTTPException
        token = create_access_token("u1", "acme", Role.OPERATOR)
        tampered = token[:-5] + "XXXXX"
        with pytest.raises(HTTPException):
            decode_token(tampered)


class TestConfigValidation:
    def test_forbidden_groq_model_id_raises(self):
        """The settings validator must reject forbidden model IDs."""
        from pydantic import ValidationError

        # Temporarily patch env to inject forbidden model ID
        with pytest.raises((ValidationError, ValueError)):
            from core.config import Settings
            Settings(
                groq_api_key="test",
                groq_model_fast="llama-3.1-405b",  # Forbidden
                groq_model_reasoning="meta-llama/llama-4-maverick-17b-128e-instruct",
                postgres_user="u",
                postgres_password="p",
                neo4j_password="p",
                jwt_secret_key="s" * 32,
            )
