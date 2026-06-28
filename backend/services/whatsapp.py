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

# Cliente httpx compartido: reutiliza conexiones keep-alive a graph.facebook.com
# en vez de abrir un socket TLS nuevo por mensaje. Lazy + auto-recrea si se cerró.
_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=_SEND_TIMEOUT_S)
    return _client


async def aclose_client() -> None:
    """Cerrar el cliente compartido en el shutdown de la app (best-effort)."""
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
        _client = None


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


async def download_media(account: "WhatsAppAccount", media_id: str) -> bytes | None:
    """Descarga un media entrante de WhatsApp. Meta no manda el binario en el
    webhook: manda un media_id → primero se pide la URL temporal, luego se baja
    el binario (ambos con el Bearer del tenant). None si falla (best-effort)."""
    client = _get_client()
    headers = {"Authorization": f"Bearer {account.access_token}"}
    try:
        meta = await client.get(f"{GRAPH_BASE}/{media_id}", headers=headers)
        meta.raise_for_status()
        url = (meta.json() or {}).get("url")
        if not url:
            return None
        binary = await client.get(url, headers=headers, timeout=30.0)
        binary.raise_for_status()
        return binary.content
    except Exception as exc:
        logger.warning("whatsapp_media_download_failed media_id=%s error=%s", media_id, exc)
        return None


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

def _normalize_recipient(number: str) -> str:
    """Normaliza el número destinatario antes de enviar.

    Argentina: WhatsApp entrega el 'from' del mensaje entrante con un 9 tras el
    54 (prefijo de móvil), pero la Cloud API espera el número SIN ese 9 para
    enviar — si se manda con el 9, Meta lo rechaza (#131030 'not in allowed list'
    o número inválido), porque el wa_id real registrado no lleva el 9. Otros
    países no se tocan.
    """
    n = number.lstrip("+").strip()
    if n.startswith("549") and len(n) == 13:
        return "54" + n[3:]
    return n


# El typing indicator + read receipt requieren una versión reciente de la Graph
# API. Lo aislamos en su propia base para NO tocar GRAPH_BASE (v21), que es el
# camino crítico de send_text ya probado en producción.
_GRAPH_BASE_SIGNALS = "https://graph.facebook.com/v23.0"


async def send_typing_indicator(account: WhatsAppAccount, message_id: str) -> None:
    """Marca el mensaje del afiliado como leído (✓✓) y muestra 'escribiendo…'.

    Meta acopla ambas señales en un solo request (status=read + typing_indicator);
    no se puede una sin la otra. El indicador dura hasta 25s o hasta que se envía
    el próximo mensaje — la respuesta del bot lo reemplaza.

    Best-effort: se invoca fire-and-forget desde el handler, así que NUNCA bloquea
    ni suma latencia a la respuesta. Si falla (versión vieja, red), se ignora.
    """
    if not message_id:
        return
    payload = {
        "messaging_product": "whatsapp",
        "status": "read",
        "message_id": message_id,
        "typing_indicator": {"type": "text"},
    }
    url = f"{_GRAPH_BASE_SIGNALS}/{account.phone_number_id}/messages"
    headers = {"Authorization": f"Bearer {account.access_token}"}
    try:
        resp = await _get_client().post(url, json=payload, headers=headers)
        if resp.status_code >= 300:
            logger.info(
                "whatsapp_typing_skipped tenant=%s status=%s body=%s",
                account.tenant_id, resp.status_code, resp.text[:160],
            )
    except Exception as exc:
        logger.info("whatsapp_typing_error tenant=%s error=%s", account.tenant_id, exc)


async def _post_message(account: WhatsAppAccount, payload: dict) -> str | None:
    """POST a /{phone_number_id}/messages con reintentos. Devuelve el message id
    de Meta o None si falló. Reintenta ante red/5xx; los 4xx (token vencido,
    ventana de 24h, número inválido) no se reintentan, se loguean."""
    url = f"{GRAPH_BASE}/{account.phone_number_id}/messages"
    headers = {"Authorization": f"Bearer {account.access_token}"}

    last_error: str | None = None
    for attempt in range(1, _SEND_RETRIES + 1):
        try:
            resp = await _get_client().post(url, json=payload, headers=headers)
            if resp.status_code < 300:
                data = resp.json()
                return (data.get("messages") or [{}])[0].get("id")
            last_error = f"HTTP {resp.status_code}: {resp.text[:500]}"
            if resp.status_code < 500:
                break
        except httpx.HTTPError as exc:
            last_error = repr(exc)
        await asyncio.sleep(0.5 * attempt)

    logger.error("whatsapp_send_failed tenant=%s error=%s", account.tenant_id, last_error)
    return None


