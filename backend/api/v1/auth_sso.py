"""SSO OAuth 2.0 / OpenID Connect endpoints.

Supported providers:
  - google  — Google Workspace (accounts.google.com)
  - azure   — Microsoft Azure AD (login.microsoftonline.com)

Flow:
  1. Frontend: GET /api/v1/auth/sso/{provider}?tenant_id=demo
     → Backend generates signed state, redirects to provider
  2. Provider authenticates user, redirects back to callback URL
  3. Backend: GET /api/v1/auth/sso/{provider}/callback?code=...&state=...
     → Exchanges code for tokens, retrieves user info
     → Creates or updates user in tenant schema
     → Issues JWT, redirects to frontend /auth/sso-callback?token=...

State parameter is a signed token (itsdangerous) that encodes tenant_id + nonce.
CSRF protection: state is validated on callback before any DB access.
"""

import logging
import secrets
from typing import Literal
from urllib.parse import urlencode, quote

import httpx
from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

from core.config import settings
from core.security import create_access_token, create_refresh_token, hash_password, Role

logger = logging.getLogger(__name__)
router = APIRouter()

Provider = Literal["google", "azure"]

# Signed state expires in 10 minutes
_state_signer = URLSafeTimedSerializer(settings.jwt_secret_key, salt="sso-state")

_PROVIDERS: dict[str, dict] = {
    "google": {
        "auth_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "userinfo_url": "https://www.googleapis.com/oauth2/v3/userinfo",
        "scopes": "openid email profile",
    },
    "azure": {
        "auth_url": "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
        "token_url": "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
        "userinfo_url": "https://graph.microsoft.com/oidc/userinfo",
        "scopes": "openid email profile",
    },
}


def _provider_config(provider: Provider) -> dict:
    cfg = _PROVIDERS.get(provider)
    if not cfg:
        raise HTTPException(status_code=404, detail=f"Provider '{provider}' not supported")
    azure_tenant = settings.azure_tenant_id or "common"
    return {k: v.replace("{tenant}", azure_tenant) for k, v in cfg.items()}


def _client_credentials(provider: Provider) -> tuple[str, str]:
    if provider == "google":
        if not settings.google_enabled:
            raise HTTPException(status_code=501, detail="Google SSO not configured")
        return settings.google_client_id, settings.google_client_secret
    if provider == "azure":
        if not settings.azure_enabled:
            raise HTTPException(status_code=501, detail="Azure SSO not configured")
        return settings.azure_client_id, settings.azure_client_secret
    raise HTTPException(status_code=404, detail="Unknown provider")


def _redirect_uri(provider: Provider) -> str:
    return f"{settings.public_api_url}/api/v1/auth/sso/{provider}/callback"


# ── Providers availability endpoint — MUST be before /{provider} route ────────

@router.get("/auth/sso/providers")
async def list_providers():
    """Return which SSO providers are configured for this deployment."""
    return {
        "google": settings.google_enabled,
        "azure": settings.azure_enabled,
    }


# ── Step 1: Initiate OAuth flow ───────────────────────────────────────────────

@router.get("/auth/sso/{provider}")
async def sso_login(provider: Provider, tenant_id: str, request: Request):
    """Redirect user to OAuth provider login page.

    tenant_id is encoded in the signed state so we know which tenant to log into
    after the callback, regardless of subdomain.
    """
    _client_credentials(provider)  # validate configured
    cfg = _provider_config(provider)

    nonce = secrets.token_urlsafe(16)
    state = _state_signer.dumps({"tenant_id": tenant_id, "nonce": nonce})

    params = {
        "client_id": _client_credentials(provider)[0],
        "redirect_uri": _redirect_uri(provider),
        "response_type": "code",
        "scope": cfg["scopes"],
        "state": state,
        "prompt": "select_account",
    }
    if provider == "google":
        params["access_type"] = "offline"

    url = f"{cfg['auth_url']}?{urlencode(params)}"
    logger.info("sso_redirect provider=%s tenant_id=%s", provider, tenant_id)
    return RedirectResponse(url)


# ── Step 2: OAuth callback ────────────────────────────────────────────────────

