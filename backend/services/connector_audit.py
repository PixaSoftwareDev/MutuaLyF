"""Auditoría y scrubbing de PII para llamadas a tools.

Dos responsabilidades:
1. Enmascarar PII (DNI, CUIT, códigos) antes de que toque logs o el historial de
   conversación — nunca en claro.
2. Registrar cada invocación de tool en `tool_call_audit` (incluidas las denegadas)
   con el actor HASHEADO, para detectar sondeo BOLA/IDOR sin guardar el DNI real.
"""

from __future__ import annotations

import hashlib
import logging
import re

from sqlalchemy import text

from core.database import get_pg_session

logger = logging.getLogger(__name__)

# Corridas de 7+ dígitos (DNI/CUIT/teléfonos) y códigos de 6 dígitos aislados.
_LONG_DIGITS = re.compile(r"\b\d{6,}\b")


def mask_pii(s: str) -> str:
    """Enmascara corridas largas de dígitos dejando solo los últimos 4.

    "mi dni es 30111222" -> "mi dni es ****1222". Para logs e historial.
    """
    if not s:
        return s
    def _mask(m: re.Match) -> str:
        d = m.group(0)
        return "*" * max(0, len(d) - 4) + d[-4:]
    return _LONG_DIGITS.sub(_mask, s)


def hash_actor(identity: str) -> str:
    """Hash estable del actor para auditar sin guardar el DNI/CUIT real."""
    return hashlib.sha256((identity or "").encode()).hexdigest()[:32]


async def record_tool_call(binding, actor_ref: str, result) -> None:
    """Inserta un registro en tool_call_audit. Nunca lanza (auditoría best-effort).

    `detail` va SIN PII: solo metadatos del error/outcome, jamás el payload ni el DNI.
    """
    try:
        async with get_pg_session(binding.tenant_id) as session:
            await session.execute(text("""
                INSERT INTO tool_call_audit
                    (tool_id, tool_slug, actor_ref, outcome, latency_ms, detail)
                VALUES
                    (CAST(:tool_id AS uuid), :tool_slug, :actor_ref, :outcome, :latency_ms,
                     CAST(:detail AS jsonb))
            """), {
                "tool_id": binding.tool_id,
                "tool_slug": binding.tool_slug,
                "actor_ref": hash_actor(actor_ref),
                "outcome": result.outcome,
                "latency_ms": result.latency_ms,
                "detail": _safe_detail(result),
            })
            await session.commit()
    except Exception as exc:
        logger.warning("tool_audit_failed tool=%s error=%s", binding.tool_slug, exc)


def _safe_detail(result) -> str:
    import json
    # Solo el error/flag, nunca data personal.
    detail = {k: v for k, v in (result.detail or {}).items() if k in ("error", "msg", "code")}
    return json.dumps(detail, ensure_ascii=False)
