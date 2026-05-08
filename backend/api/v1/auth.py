"""Authentication endpoints: login, refresh, logout."""

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from sqlalchemy import select

from core.database import get_pg_session
from core.security import (
    Role,
    create_access_token,
    create_refresh_token,
    decode_token,
    get_current_user,
    verify_password,
    CurrentUser,
)

logger = logging.getLogger(__name__)
router = APIRouter()


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


@router.post("/login", response_model=TokenResponse)
async def login(
    request: Request,
    form: Annotated[OAuth2PasswordRequestForm, Depends()],
    response: Response,
):
    """Exchange credentials for an access token. Refresh token set in HttpOnly cookie."""
    from db.tenant_models import User
    from core.config import settings

    # Login is exempt from TenantMiddleware, so resolve tenant here
    tenant_id = (
        request.headers.get("X-Tenant-ID")
        or _tenant_from_subdomain(request, settings.base_domain)
    )
    if not tenant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="X-Tenant-ID header is required for login",
        )

    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            select(User).where(User.email == form.username, User.is_active == True)
        )
        user = result.scalar_one_or_none()

    if user is None or not verify_password(form.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )

    role = Role(user.role) if user.role in Role._value2member_map_ else Role.OPERATOR
    access_token = create_access_token(str(user.id), tenant_id, role)
    refresh_tok = create_refresh_token(str(user.id), tenant_id)

    response.set_cookie(
        key="refresh_token",
        value=refresh_tok,
        httponly=True,
        samesite="strict",
        max_age=60 * 60 * 24 * 30,
    )

    logger.info("login_success user=%s tenant=%s role=%s", user.email, tenant_id, role)
    return TokenResponse(
        access_token=access_token,
        expires_in=settings.jwt_expire_minutes * 60,
    )


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(request: Request, response: Response):
    """Exchange a refresh token cookie for a new access token."""
    from db.tenant_models import User
    from core.config import settings

    token_value = request.cookies.get("refresh_token")
    if not token_value:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No refresh token")

    payload = decode_token(token_value)
    if payload.get("scope") != "refresh":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token scope")

    user_id: str = payload.get("sub", "")
    tenant_id: str = payload.get("tenant_id", "")

    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            select(User).where(User.id == uuid.UUID(user_id), User.is_active == True)
        )
        user = result.scalar_one_or_none()

    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    role = Role(user.role) if user.role in Role._value2member_map_ else Role.OPERATOR
    access_token = create_access_token(user_id, tenant_id, role)
    return TokenResponse(access_token=access_token, expires_in=settings.jwt_expire_minutes * 60)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(response: Response, _: CurrentUser = Depends(get_current_user)):
    """Invalidate session by clearing the refresh token cookie."""
    response.delete_cookie("refresh_token", httponly=True, samesite="strict")


def _tenant_from_subdomain(request: Request, base_domain: str) -> str | None:
    host = request.headers.get("host", "")
    if "." in host and host.endswith(f".{base_domain}"):
        subdomain = host[: -(len(base_domain) + 1)]
        if subdomain and subdomain != "www":
            return subdomain
    return None
