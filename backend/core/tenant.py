"""Tenant resolution middleware: extracts and validates tenant_id from every request."""

import logging
from typing import Callable

from fastapi import Request, Response, HTTPException, status
from fastapi.responses import JSONResponse
from jose import JWTError, jwt
from starlette.middleware.base import BaseHTTPMiddleware

from core.config import settings

logger = logging.getLogger(__name__)

TENANT_ID_HEADER = "X-Tenant-ID"
REQUEST_TENANT_KEY = "tenant_id"

# Paths that don't require tenant resolution (auth, health, observability, SSO)
_TENANT_EXEMPT_PATHS = {
    "/health",
    "/metrics",
    "/api/v1/auth/login",
    "/api/v1/auth/refresh",
    "/api/v1/auth/logout",
    "/api/v1/auth/sso/providers",
    "/api/v1/public/tenant-branding",  # public branding lookup, tenant in query param
    "/docs",
    "/openapi.json",
    "/redoc",
}

# Path prefixes exempt from tenant resolution (SSO callbacks carry tenant in state)
_TENANT_EXEMPT_PREFIXES = (
    "/api/v1/auth/sso/",
    "/uploads/",  # static assets — public, tenant id is in the path itself
    # NOTE: /api/v1/widget/ is NOT exempt — middleware extracts tenant_id from widget JWT payload
)


class TenantMiddleware(BaseHTTPMiddleware):
    """Resolve tenant_id on every request and attach it to request.state.

    Resolution order:
    1. Subdomain: {tenant}.{BASE_DOMAIN}
    2. JWT claim: { tenant_id: "..." }
    3. HTTP header: X-Tenant-ID
    """

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        # Let CORS middleware handle preflight requests unobstructed
        path = request.url.path
        if (
            request.method == "OPTIONS"
            or path in _TENANT_EXEMPT_PATHS
            or path.startswith(_TENANT_EXEMPT_PREFIXES)
        ):
            return await call_next(request)

        tenant_id = (
            _extract_from_subdomain(request)
            or _extract_from_jwt(request)
            or _extract_from_header(request)
        )

        if not tenant_id:
            logger.warning("tenant_resolution_failed path=%s", request.url.path)
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={"detail": "Tenant could not be resolved"},
            )

        # __platform__ is the super-admin sentinel — valid, no schema lookup needed
        if tenant_id == "__platform__":
            request.state.tenant_id = tenant_id
            return await call_next(request)

        # Attach to request state so endpoints can read it
        request.state.tenant_id = tenant_id
        logger.debug("tenant_resolved tenant_id=%s path=%s", tenant_id, request.url.path)
        return await call_next(request)


def _extract_from_subdomain(request: Request) -> str | None:
    """Extract tenant from subdomain: {tenant}.{base_domain}."""
    host = request.headers.get("host", "")
    base = settings.base_domain
    if "." in host and host.endswith(f".{base}"):
        subdomain = host[: -(len(base) + 1)]
        if subdomain and subdomain != "www":
            return subdomain
    return None


def _extract_from_jwt(request: Request) -> str | None:
    """Extract tenant_id from Authorization JWT claim, without verifying signature here.

    The full signature verification happens in the auth dependency.
    We only decode to read the claim for routing purposes.

    Falls back to `?token=` query param for endpoints that can't send headers
    (e.g. EventSource/SSE).
    """
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header.removeprefix("Bearer ")
    else:
        token = request.query_params.get("token")
    if not token:
        return None
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret_key,
            algorithms=[settings.jwt_algorithm],
        )
        return payload.get("tenant_id")
    except JWTError:
        return None


def _extract_from_header(request: Request) -> str | None:
    """Extract tenant from X-Tenant-ID header."""
    return request.headers.get(TENANT_ID_HEADER)


def get_tenant_id(request: Request) -> str:
    """FastAPI dependency: returns validated tenant_id from request state."""
    tenant_id: str | None = getattr(request.state, REQUEST_TENANT_KEY, None)
    if not tenant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Tenant ID not found in request",
        )
    return tenant_id
