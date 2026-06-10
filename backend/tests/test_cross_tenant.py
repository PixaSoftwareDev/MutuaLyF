"""Cross-tenant contamination tests — mandatory, always run when touching middleware or DB code.

These tests verify that tenant A cannot access or influence tenant B's data.
Run these whenever tenant resolution, middleware, or database code is modified.
"""

import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch

from main import app
from core.security import create_access_token, Role
from core.database import _validate_tenant_id

client = TestClient(app, raise_server_exceptions=False)


def _auth_header(tenant_id: str, role: Role = Role.OPERATOR) -> dict:
    token = create_access_token(f"user-{tenant_id}", tenant_id, role)
    return {"Authorization": f"Bearer {token}", "X-Tenant-ID": tenant_id}


class TestTokenCrossContamination:
    """JWT tokens must not grant access to another tenant's resources."""

    def test_tenant_a_token_resolves_to_tenant_a_regardless_of_header(self):
        """JWT tenant_a overrides X-Tenant-ID: tenant_b in middleware resolution.

        The middleware prefers JWT over header. The orchestrator then runs under
        tenant_a — not tenant_b. This is the cross-tenant protection.
        """
        token_a = create_access_token("user-a", "tenant_a", Role.ADMIN)

        captured_tenant_id = []

        async def _mock_orchestrator(question, tenant_id, **kwargs):
            captured_tenant_id.append(tenant_id)
            return {"answer": "ok", "sources": [], "intent_label": None, "intent_confidence": None, "from_cache": False, "latency_ms": 1}

        with patch("services.orchestrator.handle_query", new=_mock_orchestrator):
            response = client.post(
                "/api/v1/query",
                json={"question": "test"},
                headers={
                    "Authorization": f"Bearer {token_a}",
                    "X-Tenant-ID": "tenant_b",  # Should be overridden by JWT
                },
            )

        assert response.status_code == 200
        # Orchestrator ran under tenant_a (from JWT), NOT tenant_b (from header)
        assert len(captured_tenant_id) == 1
        assert captured_tenant_id[0] == "tenant_a"

    def test_widget_token_cannot_access_other_tenant(self):
        """Widget token scoped to tenant_a is used under tenant_a regardless of header.

        Los widget tokens se validan ademas contra el hash registrado en
        `tenants.widget_token_hash` (revocacion). En tests no hay DB, asi que
        simulamos que el tenant tiene ESTE token registrado.
        """
        import hashlib
        from unittest.mock import AsyncMock
        from core.security import create_widget_token
        widget_token = create_widget_token("tenant_a")
        token_hash = hashlib.sha256(widget_token.encode()).hexdigest()

        captured_tenant_id = []

        async def _mock_orchestrator(question, tenant_id, **kwargs):
            captured_tenant_id.append(tenant_id)
            return {"answer": "ok", "sources": [], "intent_label": None, "intent_confidence": None, "from_cache": False, "latency_ms": 1}

        with patch("services.orchestrator.handle_query", new=_mock_orchestrator), \
             patch("core.security._get_widget_token_hash", new=AsyncMock(return_value=token_hash)):
            response = client.post(
                "/api/v1/query/widget",
                json={"question": "test"},
                headers={
                    "Authorization": f"Bearer {widget_token}",
                    "X-Tenant-ID": "tenant_b",  # JWT resolves tenant_a
                },
            )

        assert response.status_code == 200
        # Widget endpoint ran under tenant_a (from JWT), not tenant_b
        assert captured_tenant_id[0] == "tenant_a"

    def test_revoked_widget_token_is_rejected(self):
        """Un widget token cuyo hash NO coincide con el registrado → 401.

        Es la garantia de revocacion: al regenerar el token desde el admin,
        el anterior deja de servir aunque su JWT siga vigente.
        """
        import hashlib
        from unittest.mock import AsyncMock
        from core.security import create_widget_token
        old_token = create_widget_token("tenant_a")
        # El tenant tiene registrado OTRO hash (token regenerado)
        new_hash = hashlib.sha256(b"otro-token-mas-nuevo").hexdigest()

        with patch("core.security._get_widget_token_hash", new=AsyncMock(return_value=new_hash)):
            response = client.post(
                "/api/v1/query/widget",
                json={"question": "test"},
                headers={"Authorization": f"Bearer {old_token}", "X-Tenant-ID": "tenant_a"},
            )

        assert response.status_code == 401

    def test_super_admin_token_can_access_any_tenant(self):
        """Super-admin tokens should be able to operate across tenants (not 401/403)."""
        super_token = create_access_token("superadmin", "system", Role.SUPER_ADMIN)
        response = client.get(
            "/api/v1/tenants/tenant_a",
            headers={"Authorization": f"Bearer {super_token}"},
        )
        # Super admin token is accepted — any non-auth error is OK (tenant may not exist in test DB)
        assert response.status_code not in (401, 403)


class TestDatabaseSearchPathIsolation:
    """Verify that database operations use the correct search_path for each tenant."""

    def test_validate_tenant_id_prevents_schema_injection(self):
        """Malicious tenant IDs must be rejected before being used in SET search_path."""
        malicious_inputs = [
            "acme; DROP TABLE tenants; --",
            "acme' OR '1'='1",
            "../../../etc",
            "acme\x00evil",
            "acme public",
        ]
        for evil_id in malicious_inputs:
            with pytest.raises(ValueError):
                _validate_tenant_id(evil_id)

    def test_validate_tenant_id_accepts_valid_formats(self):
        valid_ids = ["acme", "my-company", "tenant123", "acme_corp"]
        for valid_id in valid_ids:
            result = _validate_tenant_id(valid_id)
            assert result is not None, f"Should have accepted: {valid_id!r}"

    def test_dash_normalized_to_underscore(self):
        assert _validate_tenant_id("my-company") == "my_company"


class TestTenantWidgetTokenIsolation:
    """Widget token tests — widget scope must be strictly read-only."""

    def test_widget_token_cannot_ingest(self):
        """Widget tokens must not be accepted on ingest endpoints."""
        from core.security import create_widget_token
        widget_token = create_widget_token("tenant_a")

        response = client.post(
            "/api/v1/ingest",
            headers={
                "Authorization": f"Bearer {widget_token}",
                "X-Tenant-ID": "tenant_a",
            },
        )
        # Widget tokens have scope=widget — ingest requires scope=full + operator role
        assert response.status_code in (401, 403, 422)

    def test_full_token_cannot_use_widget_endpoint(self):
        """Full access tokens must not be accepted on the widget-only endpoint."""
        full_token = create_access_token("user-a", "tenant_a", Role.OPERATOR)
        response = client.post(
            "/api/v1/query/widget",
            json={"question": "test"},
            headers={
                "Authorization": f"Bearer {full_token}",
                "X-Tenant-ID": "tenant_a",
            },
        )
        # Widget endpoint requires scope=widget — full token has scope=full
        assert response.status_code in (401, 403, 501)
