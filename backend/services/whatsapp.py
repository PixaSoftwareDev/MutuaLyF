"""Cliente de WhatsApp Cloud API (Meta, directo — sin BSP) + acceso a cuentas.

Modelo multi-tenant:
  - Cada tenant da de alta su número en Meta y carga las credenciales en el
    panel (phone_number_id, WABA id, token permanente, app secret).
  - Tabla global `public.whatsapp_accounts`: una fila por tenant. El
    phone_number_id es ÚNICO → es la clave de ruteo del webhook entrante
    (Meta manda todos los eventos a la misma URL nuestra).
  - Token y app secret se guardan cifrados (core/crypto.py).

Envíos salientes: Graph API /{phone_number_id}/messages. Con reintentos cortos
inline (la Cloud API responde en <1s normalmente). La ventana de 24h de Meta
no afecta al bot (responde al instante); para operadores que llegan tarde la
API devuelve error y lo logueamos — plantillas fuera de ventana son fase 2.
"""

import asyncio
import hashlib
import hmac
import logging
from dataclasses import dataclass

import httpx
from sqlalchemy import text

from core.crypto import decrypt_secret
from core.database import get_pg_session

logger = logging.getLogger(__name__)

GRAPH_BASE = "https://graph.facebook.com/v21.0"
_SEND_RETRIES = 3
_SEND_TIMEOUT_S = 15.0


@dataclass
class WhatsAppAccount:
    tenant_id: str
    phone_number_id: str
    waba_id: str | None
    display_phone: str | None
    access_token: str          # ya descifrado
    app_secret: str | None     # ya descifrado (None = sin validación de firma, solo dev)
    verify_token: str
    enabled: bool
    status: str                # pending | active | error | disabled


def _row_to_account(row) -> WhatsAppAccount:
    return WhatsAppAccount(
        tenant_id=row["tenant_id"],
        phone_number_id=row["phone_number_id"],
        waba_id=row["waba_id"],
        display_phone=row["display_phone"],
        access_token=decrypt_secret(row["access_token_enc"]),
        app_secret=decrypt_secret(row["app_secret_enc"]) if row["app_secret_enc"] else None,
        verify_token=row["verify_token"],
        enabled=row["enabled"],
        status=row["status"],
    )


_SELECT_COLS = """
    tenant_id, phone_number_id, waba_id, display_phone,
    access_token_enc, app_secret_enc, verify_token, enabled, status
"""


async def get_account_by_tenant(tenant_id: str) -> WhatsAppAccount | None:
    async with get_pg_session() as session:
        row = (await session.execute(
            text(f"SELECT {_SELECT_COLS} FROM public.whatsapp_accounts WHERE tenant_id = :tid"),
            {"tid": tenant_id},
        )).mappings().fetchone()
    return _row_to_account(row) if row else None


async def get_account_by_phone_number_id(phone_number_id: str) -> WhatsAppAccount | None:
    """Ruteo del webhook: phone_number_id (viene en el payload de Meta) → tenant."""
    async with get_pg_session() as session:
        row = (await session.execute(
            text(f"SELECT {_SELECT_COLS} FROM public.whatsapp_accounts WHERE phone_number_id = :pid"),
            {"pid": phone_number_id},
        )).mappings().fetchone()
    return _row_to_account(row) if row else None


async def find_account_by_verify_token(verify_token: str) -> bool:
    """GET de verificación del webhook: Meta manda hub.verify_token; cada
    tenant configura el suyo (se lo mostramos en el panel)."""
    async with get_pg_session() as session:
        row = (await session.execute(
            text("SELECT 1 FROM public.whatsapp_accounts WHERE verify_token = :vt LIMIT 1"),
            {"vt": verify_token},
        )).fetchone()
    return row is not None


# ── Firma del webhook ─────────────────────────────────────────────────────────