async def send_text(account: WhatsAppAccount, to_wa_id: str, body: str) -> str | None:
    """Envía un mensaje de texto. WhatsApp corta en 4096 chars — truncamos."""
    return await _post_message(account, {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": _normalize_recipient(to_wa_id),
        "type": "text",
        "text": {"preview_url": False, "body": body[:4096]},
    })


async def send_interactive_buttons(
    account: WhatsAppAccount, to_wa_id: str, body: str,
    buttons: list[dict],
) -> str | None:
    """Mensaje con botones de respuesta rápida (máx 3). `buttons`: [{id, title}].
    Cada title se corta a 20 chars (límite de Meta). El id vuelve en el webhook
    como interactive.button_reply.id."""
    reply_buttons = [
        {"type": "reply", "reply": {"id": str(b["id"])[:256], "title": str(b["title"])[:20]}}
        for b in buttons[:3]
    ]
    return await _post_message(account, {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": _normalize_recipient(to_wa_id),
        "type": "interactive",
        "interactive": {
            "type": "button",
            "body": {"text": body[:1024]},
            "action": {"buttons": reply_buttons},
        },
    })


async def send_interactive_list(
    account: WhatsAppAccount, to_wa_id: str, body: str,
    button_text: str, rows: list[dict],
) -> str | None:
    """Mensaje con lista desplegable (hasta 10 filas). `rows`: [{id, title,
    description?}]. title ≤24, description ≤72 (límites de Meta). El id elegido
    vuelve en el webhook como interactive.list_reply.id."""
    list_rows = []
    for r in rows[:10]:
        row = {"id": str(r["id"])[:200], "title": str(r["title"])[:24]}
        desc = (r.get("description") or "").strip()
        if desc:
            row["description"] = desc[:72]
        list_rows.append(row)
    return await _post_message(account, {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": _normalize_recipient(to_wa_id),
        "type": "interactive",
        "interactive": {
            "type": "list",
            "body": {"text": body[:1024]},
            "action": {
                "button": button_text[:20],
                "sections": [{"title": "Áreas", "rows": list_rows}],
            },
        },
    })


async def fetch_phone_info(phone_number_id: str, access_token: str) -> dict:
    """Consulta los datos del número en la Graph API. Sirve como 'probar
    conexión': si las credenciales son válidas devuelve display_phone_number
    y verified_name; si no, lanza ValueError con el detalle de Meta."""
    url = f"{GRAPH_BASE}/{phone_number_id}"
    params = {"fields": "display_phone_number,verified_name,quality_rating"}
    headers = {"Authorization": f"Bearer {access_token}"}
    try:
        resp = await _get_client().get(url, params=params, headers=headers)
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

async def relay_to_whatsapp(tenant_id: str, conversation_id: str, content: str, message_id: str | None = None) -> None:
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
        wamid = await send_text(account, row["external_id"], content)
        if wamid is None:
            # El envío a Meta falló (típico: ventana de 24 h cerrada o token vencido).
            # Insertamos un aviso visible para que el operador NO crea que el cliente
            # lo recibió. send_text ya logueó el detalle.
            import uuid as _uuid
            notice = ("⚠️ Este mensaje no pudo entregarse por WhatsApp. Suele pasar cuando pasaron "
                      "más de 24 h sin que el cliente escriba (límite de WhatsApp) o venció el token.")
            async with get_pg_session(tenant_id) as session:
                await session.execute(text(
                    "INSERT INTO mensajes (id, conversation_id, sender_type, content) "
                    "VALUES (:id, :cid, 'system', :c)"
                ), {"id": str(_uuid.uuid4()), "cid": conversation_id, "c": notice})
            try:
                from api.v1.attachments import _publish_event
                await _publish_event(tenant_id, "new_message", {"conversation_id": conversation_id})
            except Exception:
                pass
        elif message_id:
            # Guardar el wamid del mensaje del operador para matchear los webhooks
            # de estado (ticks: sent/delivered/read).
            async with get_pg_session(tenant_id) as session:
                await session.execute(text(
                    "UPDATE mensajes SET external_message_id = :w, delivery_status = 'sent' WHERE id = :id"
                ), {"w": wamid, "id": message_id})
    except Exception:
        logger.exception("whatsapp_relay_error tenant=%s conv=%s", tenant_id, conversation_id)


# ── Media saliente (operador → cliente) ───────────────────────────────────────

