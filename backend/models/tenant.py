"""Pydantic schemas for tenant management."""

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, EmailStr, Field


class TenantPlan(str, Enum):
    STARTER = "starter"
    PROFESSIONAL = "professional"
    ENTERPRISE = "enterprise"


class TenantStatus(str, Enum):
    ACTIVE = "active"
    SUSPENDED = "suspended"
    ONBOARDING = "onboarding"


class TenantCreate(BaseModel):
    id: str = Field(..., pattern=r"^[a-z0-9][a-z0-9\-]{1,48}[a-z0-9]$", description="Slug used as schema name and subdomain")
    name: str = Field(..., min_length=2, max_length=200)
    plan: TenantPlan = TenantPlan.STARTER
    admin_email: EmailStr
    admin_name: str = Field(..., min_length=2, max_length=200)
    admin_password: str = Field(..., min_length=8)
    personality_id: str = Field(..., description="UUID of the personality template to activate for this tenant")


class TenantResponse(BaseModel):
    id: str
    name: str
    plan: TenantPlan
    status: TenantStatus
    created_at: datetime

    model_config = {"from_attributes": True}


class WidgetTokenResponse(BaseModel):
    widget_token: str
    expires_in_days: int
    tenant_id: str
