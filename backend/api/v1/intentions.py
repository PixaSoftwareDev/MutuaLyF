"""Intentions panel: list, validate and manage discovered intents."""

import logging

from fastapi import APIRouter, Depends, status

from core.security import CurrentUser, require_admin
from core.tenant import get_tenant_id

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/intentions")
async def list_intentions(
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    """List all intentions for the tenant, grouped by confidence band."""
    # NOTE: Implemented in Etapa 2 — returns stub until classifier is wired
    return {"intentions": [], "pending_review": [], "total": 0}


@router.post("/intentions/{intention_id}/approve")
async def approve_intention(
    intention_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    return {"status": "not_implemented"}


@router.post("/intentions/{intention_id}/reject")
async def reject_intention(
    intention_id: str,
    tenant_id: str = Depends(get_tenant_id),
    current_user: CurrentUser = Depends(require_admin),
):
    return {"status": "not_implemented"}
