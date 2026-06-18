"""Gasto de la organización en OpenAI vía la Admin API (`/v1/organization/costs`).

Usa la Admin API key (`settings.openai_admin_api_key`, sk-admin-…), distinta de
la key de inferencia. Es solo lectura de billing. Si no hay key configurada,
devuelve `available=False` y el panel lo muestra como "no configurado" — nunca
rompe el Inicio.

La Costs API agrupa por día (`bucket_width=1d`); sumamos los buckets del rango
para el total. No expone el saldo/créditos restantes (OpenAI lo deprecó): solo
el gasto incurrido, que es lo que importa para el negocio.
"""

import logging
import time

import httpx

from core.config import settings

logger = logging.getLogger(__name__)

_COSTS_URL = "https://api.openai.com/v1/organization/costs"
_TIMEOUT_S = 20.0
_MAX_PAGES = 8  # tope defensivo de paginación


async def get_costs(days: int = 30) -> dict:
    """Gasto de la organización en los últimos `days` días.

    Returns un dict siempre (nunca lanza):
      {available: bool, total_usd: float, currency: str,
       daily: [{ts: int, usd: float}], reason?: str}
    """
    key = (settings.openai_admin_api_key or "").strip()
    if not key:
        return {"available": False, "reason": "no_admin_key", "total_usd": 0.0, "currency": "usd", "daily": []}

    start_time = int(time.time()) - days * 86400
    headers = {"Authorization": f"Bearer {key}"}
    base_params = {"start_time": start_time, "bucket_width": "1d", "limit": min(days + 1, 180)}

    buckets: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            page: str | None = None
            for _ in range(_MAX_PAGES):
                params = dict(base_params)
                if page:
                    params["page"] = page
                resp = await client.get(_COSTS_URL, headers=headers, params=params)
                if resp.status_code != 200:
                    logger.warning("openai_costs_failed status=%s body=%s", resp.status_code, resp.text[:200])
                    return {"available": False, "reason": f"http_{resp.status_code}", "total_usd": 0.0, "currency": "usd", "daily": []}
                data = resp.json()
                buckets.extend(data.get("data") or [])
                if data.get("has_more") and data.get("next_page"):
                    page = data["next_page"]
                else:
                    break
    except Exception as exc:
        logger.warning("openai_costs_error error=%s", exc)
        return {"available": False, "reason": "request_error", "total_usd": 0.0, "currency": "usd", "daily": []}

    daily: list[dict] = []
    total = 0.0
    currency = "usd"
    for b in buckets:
        day_usd = 0.0
        for r in (b.get("results") or []):
            amount = r.get("amount") or {}
            day_usd += float(amount.get("value") or 0.0)
            currency = amount.get("currency") or currency
        total += day_usd
        daily.append({"ts": b.get("start_time"), "usd": round(day_usd, 4)})

    return {
        "available": True,
        "currency": currency,
        "total_usd": round(total, 2),
        "daily": daily,
    }
