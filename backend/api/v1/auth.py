"""Authentication endpoints: login, refresh, logout."""

import logging
import re
import unicodedata
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


def _slugify(s: str) -> str:
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:50]


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


# ── Email-first lookup ────────────────────────────────────────────────────────

class LookupTenantBody(BaseModel):
    email: str = Field(..., max_length=320, min_length=3)


class LookupTenantMatch(BaseModel):
    tenant_id:     str
    display_name:  str
    logo_url:      str | None = None
    primary_color: str | None = None
    role:          str
    # match_via: 'domain' | 'email' — solo para debug interno, el frontend
    # no lo usa pero ayuda a entender en logs por qué se asocio.
    match_via:     str


class LookupTenantResponse(BaseModel):
    matches: list[LookupTenantMatch]


# Cache de rate limit en memoria, por IP. 5 lookups/min para frenar
# enumeracion masiva (bot probando emails al azar para mapear tenants).
_LOOKUP_RATE_CACHE: dict[str, list[float]] = {}
_LOOKUP_RATE_MAX = 5
_LOOKUP_RATE_WINDOW_S = 60


def _check_lookup_rate(request: Request) -> bool:
    import time as _t
    forwarded = request.headers.get("X-Forwarded-For")
    ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "unknown")
    now = _t.monotonic()
    hits = [t for t in _LOOKUP_RATE_CACHE.get(ip, []) if now - t < _LOOKUP_RATE_WINDOW_S]
    if len(hits) >= _LOOKUP_RATE_MAX:
        return False
    hits.append(now)
    _LOOKUP_RATE_CACHE[ip] = hits
    # Garbage collect lazy: si el cache crece mas de 10k IPs, lo achicamos.
    if len(_LOOKUP_RATE_CACHE) > 10_000:
        cutoff = now - _LOOKUP_RATE_WINDOW_S
        _LOOKUP_RATE_CACHE.clear()
    return True


