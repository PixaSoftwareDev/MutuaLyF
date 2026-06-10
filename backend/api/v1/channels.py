"""Canales de atención: webhook de WhatsApp + administración por tenant.

Webhook (público, sin auth de plataforma — la seguridad es de Meta):
  GET  /channels/whatsapp/webhook   → verificación inicial (hub.challenge)
  POST /channels/whatsapp/webhook   → mensajes entrantes. Firma HMAC con el
       app secret del tenant (resuelto por phone_number_id del payload).

Admin (tenant):
  GET    /admin/channels                    → estado de widget + whatsapp
  PUT    /admin/channels/widget             → activar/desactivar widget
  PUT    /admin/channels/whatsapp           → cargar/actualizar credenciales
  POST   /admin/channels/whatsapp/test      → probar conexión contra Graph API
  PUT    /admin/channels/whatsapp/toggle    → activar/pausar el canal
  DELETE /admin/channels/whatsapp           → eliminar la configuración
"""

import logging
import os
import secrets

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import text

from core.audit import record as audit, fire_and_log
from core.config import settings
from core.crypto import encrypt_secret
from core.database import get_pg_session
from core.security import CurrentUser, require_admin_or_super
from services import whatsapp as wa

logger = logging.getLogger(__name__)
router = APIRouter()


def _webhook_url() -> str:
    """URL pública del webhook para mostrar en el panel (se pega en Meta)."""
    base = os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/")
    if not base:
        domain = settings.base_domain
        base = f"https://{domain}" if domain != "localhost" else "http://localhost:8000"
    return f"{base}/api/v1/channels/whatsapp/webhook"


# ── Webhook de Meta ───────────────────────────────────────────────────────────

@router.get("/channels/whatsapp/webhook")
async def whatsapp_webhook_verify(
    hub_mode: str = Query(default="", alias="hub.mode"),
    hub_challenge: str = Query(default="", alias="hub.challenge"),
    hub_verify_token: str = Query(default="", alias="hub.verify_token"),
):
    """Verificación de Meta al configurar el webhook: si el verify_token
    coincide con el de algún tenant, devolvemos el challenge en texto plano."""
    if hub_mode == "subscribe" and hub_verify_token and await wa.find_account_by_verify_token(hub_verify_token):
        return PlainTextResponse(hub_challenge)
    raise HTTPException(status_code=403, detail="Verify token inválido")


@router.post("/channels/whatsapp/webhook")
async def whatsapp_webhook(request: Request):
    """Mensajes/estados entrantes. Respondemos 200 rápido SIEMPRE que el
    payload sea atribuible (Meta reintenta ante no-200) y procesamos los
    mensajes en background — el RAG tarda 1-3s y no podemos colgar a Meta."""
    raw = await request.body()
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="JSON inválido")

    signature = request.headers.get("X-Hub-Signature-256")

    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            value = change.get("value") or {}
            messages = value.get("messages") or []
            if not messages:
                continue  # estados de entrega/lectura: fase 2

            phone_number_id = (value.get("metadata") or {}).get("phone_number_id")
            if not phone_number_id:
                continue
            account = await wa.get_account_by_phone_number_id(str(phone_number_id))
            if not account:
                logger.warning("whatsapp_webhook_unknown_number phone_number_id=%s", phone_number_id)
                continue
            if not account.enabled:
                logger.info("whatsapp_webhook_disabled tenant=%s", account.tenant_id)
                continue

            # Firma HMAC con el app secret del tenant. Si el tenant no cargó
            # app secret (modo prueba), se acepta sin firma pero queda logueado.
            if account.app_secret:
                if not wa.verify_signature(account.app_secret, raw, signature):
                    logger.warning("whatsapp_webhook_bad_signature tenant=%s", account.tenant_id)
                    continue
            else:
                logger.warning("whatsapp_webhook_unsigned tenant=%s (sin app secret configurado)", account.tenant_id)

            from services.whatsapp_inbound import process_incoming_message
            for message in messages:
                fire_and_log(
                    process_incoming_message(account, value, message),
                    context="whatsapp.inbound",
                )

    return {"status": "received"}


# ── Admin: estado de canales ──────────────────────────────────────────────────

def _own_tenant(current_user: CurrentUser) -> str:
    if not current_user.tenant_id or current_user.tenant_id == "__platform__":
        raise HTTPException(status_code=400, detail="No tenant context")
    return current_user.tenant_id


