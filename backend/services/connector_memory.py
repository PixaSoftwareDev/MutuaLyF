"""Memoria de datos por conversación para conectores.

Guarda en Redis (misma DB que las sesiones) un resumen COMPACTO de los últimos
resultados de tools de la conversación: qué operación se llamó y qué ids/labels
devolvió. Dos usos:

  1. Contexto para el loop agéntico: "el detalle del segundo" o "ese proyecto"
     resuelven contra lo ya consultado, sin repetir la llamada a la lista.
  2. Procedencia de ids (anti-BOLA de recursos): un parámetro x-resource-id solo
     se acepta si su valor apareció en un resultado previo de ESTA conversación.

El blob va cifrado con Fernet (contiene nombres/datos del proveedor), TTL corto.
Fail-open en lectura (sin memoria → el loop pide la lista de nuevo) y fail-silent
en escritura (la consulta nunca se rompe por no poder recordar).
"""

from __future__ import annotations

import json
import logging
import time

from core.config import settings
from core.crypto import decrypt_secret, encrypt_secret
from core.database import get_redis_session

logger = logging.getLogger(__name__)

# Campos candidatos a "label" humano de un ítem, en orden de preferencia.
_LABEL_FIELDS = ("name", "nombre", "title", "titulo", "display_name", "asunto",
                 "subject", "descripcion", "description", "email", "concepto")
_ID_FIELDS = ("id", "uuid", "_id")

_MAX_ITEMS_PER_TOOL = 30
_MAX_ENTRIES = 6
_TTL_SECONDS = 3600


def _key(tenant_id: str, conversation_id: str) -> str:
    return f"connmem:{tenant_id}:{conversation_id}"


def _item_summary(obj: dict) -> dict | None:
    """{id, label} compacto de un ítem de resultado; None si no tiene id."""
    item_id = next((obj[f] for f in _ID_FIELDS if obj.get(f) not in (None, "")), None)
    if item_id is None:
        return None
    label = next((str(obj[f])[:60] for f in _LABEL_FIELDS
                  if isinstance(obj.get(f), str) and obj[f].strip()), None)
    return {"id": str(item_id), "label": label}


def summarize_result(data) -> list[dict]:
    """Resumen [{id,label}] de un resultado de tool (lista de dicts o dict solo)."""
    if isinstance(data, dict):
        # Muchos APIs envuelven: {"items": [...]} / {"data": [...]} — buscar la lista.
        inner = next((v for v in data.values() if isinstance(v, list)), None)
        if inner is not None:
            data = inner
        else:
            one = _item_summary(data)
            return [one] if one else []
    if not isinstance(data, list):
        return []
    out = []
    for obj in data[:_MAX_ITEMS_PER_TOOL]:
        if isinstance(obj, dict):
            s = _item_summary(obj)
            if s:
                out.append(s)
    return out


async def remember(tenant_id: str, conversation_id: str, tool_slug: str, data) -> None:
    """Registra el resultado de una tool en la memoria de la conversación."""
    items = summarize_result(data)
    if not items:
        return
    try:
        entries = await recall(tenant_id, conversation_id)
        entries = [e for e in entries if e.get("tool") != tool_slug]
        entries.append({"tool": tool_slug, "at": int(time.time()), "items": items})
        entries = entries[-_MAX_ENTRIES:]
        blob = encrypt_secret(json.dumps(entries, ensure_ascii=False))
        await get_redis_session().setex(_key(tenant_id, conversation_id), _TTL_SECONDS, blob)
    except Exception as exc:  # noqa: BLE001 — recordar es best-effort
        logger.warning("connmem_remember_failed tenant=%s error=%s", tenant_id, exc)


async def recall(tenant_id: str, conversation_id: str) -> list[dict]:
    """Entradas de memoria de la conversación (lista vacía si no hay o falla)."""
    try:
        blob = await get_redis_session().get(_key(tenant_id, conversation_id))
        if not blob:
            return []
        raw = decrypt_secret(blob.decode() if isinstance(blob, bytes) else blob)
        entries = json.loads(raw)
        return entries if isinstance(entries, list) else []
    except Exception as exc:  # noqa: BLE001
        logger.warning("connmem_recall_failed tenant=%s error=%s", tenant_id, exc)
        return []


