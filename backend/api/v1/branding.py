"""Branding endpoints — tenant admin edits their visual identity.

- PATCH /admin/branding         → edit own tenant. Super-admin may use ?tenant_id=X to edit any tenant.
- POST  /admin/branding/logo    → upload logo file (multipart)
"""

import logging
import re
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from core.database import get_pg_session
from core.security import CurrentUser, Role, require_admin_or_super

logger = logging.getLogger(__name__)
router = APIRouter()

UPLOADS_ROOT = Path("/uploads")
MAX_LOGO_BYTES = 2 * 1024 * 1024  # 2 MB
ALLOWED_LOGO_TYPES = {"image/png", "image/jpeg", "image/svg+xml", "image/webp"}
EXT_BY_MIME = {
    "image/png":     "png",
    "image/jpeg":    "jpg",
    "image/svg+xml": "svg",
    "image/webp":    "webp",
}

HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")


def _resolve_target_tenant(current_user: CurrentUser, tenant_id_query: str | None) -> str:
    """Admin → own tenant. Super-admin → tenant_id query param (required for super)."""
    if current_user.role == Role.SUPER_ADMIN:
        if not tenant_id_query:
            raise HTTPException(status_code=400, detail="tenant_id query param is required for super_admin")
        return tenant_id_query
    # Admin: ignore query, always use own tenant
    if not current_user.tenant_id:
        raise HTTPException(status_code=400, detail="No tenant context")
    return current_user.tenant_id


def _validate_color(value: str | None, field_name: str) -> str | None:
    if value is None or value == "":
        return None
    if not HEX_COLOR_RE.match(value):
        raise HTTPException(status_code=400, detail=f"{field_name} debe ser un color hex (#RRGGBB)")
    return value


class BrandingUpdate(BaseModel):
    display_name:    str | None = Field(default=None, max_length=200)
    primary_color:   str | None = Field(default=None, max_length=9)
    secondary_color: str | None = Field(default=None, max_length=9)
    favicon_url:     str | None = Field(default=None, max_length=2000)


@router.get("/admin/branding")
async def get_branding(
    tenant_id: str | None = Query(default=None),
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Return current branding for the admin's tenant (or for the requested tenant if super_admin)."""
    target = _resolve_target_tenant(current_user, tenant_id)
    async with get_pg_session() as session:
        row = await session.execute(text("""
            SELECT id, name, display_name, logo_url, primary_color, secondary_color, favicon_url
            FROM tenants WHERE id = :tid LIMIT 1
        """), {"tid": target})
        t = row.mappings().fetchone()
    if not t:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return {
        "tenant_id":       t["id"],
        "display_name":    t["display_name"] or t["name"],
        "logo_url":        t["logo_url"],
        "primary_color":   t["primary_color"]   or "#99323D",
        "secondary_color": t["secondary_color"],
        "favicon_url":     t["favicon_url"],
    }


@router.patch("/admin/branding")
async def update_branding(
    body: BrandingUpdate,
    tenant_id: str | None = Query(default=None),
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Update tenant branding. Only sent fields are modified."""
    target = _resolve_target_tenant(current_user, tenant_id)

    updates: dict = {}
    if body.display_name is not None:
        name = body.display_name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="display_name no puede estar vacío")
        updates["display_name"] = name
    if body.primary_color is not None:
        updates["primary_color"] = _validate_color(body.primary_color, "primary_color")
    if body.secondary_color is not None:
        updates["secondary_color"] = _validate_color(body.secondary_color, "secondary_color") or None
    if body.favicon_url is not None:
        updates["favicon_url"] = body.favicon_url.strip() or None

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    set_sql = ", ".join(f"{k} = :{k}" for k in updates)
    params = {**updates, "tid": target}

    async with get_pg_session() as session:
        await session.execute(
            text(f"UPDATE tenants SET {set_sql}, updated_at = NOW() WHERE id = :tid"),
            params,
        )
        await session.commit()

    logger.info("branding_updated tenant=%s fields=%s by=%s", target, list(updates.keys()), current_user.user_id)
    return await get_branding(tenant_id=tenant_id, current_user=current_user)


@router.post("/admin/branding/logo")
async def upload_logo(
    file: UploadFile = File(...),
    tenant_id: str | None = Query(default=None),
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Upload a logo file. Stores under /uploads/{tenant_id}/logo.{ext} and sets logo_url."""
    target = _resolve_target_tenant(current_user, tenant_id)

    if file.content_type not in ALLOWED_LOGO_TYPES:
        raise HTTPException(status_code=400, detail="Formato no permitido. Usá PNG, JPG, SVG o WEBP.")

    contents = await file.read()
    if len(contents) > MAX_LOGO_BYTES:
        raise HTTPException(status_code=400, detail="El archivo supera el máximo de 2MB")
    if len(contents) == 0:
        raise HTTPException(status_code=400, detail="Archivo vacío")

    ext = EXT_BY_MIME[file.content_type]
    tenant_dir = UPLOADS_ROOT / target
    tenant_dir.mkdir(parents=True, exist_ok=True)

    # Cache-busting: include a short hash so browsers refresh
    short = uuid.uuid4().hex[:8]
    filename = f"logo-{short}.{ext}"
    target_path = tenant_dir / filename

    # Delete previous logo files (keep only the latest)
    for old in tenant_dir.glob("logo-*"):
        try: old.unlink()
        except Exception: pass

    target_path.write_bytes(contents)

    public_url = f"/uploads/{target}/{filename}"

    async with get_pg_session() as session:
        await session.execute(
            text("UPDATE tenants SET logo_url = :url, updated_at = NOW() WHERE id = :tid"),
            {"url": public_url, "tid": target},
        )
        await session.commit()

    logger.info("logo_uploaded tenant=%s path=%s size=%d", target, public_url, len(contents))
    return {"logo_url": public_url}


@router.delete("/admin/branding/logo", status_code=status.HTTP_204_NO_CONTENT)
async def delete_logo(
    tenant_id: str | None = Query(default=None),
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Remove tenant logo (UI falls back to initial)."""
    target = _resolve_target_tenant(current_user, tenant_id)
    tenant_dir = UPLOADS_ROOT / target
    if tenant_dir.exists():
        for old in tenant_dir.glob("logo-*"):
            try: old.unlink()
            except Exception: pass
    async with get_pg_session() as session:
        await session.execute(
            text("UPDATE tenants SET logo_url = NULL, updated_at = NOW() WHERE id = :tid"),
            {"tid": target},
        )
        await session.commit()