def verify_signature(app_secret: str, payload: bytes, signature_header: str | None) -> bool:
    """Valida X-Hub-Signature-256 (HMAC-SHA256 del body crudo con el app secret)."""
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    expected = hmac.new(app_secret.encode(), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header.removeprefix("sha256="))


# ── Graph API ─────────────────────────────────────────────────────────────────

async def send_text(account: WhatsAppAccount, to_wa_id: str, body: str) -> str | None:
    """Envía un mensaje de texto. Devuelve el message id de Meta o None si falló.

    WhatsApp corta los mensajes en 4096 chars — truncamos defensivamente.
    Reintenta ante errores de red/5xx; los 4xx (token vencido, ventana de 24h
    cerrada) no se reintentan: se loguean para diagnóstico.
    """
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to_wa_id,
        "type": "text",
        "text": {"preview_url": False, "body": body[:4096]},
    }
    url = f"{GRAPH_BASE}/{account.phone_number_id}/messages"
    headers = {"Authorization": f"Bearer {account.access_token}"}

    last_error: str | None = None
    for attempt in range(1, _SEND_RETRIES + 1):
        try:
            async with httpx.AsyncClient(timeout=_SEND_TIMEOUT_S) as client:
                resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code < 300:
                data = resp.json()
                msg_id = (data.get("messages") or [{}])[0].get("id")
                return msg_id
            # 4xx → error definitivo (credenciales, ventana 24h, número inválido)
            last_error = f"HTTP {resp.status_code}: {resp.text[:500]}"
            if resp.status_code < 500:
                break
        except httpx.HTTPError as exc:
            last_error = repr(exc)
        await asyncio.sleep(0.5 * attempt)

    logger.error(
        "whatsapp_send_failed tenant=%s to=%s error=%s",
        account.tenant_id, to_wa_id, last_error,
    )
    return None


async def fetch_phone_info(phone_number_id: str, access_token: str) -> dict:
    """Consulta los datos del número en la Graph API. Sirve como 'probar
    conexión': si las credenciales son válidas devuelve display_phone_number
    y verified_name; si no, lanza ValueError con el detalle de Meta."""
    url = f"{GRAPH_BASE}/{phone_number_id}"
    params = {"fields": "display_phone_number,verified_name,quality_rating"}
    headers = {"Authorization": f"Bearer {access_token}"}
    try:
        async with httpx.AsyncClient(timeout=_SEND_TIMEOUT_S) as client:
            resp = await client.get(url, params=params, headers=headers)
    except httpx.HTTPError as exc:
        raise ValueError(f"No se pudo conectar con la API de Meta: {exc!r}") from exc
    if resp.status_code >= 300:
        try:
            detail = resp.json().get("error", {}).get("message", resp.text[:300])
        except Exception:
            detail = resp.text[:300]
        raise ValueError(detail)
    return resp.json()


# ── Relay saliente desde el panel (operador / mensajes de sistema) ────────────

async def relay_to_whatsapp(tenant_id: str, conversation_id: str, content: str) -> None:
    """Si la conversación es de canal WhatsApp, reenvía `content` al afiliado.

    No-op silencioso para conversaciones del widget. Pensado para usarse con
    fire_and_log() después de insertar el mensaje en la DB: la entrega al
    panel/widget nunca depende de que Meta responda.
    """
    try:
        async with get_pg_session(tenant_id) as session:
            row = (await session.execute(
                text("SELECT channel, external_id FROM conversaciones WHERE id = :cid"),
                {"cid": conversation_id},
            )).mappings().fetchone()
        if not row or row["channel"] != "whatsapp" or not row["external_id"]:
            return
        account = await get_account_by_tenant(tenant_id)
        if not account or not account.enabled:
            logger.warning("whatsapp_relay_skipped tenant=%s conv=%s (cuenta no activa)", tenant_id, conversation_id)
            return
        await send_text(account, row["external_id"], content)
    except Exception:
        logger.exception("whatsapp_relay_error tenant=%s conv=%s", tenant_id, conversation_id)