async def forget(tenant_id: str, conversation_id: str) -> None:
    """Borra la memoria de resultados de la conversación. La usa el logout: sin
    esto, cerrar sesión mataba la credencial pero dejaba los datos ya traídos
    (nombres, montos, ids) disponibles para que el bot los repita — el mensaje
    promete que los datos personales quedan protegidos y no era cierto."""
    try:
        await get_redis_session().delete(_key(tenant_id, conversation_id))
    except Exception as exc:  # noqa: BLE001 — best-effort, nunca rompe el turno
        logger.warning("connmem_forget_failed tenant=%s error=%s", tenant_id, exc)


# ── Corte de contexto por logout ──────────────────────────────────────────────
# Cerrar sesión también tiene que cortar lo que el modelo puede LEER del pasado:
# los datos personales ya respondidos siguen en el historial de la charla y sin
# esto el bot los repite sin credencial. Guardamos el momento del corte; el
# historial anterior no se le pasa más al modelo (la charla no se borra: sigue
# en la base para el operador y la auditoría).
def _cut_key(tenant_id: str, conversation_id: str) -> str:
    return f"connmem:cut:{tenant_id}:{conversation_id}"


async def set_history_cut(tenant_id: str, conversation_id: str, when_iso: str) -> None:
    try:
        await get_redis_session().setex(_cut_key(tenant_id, conversation_id), _TTL_SECONDS, when_iso)
    except Exception as exc:  # noqa: BLE001
        logger.warning("connmem_cut_failed tenant=%s error=%s", tenant_id, exc)


async def get_history_cut(tenant_id: str, conversation_id: str) -> str | None:
    try:
        v = await get_redis_session().get(_cut_key(tenant_id, conversation_id))
        return v.decode() if isinstance(v, bytes) else v
    except Exception as exc:  # noqa: BLE001
        logger.warning("connmem_cut_read_failed tenant=%s error=%s", tenant_id, exc)
        return None


def seen_ids(entries: list[dict]) -> set[str]:
    """Todos los ids de recurso vistos en la conversación (para procedencia)."""
    out: set[str] = set()
    for e in entries:
        for item in e.get("items") or []:
            if item.get("id") is not None:
                out.add(str(item["id"]))
    return out


def render_referents(entries: list[dict]) -> str:
    """Nota de REFERENTES para la síntesis de la respuesta (no para el loop).

    A diferencia de render_note (ids "usables"), acá importa la RECENCIA: el
    último elemento consultado es el referente más probable de un pronombre
    («le», «ese», «el segundo»). Orden inverso-cronológico y etiquetas al
    frente. '' si no hay memoria."""
    if not entries:
        return ""
    lines = []
    for e in reversed(entries[-_MAX_ENTRIES:]):
        items = e.get("items") or []
        labels = [i["label"] for i in items if i.get("label")]
        if not labels:
            continue
        # La marca va en la PRIMERA línea emitida (no en la primera iterada:
        # una entrada reciente sin labels la salteaba y la marca se perdía).
        marca = " ← lo MÁS RECIENTE (referente probable)" if not lines else ""
        lines.append(f"- {', '.join(labels[:6])}{marca}")
    if not lines:
        return ""
    return "Entidades de la conversación, de más a menos reciente:\n" + "\n".join(lines)


def render_note(entries: list[dict]) -> str:
    """Nota compacta para inyectar al LLM del loop. '' si no hay memoria."""
    if not entries:
        return ""
    lines = []
    for e in entries[-_MAX_ENTRIES:]:
        items = e.get("items") or []
        shown = ", ".join(
            f"id={i['id']}" + (f" «{i['label']}»" if i.get("label") else "")
            for i in items[:10]
        )
        extra = f" (+{len(items) - 10} más)" if len(items) > 10 else ""
        lines.append(f"- {e['tool']}: {shown}{extra}")
    return "Datos ya consultados en esta conversación (podés usar estos ids):\n" + "\n".join(lines)