@router.get("/admin/channels")
async def get_channels(current_user: CurrentUser = Depends(require_admin_or_super)):
    tenant_id = _own_tenant(current_user)
    async with get_pg_session() as session:
        tenant = (await session.execute(text(
            "SELECT widget_enabled, widget_token_hash FROM public.tenants WHERE id = :tid"
        ), {"tid": tenant_id})).mappings().fetchone()
        wa_row = (await session.execute(text("""
            SELECT phone_number_id, waba_id, display_phone, verify_token,
                   enabled, status, last_verified_at,
                   (app_secret_enc IS NOT NULL) AS has_app_secret
            FROM public.whatsapp_accounts WHERE tenant_id = :tid
        """), {"tid": tenant_id})).mappings().fetchone()

    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    return {
        "widget": {
            "enabled": bool(tenant["widget_enabled"]),
            "has_token": tenant["widget_token_hash"] is not None,
        },
        "whatsapp": None if not wa_row else {
            "configured": True,
            "enabled": wa_row["enabled"],
            "status": wa_row["status"],
            "phone_number_id": wa_row["phone_number_id"],
            "waba_id": wa_row["waba_id"],
            "display_phone": wa_row["display_phone"],
            "verify_token": wa_row["verify_token"],
            "has_app_secret": bool(wa_row["has_app_secret"]),
            "last_verified_at": wa_row["last_verified_at"].isoformat() if wa_row["last_verified_at"] else None,
        },
        "webhook_url": _webhook_url(),
    }


class WidgetToggleRequest(BaseModel):
    enabled: bool


