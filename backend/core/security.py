"""JWT creation/validation, RBAC roles, and password hashing."""

import hashlib
import logging
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext

from core.config import settings

logger = logging.getLogger(__name__)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


class Role(str, Enum):
    SUPER_ADMIN = "super_admin"
    ADMIN = "admin"
    OPERATOR = "operator"


class TokenScope(str, Enum):
    FULL = "full"
    REFRESH = "refresh"
    WIDGET = "widget"  # Read-only, query-only, per-tenant


# ── Password ───────────────────────────────────────────────────────────────────

def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


# ── JWT creation ──────────────────────────────────────────────────────────────

def _create_token(
    data: dict[str, Any],
    expires_delta: timedelta,
    scope: TokenScope = TokenScope.FULL,
) -> str:
    payload = {
        **data,
        "scope": scope.value,
        "exp": datetime.now(timezone.utc) + expires_delta,
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def create_access_token(user_id: str, tenant_id: str, role: Role, email: str | None = None) -> str:
    data: dict[str, Any] = {"sub": user_id, "tenant_id": tenant_id, "role": role.value}
    if email:
        data["email"] = email
    return _create_token(
        data,
        timedelta(minutes=settings.jwt_expire_minutes),
        TokenScope.FULL,
    )


def create_refresh_token(user_id: str, tenant_id: str) -> str:
    return _create_token(
        {"sub": user_id, "tenant_id": tenant_id},
        timedelta(days=settings.jwt_refresh_expire_days),
        TokenScope.REFRESH,
    )


def create_widget_token(tenant_id: str) -> str:
    """Long-lived read-only token for the embeddable widget."""
    return _create_token(
        {"tenant_id": tenant_id},
        timedelta(days=settings.jwt_widget_expire_days),
        TokenScope.WIDGET,
    )


# ── JWT validation ─────────────────────────────────────────────────────────────

def decode_token(token: str) -> dict[str, Any]:
    """Decode and validate a JWT. Raises HTTPException on any failure."""
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret_key,
            algorithms=[settings.jwt_algorithm],
        )
        return payload
    except JWTError as exc:
        logger.warning("jwt_decode_failed error=%s", str(exc))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )


# ── FastAPI dependencies ───────────────────────────────────────────────────────

class CurrentUser:
    """Parsed identity from a validated JWT."""

    def __init__(self, user_id: str, tenant_id: str, role: Role, scope: TokenScope, email: str | None = None) -> None:
        self.user_id = user_id
        self.tenant_id = tenant_id
        self.role = role
        self.scope = scope
        self.email = email


def _get_current_user_from_token(token: str) -> CurrentUser:
    payload = decode_token(token)
    scope = TokenScope(payload.get("scope", TokenScope.FULL.value))
    user_id: str = payload.get("sub", "")
    tenant_id: str = payload.get("tenant_id", "")
    role_str: str = payload.get("role", Role.OPERATOR.value)
    email: str | None = payload.get("email")

    if not tenant_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing tenant_id in token")

    return CurrentUser(
        user_id=user_id,
        tenant_id=tenant_id,
        role=Role(role_str),
        scope=scope,
        email=email,
    )


async def get_current_user(token: str = Depends(oauth2_scheme)) -> CurrentUser:
    """Dependency: returns authenticated user. Scope must be 'full'."""
    user = _get_current_user_from_token(token)
    if user.scope != TokenScope.FULL:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid token scope")
    return user


async def get_widget_user(token: str = Depends(oauth2_scheme)) -> CurrentUser:
    """Dependency: validates widget-scoped token and checks it hasn't been revoked."""
    user = _get_current_user_from_token(token)
    if user.scope != TokenScope.WIDGET:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Widget token required")

    token_hash = hashlib.sha256(token.encode()).hexdigest()
    stored_hash = await _get_widget_token_hash(user.tenant_id)
    if stored_hash is None or stored_hash != token_hash:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Widget token revocado o inválido")

    return user


async def _get_widget_token_hash(tenant_id: str) -> str | None:
    """Return the stored widget token hash, cached in Redis for 5 min."""
    cache_key = f"{tenant_id}:widget_token_hash"
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        cached = await redis.get(cache_key)
        if cached is not None:
            return cached.decode() if isinstance(cached, bytes) else str(cached)
    except Exception:
        pass

    try:
        from core.database import get_pg_session
        from sqlalchemy import text
        async with get_pg_session(None) as session:
            result = await session.execute(
                text("SELECT widget_token_hash FROM tenants WHERE id = :tid"),
                {"tid": tenant_id},
            )
            row = result.fetchone()
            if row and row[0]:
                try:
                    from core.database import get_redis_cache
                    redis = get_redis_cache()
                    await redis.setex(cache_key, 300, row[0])
                except Exception:
                    pass
                return row[0]
    except Exception:
        logger.warning("widget_token_hash_lookup_failed tenant=%s", tenant_id)

    return None


def require_role(*roles: Role):
    """Dependency factory: ensures current user has one of the required roles."""

    async def _check(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{user.role}' not authorized. Required: {[r.value for r in roles]}",
            )
        return user

    return _check


# Tenant-scoped guards — super_admin is intentionally excluded.
# Super_admin has no tenant schema; their platform actions go through require_super_admin endpoints.
require_admin    = require_role(Role.ADMIN)
require_operator = require_role(Role.ADMIN, Role.OPERATOR)
require_super_admin = require_role(Role.SUPER_ADMIN)
# For endpoints that manage a tenant's config and should be reachable by both
# the tenant admin (for their own tenant) AND the platform super_admin (for any tenant).
# Handlers must still enforce tenant ownership for ADMIN.
require_admin_or_super = require_role(Role.ADMIN, Role.SUPER_ADMIN)
