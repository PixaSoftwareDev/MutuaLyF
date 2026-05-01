"""Shared pytest fixtures."""

import os
import pytest
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, MagicMock, patch

# Load test env before any app import
os.environ.setdefault("ENV_FILE", ".env.test")
if os.path.exists(".env.test"):
    from dotenv import load_dotenv
    load_dotenv(".env.test", override=True)
else:
    # Set required env vars inline so tests run without a file
    os.environ.update({
        "GROQ_API_KEY": "test_key",
        "POSTGRES_USER": "test",
        "POSTGRES_PASSWORD": "test",
        "NEO4J_PASSWORD": "test",
        "JWT_SECRET_KEY": "test_secret_key_at_least_32_chars_long!!",
    })

from main import app
from core.config import settings


@pytest.fixture
def client():
    """Sync test client — use for endpoint tests that don't need async."""
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


@pytest.fixture
def tenant_a_headers():
    """Request headers scoped to tenant_a."""
    return {"X-Tenant-ID": "tenant_a"}


@pytest.fixture
def tenant_b_headers():
    """Request headers scoped to tenant_b."""
    return {"X-Tenant-ID": "tenant_b"}


@pytest.fixture
def admin_token_tenant_a():
    """Valid admin JWT for tenant_a."""
    from core.security import create_access_token, Role
    return create_access_token("user-001", "tenant_a", Role.ADMIN)


@pytest.fixture
def admin_token_tenant_b():
    from core.security import create_access_token, Role
    return create_access_token("user-002", "tenant_b", Role.ADMIN)