async def upload_media(account: "WhatsAppAccount", content: bytes, filename: str, mime: str) -> str | None:
    """Sube un archivo a Meta (POST /{phone_number_id}/media) y devuelve el media_id,
    o None si falla. El media_id es de un solo uso y vive ~30 días en Meta."""
    url = f"{GRAPH_BASE}/{account.phone_number_id}/media"
    headers = {"Authorization": f"Bearer {account.access_token}"}
    try:
        resp = await _get_client().post(
            url, headers=headers,
            data={"messaging_product": "whatsapp", "type": mime},
            files={"file": (filename or "archivo", content, mime)},
            timeout=30.0,  # subir hasta 10 MB puede tardar más que un mensaje de texto
        )
    except httpx.HTTPError as exc:
        logger.error("whatsapp_upload_media_failed tenant=%s error=%r", account.tenant_id, exc)
        return None
    if resp.status_code >= 300:
        logger.error("whatsapp_upload_media_failed tenant=%s http=%s body=%s",
                     account.tenant_id, resp.status_code, resp.text[:300])
        return None
    return (resp.json() or {}).get("id")


async def send_media(account: "WhatsAppAccount", to_wa_id: str, media_id: str,
                     mime: str, filename: str | None = None) -> str | None:
    """Envía un media ya subido (media_id). Imagen → type 'image'; PDF → 'document'
    (con filename para que el cliente vea el nombre). Devuelve el wamid o None."""
    to = _normalize_recipient(to_wa_id)
    if mime.startswith("image/"):
        payload = {
            "messaging_product": "whatsapp", "recipient_type": "individual",
            "to": to, "type": "image", "image": {"id": media_id},
        }
    else:  # application/pdf y demás → documento
        payload = {
            "messaging_product": "whatsapp", "recipient_type": "individual",
            "to": to, "type": "document",
            "document": {"id": media_id, "filename": filename or "archivo"},
        }
    return await _post_message(account, payload)


async def relay_attachment_to_whatsapp(
    tenant_id: str, conversation_id: str, content: bytes, filename: str, mime: str,
    message_id: str | None = None,
) -> None:
    """Reenvía un adjunto del operador al cliente por WhatsApp (sube a Meta + envía).
    No-op silencioso si la conversación no es de WhatsApp. Espeja a relay_to_whatsapp:
    si Meta falla, deja un aviso visible para que el operador no crea que llegó."""
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
            logger.warning("whatsapp_relay_attachment_skipped tenant=%s conv=%s (cuenta no activa)",
                           tenant_id, conversation_id)
            return

        media_id = await upload_media(account, content, filename, mime)
        wamid = await send_media(account, row["external_id"], media_id, mime, filename) if media_id else None

        if wamid is None:
            import uuid as _uuid
            notice = ("⚠️ Este archivo no pudo entregarse por WhatsApp. Suele pasar cuando pasaron "
                      "más de 24 h sin que el cliente escriba (límite de WhatsApp) o venció el token.")
            async with get_pg_session(tenant_id) as session:
                await session.execute(text(
                    "INSERT INTO mensajes (id, conversation_id, sender_type, content) "
                    "VALUES (:id, :cid, 'system', :c)"
                ), {"id": str(_uuid.uuid4()), "cid": conversation_id, "c": notice})
            try:
                from api.v1.attachments import _publish_event
                await _publish_event(tenant_id, "new_message", {"conversation_id": conversation_id})
            except Exception:
                pass
        elif message_id:
            async with get_pg_session(tenant_id) as session:
                await session.execute(text(
                    "UPDATE mensajes SET external_message_id = :w, delivery_status = 'sent' WHERE id = :id"
                ), {"w": wamid, "id": message_id})
    except Exception:
        logger.exception("whatsapp_relay_attachment_error tenant=%s conv=%s", tenant_id, conversation_id)


_STATUS_RANK = {"sent": 1, "delivered": 2, "read": 3, "failed": 1}


async def update_message_statuses(account: WhatsAppAccount, statuses: list) -> None:
    """Procesa los webhooks de estado de WhatsApp (sent/delivered/read/failed) y
    actualiza delivery_status del mensaje saliente. Solo AVANZA el estado (no pisa
    'read' con un 'delivered' que llegue tarde/desordenado). Best-effort."""
    for st in statuses or []:
        wamid = st.get("id")
        status = st.get("status")
        if not wamid or status not in _STATUS_RANK:
            continue
        try:
            async with get_pg_session(account.tenant_id) as session:
                await session.execute(text("""
                    UPDATE mensajes SET delivery_status = :s
                    WHERE external_message_id = :w
                      AND (delivery_status IS NULL OR :rank > CASE delivery_status
                            WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 ELSE 1 END)
                """), {"s": status, "w": wamid, "rank": _STATUS_RANK[status]})
        except Exception:
            logger.exception("whatsapp_status_update_failed wamid=%s", wamid)
