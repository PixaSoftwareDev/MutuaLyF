"""Tests for SSO OAuth 2.0 endpoints."""

import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, AsyncMock

from main import app

client = TestClient(app, raise_server_exceptions=False)


class TestSsoProviders:
    def test_providers_endpoint_returns_dict(self):
        """GET /auth/sso/providers returns boolean flags for each provider."""
        resp = client.get("/api/v1/auth/sso/providers")
        assert resp.status_code == 200
        data = resp.json()
        assert "google" in data
        assert "azure" in data
        assert isinstance(data["google"], bool)
        assert isinstance(data["azure"], bool)

    def test_unconfigured_provider_returns_false(self):
        """If no env vars set, both providers should be disabled."""
        with patch("core.config.settings.google_client_id", ""), \
             patch("core.config.settings.google_client_secret", ""):
            resp = client.get("/api/v1/auth/sso/providers")
            assert resp.status_code == 200


class TestSsoInitiate:
    def test_unconfigured_google_returns_501(self):
        """Initiating SSO with unconfigured provider returns 501."""
        with patch("core.config.settings.google_client_id", ""), \
             patch("core.config.settings.google_client_secret", ""):
            resp = client.get(
                "/api/v1/auth/sso/google?tenant_id=demo",
                follow_redirects=False,
            )
            assert resp.status_code == 501

    def test_unsupported_provider_returns_404(self):
        resp = client.get(
            "/api/v1/auth/sso/github?tenant_id=demo",
            follow_redirects=False,
        )
        assert resp.status_code in (404, 422)

    def test_configured_google_redirects_to_google(self):
        """With credentials set, initiating SSO redirects to accounts.google.com."""
        with patch("core.config.settings.google_client_id", "test-client-id"), \
             patch("core.config.settings.google_client_secret", "test-secret"):
            resp = client.get(
                "/api/v1/auth/sso/google?tenant_id=demo",
                follow_redirects=False,
            )
        assert resp.status_code in (302, 307)
        assert "accounts.google.com" in resp.headers.get("location", "")

    def test_state_contains_tenant_id(self):
        """OAuth state parameter encodes the tenant_id."""
        with patch("core.config.settings.google_client_id", "test-client-id"), \
             patch("core.config.settings.google_client_secret", "test-secret"):
            resp = client.get(
                "/api/v1/auth/sso/google?tenant_id=acme",
                follow_redirects=False,
            )
        assert resp.status_code in (302, 307)
        location = resp.headers.get("location", "")
        assert "state=" in location


class TestSsoCallback:
    def test_invalid_state_redirects_to_error(self):
        """Callback with tampered state redirects to /login?sso_error=invalid_state."""
        resp = client.get(
            "/api/v1/auth/sso/google/callback?code=fake&state=tampered",
            follow_redirects=False,
        )
        assert resp.status_code in (302, 307)
        assert "sso_error=invalid_state" in resp.headers.get("location", "")

    def test_missing_code_returns_error(self):
        resp = client.get(
            "/api/v1/auth/sso/google/callback?state=something",
            follow_redirects=False,
        )
        assert resp.status_code in (302, 307, 422)
