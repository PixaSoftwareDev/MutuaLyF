"""Tests for JWT creation, validation, RBAC, and password hashing."""

import pytest
from jose import jwt

from core.security import (
    Role,
    TokenScope,
    create_access_token,
    create_refresh_token,
    create_widget_token,
    create_public_chat_token,
    _get_current_user_from_token,
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

    def test_widget_token_lives_ten_years_regardless_of_env(self):
        """El código instalado en la web del cliente no puede morir solo: la vida
        es fija (10 años) y NO depende de JWT_WIDGET_EXPIRE_DAYS (90 en los .env)."""
        from datetime import datetime, timezone
        from core.security import WIDGET_TOKEN_LIFETIME_DAYS
        token = create_widget_token("acme")
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        exp = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
        iat = datetime.fromtimestamp(payload["iat"], tz=timezone.utc)
        diff_days = (exp - iat).days
        assert diff_days == WIDGET_TOKEN_LIFETIME_DAYS >= 3650
        assert diff_days > settings.jwt_widget_expire_days


class TestChatTesterToken:
    """Token del tester del panel ("Probar chat", 2026-09-24).

    La marca de prueba viaja FIRMADA en el JWT: un token público no puede
    fabricarla, y un widget token ya no la habilita (antes bastaba mandar
    is_test=true en el body con scope widget).
    """

    def test_public_chat_token_has_no_test_claim(self):
        token = create_public_chat_token("acme")
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        assert payload["scope"] == TokenScope.PUBLIC_CHAT.value
        assert "test" not in payload
        assert _get_current_user_from_token(token).is_test is False

    def test_tester_token_carries_signed_test_claim(self):
        token = create_public_chat_token("acme", test=True)
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        assert payload["scope"] == TokenScope.PUBLIC_CHAT.value
        assert payload["test"] is True
        user = _get_current_user_from_token(token)
        assert user.is_test is True
        assert user.tenant_id == "acme"

    def test_tester_token_is_short_lived(self):
        from datetime import datetime, timezone
        token = create_public_chat_token("acme", test=True)
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        exp = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
        iat = datetime.fromtimestamp(payload["iat"], tz=timezone.utc)
        assert (exp - iat).total_seconds() <= 2 * 3600

    def test_test_claim_ignored_outside_public_chat_scope(self):
        """Un widget token (semipúblico, va en el HTML del cliente) con un claim
        `test` inyectado no debe convertirse en tester."""
        from datetime import datetime, timedelta, timezone
        now = datetime.now(timezone.utc)
        forged = jwt.encode(
            {"tenant_id": "acme", "scope": TokenScope.WIDGET.value, "test": True,
             "iat": now, "exp": now + timedelta(hours=1)},
            settings.jwt_secret_key, algorithm=settings.jwt_algorithm,
        )
        assert _get_current_user_from_token(forged).is_test is False


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


class TestJWTHardening:
    """Regresión de los fixes de la auditoría pre-producción."""

    @staticmethod
    def _encode(claims: dict) -> str:
        return jwt.encode(claims, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)

    @staticmethod
    def _exp():
        from datetime import datetime, timezone, timedelta
        return datetime.now(timezone.utc) + timedelta(minutes=5)

    def test_token_without_exp_is_rejected(self):
        """decode_token debe exigir 'exp' — un token sin expiración es inválido."""
        from fastapi import HTTPException
        token = self._encode({"sub": "u1", "tenant_id": "acme", "role": "admin", "scope": "full"})
        with pytest.raises(HTTPException) as exc:
            decode_token(token)
        assert exc.value.status_code == 401

    def test_unknown_role_degrades_to_operator_not_500(self):
        """Un rol fuera del enum no debe tirar 500 — degrada a OPERATOR."""
        from core.security import _get_current_user_from_token
        token = self._encode({"sub": "u1", "tenant_id": "acme", "role": "wizard", "scope": "full", "exp": self._exp()})
        user = _get_current_user_from_token(token)
        assert user.role == Role.OPERATOR

    def test_unknown_scope_degrades_to_widget_not_500(self):
        """Un scope fuera del enum no debe tirar 500 — degrada a WIDGET (menor privilegio)."""
        from core.security import _get_current_user_from_token
        token = self._encode({"sub": "u1", "tenant_id": "acme", "role": "admin", "scope": "superpower", "exp": self._exp()})
        user = _get_current_user_from_token(token)
        assert user.scope == TokenScope.WIDGET

    def test_valid_role_and_scope_preserved(self):
        """Un token bien formado conserva su rol y scope reales."""
        from core.security import _get_current_user_from_token
        token = self._encode({"sub": "u1", "tenant_id": "acme", "role": "admin", "scope": "full", "exp": self._exp()})
        user = _get_current_user_from_token(token)
        assert user.role == Role.ADMIN
        assert user.scope == TokenScope.FULL


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
                jwt_secret_key="s" * 32,
            )

    # ── Provider key validation (#5) ──────────────────────────────────────────
    @staticmethod
    def _base_kwargs(**over):
        kw = dict(
            postgres_user="u", postgres_password="p",
            jwt_secret_key="s" * 32,
            _env_file=None,  # aislar del .env real
        )
        kw.update(over)
        return kw

    def test_openai_provider_without_groq_key_is_ok(self):
        """Provider openai no exige GROQ_API_KEY (antes el boot caía)."""
        from core.config import Settings
        s = Settings(**self._base_kwargs(
            llm_provider="openai", embedding_provider="openai",
            openai_api_key="sk-test", groq_api_key="",
        ))
        assert s.groq_api_key == ""
        assert s.openai_api_key == "sk-test"

    def test_openai_provider_without_openai_key_raises(self):
        """Si el provider activo es openai, falta OPENAI_API_KEY debe fallar."""
        from pydantic import ValidationError
        from core.config import Settings
        with pytest.raises((ValidationError, ValueError)):
            Settings(**self._base_kwargs(
                llm_provider="openai", embedding_provider="local",
                openai_api_key="", groq_api_key="",
            ))

    def test_groq_provider_without_groq_key_raises(self):
        """Si el provider activo es groq, falta GROQ_API_KEY debe fallar."""
        from pydantic import ValidationError
        from core.config import Settings
        with pytest.raises((ValidationError, ValueError)):
            Settings(**self._base_kwargs(
                llm_provider="groq", embedding_provider="local",
                groq_api_key="",
            ))