@router.post("/lookup-tenant", response_model=LookupTenantResponse)
async def lookup_tenant(body: LookupTenantBody, request: Request) -> LookupTenantResponse:
    """Recibe un email y devuelve los tenants donde existe ese usuario.

    Para email-first login. Tres escenarios:
      1. Dominio mapeado → devuelve ese tenant (rapido, ~1ms).
      2. Dominio no mapeado (gmail, etc.) → escanea tenant_X.usuarios cross.
      3. Email en multiples tenants → devuelve todos, frontend muestra selector.

    Seguridad:
      - Rate limit 5/min/IP para frenar enumeracion masiva.
      - El endpoint NO indica si el email no existe vs si fue rate-limited —
        igual responde 200 con matches=[]. El frontend muestra "verificá tu
        email o contactá al admin" en ambos casos.
      - El password no se valida aca; eso es /login.
      - Super-admin NO aparece en los matches (esta en platform_users, no en
        tenant_X.usuarios).
    """
    if not _check_lookup_rate(request):
        # No 429 — devolvemos matches vacios para no diferenciar de "no existe".
        # El frontend muestra mensaje generico.
        return LookupTenantResponse(matches=[])

    email = body.email.lower().strip()
    if "@" not in email or len(email) > 320:
        return LookupTenantResponse(matches=[])

    domain = email.split("@", 1)[1]
    candidate_tenants: set[str] = set()
    via_map: dict[str, str] = {}  # tenant_id -> 'domain' | 'email'

    # ── Lookup 1: por dominio (rapido) ────────────────────────────────────────
    try:
        async with get_pg_session(None) as session:
            result = await session.execute(
                text("SELECT tenant_id FROM tenant_email_domains WHERE domain = :d"),
                {"d": domain},
            )
            for row in result.fetchall():
                tid = row[0]
                candidate_tenants.add(tid)
                via_map[tid] = "domain"
    except Exception as exc:
        logger.warning("lookup_tenant_domain_lookup_failed error=%s", exc)

    # ── Lookup 2: por email exacto en cada tenant ─────────────────────────────
    # Solo escanea si el dominio no nos dio match — para no agregar latencia
    # en el caso comun (dominio mapeado). Si el cliente queremos cubrir el
    # "Pedro corporativo de Nexo TAMBIEN es operador en Mutual con su mail
    # corporativo de Nexo", sacar este shortcut.
    if not candidate_tenants:
        try:
            async with get_pg_session(None) as session:
                tenants_result = await session.execute(
                    text("SELECT id FROM tenants WHERE status != 'suspended'")
                )
                tenant_ids = [r[0] for r in tenants_result.fetchall()]

            for tid in tenant_ids:
                try:
                    async with get_pg_session(tid) as session:
                        r = await session.execute(
                            text("SELECT 1 FROM usuarios WHERE email = :e AND is_active = TRUE LIMIT 1"),
                            {"e": email},
                        )
                        if r.scalar() is not None:
                            candidate_tenants.add(tid)
                            via_map[tid] = "email"
                except Exception:
                    # Schema puede no existir aun (tenant a medio provisionar)
                    continue
        except Exception as exc:
            logger.warning("lookup_tenant_email_lookup_failed error=%s", exc)

    if not candidate_tenants:
        return LookupTenantResponse(matches=[])

    # ── Resolver branding + rol per tenant ────────────────────────────────────
    matches: list[LookupTenantMatch] = []
    for tid in candidate_tenants:
        try:
            async with get_pg_session(None) as session:
                t_row = await session.execute(
                    text(
                        "SELECT id, name, status FROM tenants WHERE id = :tid AND status != 'suspended'"
                    ),
                    {"tid": tid},
                )
                t = t_row.mappings().fetchone()
                if t is None:
                    continue

            # Branding (logo + color)
            logo_url: str | None = None
            primary_color: str | None = None
            try:
                async with get_pg_session(None) as session:
                    b_row = await session.execute(
                        text("SELECT logo_url, primary_color FROM tenants WHERE id = :tid"),
                        {"tid": tid},
                    )
                    b = b_row.mappings().fetchone()
                    if b is not None:
                        logo_url = b["logo_url"]
                        primary_color = b["primary_color"]
            except Exception:
                pass

            # Rol del usuario en este tenant
            role = "operator"
            try:
                async with get_pg_session(tid) as session:
                    u_row = await session.execute(
                        text("SELECT role FROM usuarios WHERE email = :e AND is_active = TRUE"),
                        {"e": email},
                    )
                    u = u_row.fetchone()
                    if u is not None:
                        role = u[0] or "operator"
            except Exception:
                continue  # si no esta en la tabla, no se considera match valido

            matches.append(LookupTenantMatch(
                tenant_id=tid,
                display_name=t["name"],
                logo_url=logo_url,
                primary_color=primary_color,
                role=role,
                match_via=via_map.get(tid, "email"),
            ))
        except Exception as exc:
            logger.warning("lookup_tenant_resolve_failed tenant=%s error=%s", tid, exc)

    # Sort: tenants con match por dominio primero, despues por display_name
    matches.sort(key=lambda m: (m.match_via != "domain", m.display_name.lower()))
    return LookupTenantResponse(matches=matches)


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

    raw_tenant = (
        request.headers.get("X-Tenant-ID")
        or _tenant_from_subdomain(request, settings.base_domain)
    )
    tenant_id = _slugify(raw_tenant) if raw_tenant and raw_tenant != "__platform__" else raw_tenant or None
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
            from core.audit import record as audit, fire_and_log
            fire_and_log(audit(
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
        from core.audit import record as audit, fire_and_log
        fire_and_log(audit(
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

    # Brute-force lockout per email: chequear ANTES de bcrypt (que es caro).
    # Si Redis cae, fail-open: permitir el login (mejor que bloquear todos los
    # logins si Redis tiene un hiccup) pero loguear warning.
    email_norm = form.username.lower().strip()
    fail_key = f"{tenant_id}:login_failed:{email_norm}"
    try:
        from core.database import get_redis_cache as _redis_for_lock
        _r = _redis_for_lock()
        _current = await _r.get(fail_key)
        if _current is not None and int(_current) >= settings.login_max_fails:
            _ttl = await _r.ttl(fail_key)
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Demasiados intentos fallidos. Probá de nuevo en {max(_ttl, 60)} segundos.",
                headers={"Retry-After": str(max(_ttl, 60))},
            )
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("login_lockout_check_unavailable tenant=%s error=%s", tenant_id, exc)

    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            select(User).where(User.email == email_norm, User.is_active == True)
        )
        user = result.scalar_one_or_none()

    if user is None or not verify_password(form.password, user.hashed_password):
        from core.audit import record as audit, fire_and_log
        from core.database import get_redis_cache
        # Fail-open on Redis errors: a flaky cache must not turn a bad-password 401 into a 500.
        fails: int = 0
        try:
            redis = get_redis_cache()
            fails = await redis.incr(fail_key)
            await redis.expire(fail_key, settings.login_lockout_window_s)
        except Exception as exc:
            logger.warning("brute_force_counter_unavailable tenant=%s error=%s", tenant_id, exc)
        detail_extra: dict = {"reason": "invalid_credentials", "attempt": int(fails)}
        action = "auth.brute_force_alert" if fails >= 5 else "auth.login_failed"
        fire_and_log(audit(
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
    try:
        await redis.delete(fail_key)
    except Exception:
        pass  # no crítico, el TTL eventualmente limpia

    role = Role(user.role) if user.role in Role._value2member_map_ else Role.OPERATOR
    access_token = create_access_token(str(user.id), tenant_id, role, email=user.email)
    refresh_tok  = create_refresh_token(str(user.id), tenant_id)
    _set_refresh_cookie(response, refresh_tok)

    logger.info("login_success user=%s tenant=%s role=%s", user.email, tenant_id, role)
    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
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

    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
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

    from core.audit import record as audit, fire_and_log
    fire_and_log(audit(
        tenant_id=current_user.tenant_id or "__platform__",
        actor_id=current_user.user_id,
        actor_email=current_user.email,
        actor_role=current_user.role.value,
        action="auth.password_changed",
        request=request,
    ))
