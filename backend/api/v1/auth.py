"""Authentication endpoints: login, refresh, logout."""

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, Field
from sqlalchemy import select, text

from core.database import get_pg_session
from core.security import (
    Role,
    create_access_token,
    create_refresh_token,
    decode_token,
    get_current_user,
    hash_password,
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
    """Exchange credentials for an access token.

    Super-admin: omit X-Tenant-ID — checked against platform_users table.
    Tenant user: provide X-Tenant-ID — checked against tenant's usuarios table.
    """
    from core.config import settings

    tenant_id = (
        request.headers.get("X-Tenant-ID")
        or _tenant_from_subdomain(request, settings.base_domain)
    )
    # Treat the platform sentinel as "no tenant" for login purposes
    if tenant_id == "__platform__":
        tenant_id = None

    # ── Super-admin login (no tenant) ─────────────────────────────────────────
    if not tenant_id:
        async with get_pg_session(None) as session:
            result = await session.execute(
                text(
                    "SELECT id, name, hashed_password FROM platform_users "
                    "WHERE email = :email AND is_active = true"
                ),
                {"email": form.username.lower().strip()},
            )
            pu = result.mappings().fetchone()

        if pu is None or not verify_password(form.password, pu["hashed_password"]):
            import asyncio
            from core.audit import record as audit
            asyncio.ensure_future(audit(
                tenant_id="__platform__",
                actor_id="unknown",
                actor_email=form.username,
                actor_role="unknown",
                action="auth.login_failed",
                detail={"reason": "invalid_credentials"},
                request=request,
            ))
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid credentials",
                headers={"WWW-Authenticate": "Bearer"},
            )

        access_token = create_access_token(str(pu["id"]), "__platform__", Role.SUPER_ADMIN, email=form.username.lower().strip())
        refresh_tok  = create_refresh_token(str(pu["id"]), "__platform__")
        _set_refresh_cookie(response, refresh_tok)

        logger.info("superadmin_login email=%s", form.username)
        import asyncio
        from core.audit import record as audit
        asyncio.ensure_future(audit(
            tenant_id="__platform__",
            actor_id=str(pu["id"]),
            actor_email=form.username,
            actor_role="super_admin",
            action="auth.login",
            request=request,
        ))

        return TokenResponse(access_token=access_token, expires_in=settings.jwt_expire_minutes * 60)

    # ── Tenant user login ─────────────────────────────────────────────────────
    from db.tenant_models import User

    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            select(User).where(User.email == form.username.lower().strip(), User.is_active == True)
        )
        user = result.scalar_one_or_none()

    if user is None or not verify_password(form.password, user.hashed_password):
        import asyncio
        from core.audit import record as audit
        from core.database import get_redis_cache
        redis = get_redis_cache()
        key = f"{tenant_id}:login_failed:{form.username.lower().strip()}"
        fails = await redis.incr(key)
        await redis.expire(key, 600)  # ventana de 10 min
        detail_extra: dict = {"reason": "invalid_credentials", "attempt": int(fails)}
        action = "auth.brute_force_alert" if fails >= 5 else "auth.login_failed"
        asyncio.ensure_future(audit(
            tenant_id=tenant_id,
            actor_id="unknown",
            actor_email=form.username,
            actor_role="unknown",
            action=action,
            detail=detail_extra,
            request=request,
        ))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Login exitoso → limpiar contador de fallos
    from core.database import get_redis_cache
    redis = get_redis_cache()
    await redis.delete(f"{tenant_id}:login_failed:{form.username.lower().strip()}")

    role = Role(user.role) if user.role in Role._value2member_map_ else Role.OPERATOR
    access_token = create_access_token(str(user.id), tenant_id, role, email=user.email)
    refresh_tok  = create_refresh_token(str(user.id), tenant_id)
    _set_refresh_cookie(response, refresh_tok)

    logger.info("login_success user=%s tenant=%s role=%s", user.email, tenant_id, role)
    import asyncio
    from core.audit import record as audit
    asyncio.ensure_future(audit(
        tenant_id=tenant_id,
        actor_id=str(user.id),
        actor_email=user.email,
        actor_role=role.value,
        action="auth.login",
        request=request,
    ))

    return TokenResponse(access_token=access_token, expires_in=settings.jwt_expire_minutes * 60)


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(request: Request, response: Response):
    """Exchange a refresh token cookie for a new access token."""
    from core.config import settings

    token_value = request.cookies.get("refresh_token")
    if not token_value:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No refresh token")

    payload = decode_token(token_value)
    if payload.get("scope") != "refresh":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token scope")

    user_id: str  = payload.get("sub", "")
    tenant_id: str = payload.get("tenant_id", "")

    # Super-admin refresh
    if tenant_id == "__platform__":
        async with get_pg_session(None) as session:
            result = await session.execute(
                text("SELECT id FROM platform_users WHERE id = :id AND is_active = true"),
                {"id": uuid.UUID(user_id)},
            )
            if not result.fetchone():
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
        access_token = create_access_token(user_id, "__platform__", Role.SUPER_ADMIN, email=payload.get("email"))
        return TokenResponse(access_token=access_token, expires_in=settings.jwt_expire_minutes * 60)

    # Tenant user refresh
    from db.tenant_models import User
    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            select(User).where(User.id == uuid.UUID(user_id), User.is_active == True)
        )
        user = result.scalar_one_or_none()

    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    role = Role(user.role) if user.role in Role._value2member_map_ else Role.OPERATOR
    access_token = create_access_token(user_id, tenant_id, role, email=user.email)
    return TokenResponse(access_token=access_token, expires_in=settings.jwt_expire_minutes * 60)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request, response: Response, current_user: CurrentUser = Depends(get_current_user)):
    """Invalidate session by clearing the refresh token cookie."""
    response.delete_cookie("refresh_token", httponly=True, samesite="strict")

    import asyncio
    from core.audit import record as audit
    asyncio.ensure_future(audit(
        tenant_id=current_user.tenant_id,
        actor_id=current_user.user_id,
        actor_email=current_user.email,
        actor_role=current_user.role.value,
        action="auth.logout",
        request=request,
    ))


