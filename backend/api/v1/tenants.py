"""Tenant management endpoints (super-admin) + widget token generation."""

import logging

from fastapi import APIRouter, Depends, HTTPException, status

from core.security import CurrentUser, create_widget_token, require_super_admin, require_admin
from core.tenant import get_tenant_id
from core.config import settings
from models.tenant import TenantCreate, TenantResponse, WidgetTokenResponse

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("", response_model=TenantResponse, status_code=status.HTTP_201_CREATED)
async def create_tenant(
    payload: TenantCreate,
    current_user: CurrentUser = Depends(require_super_admin),
):
    """Provision a new tenant (super-admin only). Transactional — rolls back on failure."""
    logger.info("tenant_create_requested tenant_id=%s by=%s", payload.id, current_user.user_id)
    # NOTE: Full transactional onboarding implemented in scripts/provision_tenant.py step
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Tenant onboarding not yet implemented",
    )


@router.get("/{tenant_id}", response_model=TenantResponse)
async def get_tenant(
    tenant_id: str,
    current_user: CurrentUser = Depends(require_super_admin),
):
    raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="Not implemented")


@router.post("/{tenant_id}/widget-token", response_model=WidgetTokenResponse)
async def generate_widget_token(
    tenant_id: str,
    current_user: CurrentUser = Depends(require_admin),
):
    """Generate a long-lived widget_token (90 days) scoped to this tenant.

    The token is read-only and limited to the /query/widget endpoint.
    Admins can revoke it by generating a new one — the old token becomes stale
    once the system validates against the stored token hash (Etapa 2).
    """
    if current_user.role.value != "super_admin" and current_user.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot generate token for another tenant")

    token = create_widget_token(tenant_id)
    logger.info("widget_token_generated tenant_id=%s by=%s", tenant_id, current_user.user_id)
    return WidgetTokenResponse(
        widget_token=token,
        expires_in_days=settings.jwt_widget_expire_days,
        tenant_id=tenant_id,
    )