@router.get("/auth/sso/{provider}/callback")
async def sso_callback(provider: Provider, code: str, state: str, request: Request):
    """Exchange OAuth code for tokens, provision user, issue JWT, redirect to frontend."""
    # ── Validate state (CSRF protection) ─────────────────────────────────────
    try:
        state_data = _state_signer.loads(state, max_age=600)
        tenant_id: str = state_data["tenant_id"]
    except (BadSignature, SignatureExpired, KeyError):
        logger.warning("sso_invalid_state provider=%s", provider)
        return _error_redirect("invalid_state")

    cfg = _provider_config(provider)
    client_id, client_secret = _client_credentials(provider)

    # ── Exchange code for access token ────────────────────────────────────────
    async with httpx.AsyncClient(timeout=10) as client:
        token_resp = await client.post(cfg["token_url"], data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": _redirect_uri(provider),
            "client_id": client_id,
            "client_secret": client_secret,
        })

    if token_resp.status_code != 200:
        logger.error("sso_token_exchange_failed provider=%s status=%d body=%s",
                     provider, token_resp.status_code, token_resp.text[:200])
        return _error_redirect("token_exchange_failed")

    tokens = token_resp.json()
    access_token_oauth = tokens.get("access_token")

    # ── Fetch user info ───────────────────────────────────────────────────────
    async with httpx.AsyncClient(timeout=10) as client:
        user_resp = await client.get(
            cfg["userinfo_url"],
            headers={"Authorization": f"Bearer {access_token_oauth}"},
        )

    if user_resp.status_code != 200:
        logger.error("sso_userinfo_failed provider=%s status=%d", provider, user_resp.status_code)
        return _error_redirect("userinfo_failed")

    user_info = user_resp.json()
    email: str | None = user_info.get("email")
    name: str = user_info.get("name") or user_info.get("displayName") or (email or "").split("@")[0]
    email_verified: bool = user_info.get("email_verified", True)

    if not email:
        return _error_redirect("no_email")

    if not email_verified:
        return _error_redirect("email_not_verified")

    # ── Provision or update user in tenant schema ─────────────────────────────
    try:
        jwt_token, role = await _provision_user(tenant_id, email, name, provider)
    except Exception as exc:
        logger.error("sso_provision_failed tenant=%s email=%s error=%s", tenant_id, email, exc)
        return _error_redirect("provision_failed")

    # ── Build refresh cookie + redirect to frontend ───────────────────────────
    from core.security import create_refresh_token as _create_refresh
    # NOTE: We can't set HttpOnly cookie on a redirect easily — frontend
    # handles token storage. Refresh token sent as short-lived URL param (10s TTL).
    # Frontend must immediately store it and clear from URL.
    refresh_tok = _create_refresh(jwt_token, tenant_id)

    redirect_url = (
        f"{settings.public_frontend_url}/auth/sso-callback"
        f"?token={quote(jwt_token)}"
        f"&tenant_id={quote(tenant_id)}"
        f"&email={quote(email)}"
        f"&role={quote(role)}"
    )
    logger.info("sso_success provider=%s tenant=%s email=%s role=%s", provider, tenant_id, email, role)
    return RedirectResponse(redirect_url)


# ── Internal helpers ──────────────────────────────────────────────────────────

async def _provision_user(tenant_id: str, email: str, name: str, provider: str) -> tuple[str, str]:
    """Find or create user in tenant schema. Returns (access_token, role_str)."""
    from core.database import get_pg_session
    from sqlalchemy import text

    async with get_pg_session(tenant_id) as session:
        result = await session.execute(
            text("SELECT id, role, is_active FROM usuarios WHERE email = :email"),
            {"email": email},
        )
        row = result.mappings().fetchone()

        if row:
            if not row["is_active"]:
                raise HTTPException(status_code=403, detail="User account is disabled")
            user_id = str(row["id"])
            role_str = row["role"]
        else:
            # New user — auto-provision with role=user
            import uuid
            user_id = str(uuid.uuid4())
            role_str = Role.USER.value
            # SSO users have no password — use a sentinel that can never match
            sentinel_hash = hash_password(secrets.token_urlsafe(32))
            await session.execute(text("""
                INSERT INTO usuarios (id, email, name, hashed_password, role, is_active)
                VALUES (:id, :email, :name, :hashed_password, :role, TRUE)
            """), {
                "id": user_id,
                "email": email,
                "name": name,
                "hashed_password": sentinel_hash,
                "role": role_str,
            })
            logger.info("sso_user_created tenant=%s email=%s provider=%s", tenant_id, email, provider)

    role = Role(role_str)
    access_token = create_access_token(user_id, tenant_id, role)
    return access_token, role_str


def _error_redirect(reason: str) -> RedirectResponse:
    url = f"{settings.public_frontend_url}/login?sso_error={reason}"
    return RedirectResponse(url, status_code=302)