@router.put("/admin/channels/widget")
async def toggle_widget(
    body: WidgetToggleRequest,
    request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    tenant_id = _own_tenant(current_user)
    async with get_pg_session() as session:
        await session.execute(text(
            "UPDATE public.tenants SET widget_enabled = :en WHERE id = :tid"
        ), {"en": body.enabled, "tid": tenant_id})
    fire_and_log(audit(
        tenant_id=tenant_id, actor_id=current_user.user_id, actor_email=current_user.email,
        actor_role=current_user.role.value, action="config.channel_update",
        resource="widget", detail={"enabled": body.enabled}, request=request,
    ))
    return {"enabled": body.enabled}


# ── Admin: WhatsApp ───────────────────────────────────────────────────────────

class WhatsAppCredentials(BaseModel):
    phone_number_id: str = Field(..., min_length=5, max_length=50)
    waba_id: str | None = Field(default=None, max_length=50)
    access_token: str = Field(..., min_length=20, max_length=1000)
    app_secret: str | None = Field(default=None, min_length=10, max_length=200)


@router.put("/admin/channels/whatsapp")
async def upsert_whatsapp(
    body: WhatsAppCredentials,
    request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Carga o actualiza las credenciales del tenant. Queda en estado
    'pending' (deshabilitado) hasta que 'Probar conexión' pase."""
    tenant_id = _own_tenant(current_user)
    pnid = body.phone_number_id.strip()

    async with get_pg_session() as session:
        # El phone_number_id rutea el webhook → no puede pertenecer a otro tenant.
        clash = (await session.execute(text(
            "SELECT tenant_id FROM public.whatsapp_accounts WHERE phone_number_id = :pid AND tenant_id != :tid"
        ), {"pid": pnid, "tid": tenant_id})).fetchone()
        if clash:
            raise HTTPException(status_code=409, detail="Ese phone_number_id ya está registrado por otra organización.")

        verify_token = secrets.token_urlsafe(24)
        await session.execute(text("""
            INSERT INTO public.whatsapp_accounts
              (tenant_id, phone_number_id, waba_id, access_token_enc, app_secret_enc,
               verify_token, enabled, status, updated_at)
            VALUES (:tid, :pid, :waba, :tok, :sec, :vt, FALSE, 'pending', NOW())
            ON CONFLICT (tenant_id) DO UPDATE SET
              phone_number_id = EXCLUDED.phone_number_id,
              waba_id         = EXCLUDED.waba_id,
              access_token_enc = EXCLUDED.access_token_enc,
              app_secret_enc  = COALESCE(EXCLUDED.app_secret_enc, public.whatsapp_accounts.app_secret_enc),
              enabled         = FALSE,
              status          = 'pending',
              updated_at      = NOW()
        """), {
            "tid": tenant_id,
            "pid": pnid,
            "waba": body.waba_id.strip() if body.waba_id else None,
            "tok": encrypt_secret(body.access_token.strip()),
            "sec": encrypt_secret(body.app_secret.strip()) if body.app_secret else None,
            "vt": verify_token,
        })
        # El verify_token NO se regenera en updates (rompería el webhook ya
        # configurado en Meta) — el ON CONFLICT no lo toca.
        row = (await session.execute(text(
            "SELECT verify_token FROM public.whatsapp_accounts WHERE tenant_id = :tid"
        ), {"tid": tenant_id})).fetchone()

    fire_and_log(audit(
        tenant_id=tenant_id, actor_id=current_user.user_id, actor_email=current_user.email,
        actor_role=current_user.role.value, action="config.channel_update",
        resource="whatsapp", detail={"phone_number_id": pnid}, request=request,
    ))
    return {"status": "pending", "verify_token": row[0], "webhook_url": _webhook_url()}


@router.post("/admin/channels/whatsapp/test")
async def test_whatsapp(
    request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Valida las credenciales contra la Graph API. Si responde, el canal
    pasa a 'active' (y puede habilitarse); si no, a 'error' con el detalle."""
    tenant_id = _own_tenant(current_user)
    account = await wa.get_account_by_tenant(tenant_id)
    if not account:
        raise HTTPException(status_code=404, detail="WhatsApp no está configurado.")

    try:
        info = await wa.fetch_phone_info(account.phone_number_id, account.access_token)
    except ValueError as exc:
        async with get_pg_session() as session:
            await session.execute(text(
                "UPDATE public.whatsapp_accounts SET status = 'error', updated_at = NOW() WHERE tenant_id = :tid"
            ), {"tid": tenant_id})
        raise HTTPException(status_code=400, detail=f"Meta rechazó las credenciales: {exc}")

    display = info.get("display_phone_number")
    async with get_pg_session() as session:
        await session.execute(text("""
            UPDATE public.whatsapp_accounts
            SET status = 'active', display_phone = :dp, last_verified_at = NOW(), updated_at = NOW()
            WHERE tenant_id = :tid
        """), {"dp": display, "tid": tenant_id})

    fire_and_log(audit(
        tenant_id=tenant_id, actor_id=current_user.user_id, actor_email=current_user.email,
        actor_role=current_user.role.value, action="config.channel_update",
        resource="whatsapp", detail={"test": "ok", "display_phone": display}, request=request,
    ))
    return {
        "status": "active",
        "display_phone": display,
        "verified_name": info.get("verified_name"),
        "quality_rating": info.get("quality_rating"),
    }


class WhatsAppToggleRequest(BaseModel):
    enabled: bool


@router.put("/admin/channels/whatsapp/toggle")
async def toggle_whatsapp(
    body: WhatsAppToggleRequest,
    request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    tenant_id = _own_tenant(current_user)
    async with get_pg_session() as session:
        row = (await session.execute(text(
            "SELECT status FROM public.whatsapp_accounts WHERE tenant_id = :tid"
        ), {"tid": tenant_id})).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="WhatsApp no está configurado.")
        if body.enabled and row[0] != "active":
            raise HTTPException(status_code=400, detail="Probá la conexión antes de activar el canal.")
        await session.execute(text(
            "UPDATE public.whatsapp_accounts SET enabled = :en, updated_at = NOW() WHERE tenant_id = :tid"
        ), {"en": body.enabled, "tid": tenant_id})

    fire_and_log(audit(
        tenant_id=tenant_id, actor_id=current_user.user_id, actor_email=current_user.email,
        actor_role=current_user.role.value, action="config.channel_update",
        resource="whatsapp", detail={"enabled": body.enabled}, request=request,
    ))
    return {"enabled": body.enabled}


@router.delete("/admin/channels/whatsapp")
async def delete_whatsapp(
    request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    tenant_id = _own_tenant(current_user)
    async with get_pg_session() as session:
        await session.execute(text(
            "DELETE FROM public.whatsapp_accounts WHERE tenant_id = :tid"
        ), {"tid": tenant_id})
    fire_and_log(audit(
        tenant_id=tenant_id, actor_id=current_user.user_id, actor_email=current_user.email,
        actor_role=current_user.role.value, action="config.channel_update",
        resource="whatsapp", detail={"deleted": True}, request=request,
    ))
    return {"deleted": True}