def _set_refresh_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key="refresh_token",
        value=token,
        httponly=True,
        samesite="strict",
        max_age=60 * 60 * 24 * 30,
    )


def _tenant_from_subdomain(request: Request, base_domain: str) -> str | None:
    host = request.headers.get("host", "")
    if "." in host and host.endswith(f".{base_domain}"):
        subdomain = host[: -(len(base_domain) + 1)]
        if subdomain and subdomain != "www":
            return subdomain
    return None


# ── Account: profile + change password ────────────────────────────────────────

class MeResponse(BaseModel):
    id:         str
    email:      str
    name:       str
    role:       str
    tenant_id:  str | None
    sectors:    list[dict] = []


class UpdateMeRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(..., min_length=1)
    new_password:     str = Field(..., min_length=8, max_length=200)


async def _load_tenant_user(tenant_id: str, user_id: str) -> dict | None:
    async with get_pg_session(tenant_id) as session:
        r = await session.execute(text("""
            SELECT id, email, name, role, hashed_password
            FROM usuarios WHERE id = :id AND is_active = TRUE LIMIT 1
        """), {"id": user_id})
        row = r.mappings().fetchone()
        if not row:
            return None
        sectors_r = await session.execute(text("""
            SELECT s.id::text AS id, s.nombre
            FROM sectores s
            JOIN operador_sectores os ON os.sector_id = s.id
            WHERE os.operador_id = :uid AND s.is_active = TRUE
            ORDER BY s.nombre
        """), {"uid": user_id})
        sectors = [dict(s) for s in sectors_r.mappings().all()]
        return {**dict(row), "sectors": sectors}


@router.get("/me", response_model=MeResponse)
async def get_me(current_user: CurrentUser = Depends(get_current_user)):
    """Return profile of the currently authenticated user."""
    # Super-admin → no tenant schema, look in platform_users
    if current_user.role == Role.SUPER_ADMIN:
        async with get_pg_session(None) as session:
            r = await session.execute(text(
                "SELECT id, email, name FROM platform_users WHERE id = :id LIMIT 1"
            ), {"id": current_user.user_id})
            row = r.mappings().fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        return MeResponse(
            id=str(row["id"]), email=row["email"], name=row["name"],
            role="super_admin", tenant_id=None, sectors=[],
        )

    user = await _load_tenant_user(current_user.tenant_id, current_user.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return MeResponse(
        id=str(user["id"]), email=user["email"], name=user["name"],
        role=user["role"], tenant_id=current_user.tenant_id, sectors=user["sectors"],
    )


@router.patch("/me", response_model=MeResponse)
async def update_me(
    body: UpdateMeRequest,
    current_user: CurrentUser = Depends(get_current_user),
):
    """Allow the user to change only their display name. Email/role are admin-only."""
    new_name = body.name.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="El nombre no puede estar vacío")

    if current_user.role == Role.SUPER_ADMIN:
        async with get_pg_session(None) as session:
            await session.execute(text(
                "UPDATE platform_users SET name = :name WHERE id = :id"
            ), {"name": new_name, "id": current_user.user_id})
            await session.commit()
    else:
        async with get_pg_session(current_user.tenant_id) as session:
            await session.execute(text(
                "UPDATE usuarios SET name = :name, updated_at = NOW() WHERE id = :id"
            ), {"name": new_name, "id": current_user.user_id})
            await session.commit()

    return await get_me(current_user)


@router.post("/me/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: ChangePasswordRequest,
    request: Request,
    current_user: CurrentUser = Depends(get_current_user),
):
    """Change the current user's password. Requires current_password."""
    if body.current_password == body.new_password:
        raise HTTPException(status_code=400, detail="La contraseña nueva debe ser distinta a la actual")

    if current_user.role == Role.SUPER_ADMIN:
        async with get_pg_session(None) as session:
            r = await session.execute(text(
                "SELECT hashed_password FROM platform_users WHERE id = :id LIMIT 1"
            ), {"id": current_user.user_id})
            row = r.mappings().fetchone()
            if not row or not verify_password(body.current_password, row["hashed_password"]):
                raise HTTPException(status_code=400, detail="La contraseña actual no es correcta")
            await session.execute(text(
                "UPDATE platform_users SET hashed_password = :h WHERE id = :id"
            ), {"h": hash_password(body.new_password), "id": current_user.user_id})
            await session.commit()
    else:
        async with get_pg_session(current_user.tenant_id) as session:
            r = await session.execute(text(
                "SELECT hashed_password FROM usuarios WHERE id = :id LIMIT 1"
            ), {"id": current_user.user_id})
            row = r.mappings().fetchone()
            if not row or not verify_password(body.current_password, row["hashed_password"]):
                raise HTTPException(status_code=400, detail="La contraseña actual no es correcta")
            await session.execute(text(
                "UPDATE usuarios SET hashed_password = :h, updated_at = NOW() WHERE id = :id"
            ), {"h": hash_password(body.new_password), "id": current_user.user_id})
            await session.commit()

    import asyncio
    from core.audit import record as audit
    asyncio.ensure_future(audit(
        tenant_id=current_user.tenant_id or "__platform__",
        actor_id=current_user.user_id,
        actor_email=current_user.email,
        actor_role=current_user.role.value,
        action="auth.password_changed",
        request=request,
    ))
