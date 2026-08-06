"""Shared pytest fixtures."""

import os
import pytest
from fastapi.testclient import TestClient

# Load test env before any app import. Se respeta ENV_FILE (default .env.test):
# con ENV_FILE=none dentro del contenedor la suite usa las credenciales reales
# del entorno, que es lo que necesitan los tests que hablan con Postgres.
os.environ.setdefault("ENV_FILE", ".env.test")
_env_file = os.environ["ENV_FILE"]
if os.path.exists(_env_file):
    from dotenv import load_dotenv
    load_dotenv(_env_file, override=True)
else:
    # Valores mínimos para arrancar sin archivo — setdefault, NO update: si el
    # entorno ya trae credenciales (contenedor), pisarlas rompe la conexión.
    for _k, _v in {
        "GROQ_API_KEY": "test_key",
        "POSTGRES_USER": "test",
        "POSTGRES_PASSWORD": "test",
        "NEO4J_PASSWORD": "test",
        "JWT_SECRET_KEY": "test_secret_key_at_least_32_chars_long!!",
    }.items():
        os.environ.setdefault(_k, _v)

from main import app


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
