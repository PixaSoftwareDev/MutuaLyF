"""Lectura de planes desde la tabla `public.plans`, con fallback hardcodeado.

La tabla es la fuente de verdad (editable desde el super-admin). El dict
`_FALLBACK_LIMITS` —los mismos valores con los que se siembra la tabla— se usa
SOLO si la tabla falla o no tiene el plan, para que el control de cuotas nunca
se rompa. Cache en memoria con TTL corto para no consultar en cada request.
"""

import logging
import time

from sqlalchemy import text

logger = logging.getLogger(__name__)

# Fallback: idéntico al seed de la migración 026 y al PLAN_LIMITS histórico.
_FALLBACK_LIMITS: dict[str, dict] = {
    "starter":      {"name": "Starter",      "users": 5,   "documents": 500,    "queries_month": 5_000,   "max_mb": 10,  "price_usd": None, "is_active": True, "sort_order": 0},
    "professional": {"name": "Professional", "users": 50,  "documents": 10_000, "queries_month": 100_000, "max_mb": 50,  "price_usd": None, "is_active": True, "sort_order": 1},
    "enterprise":   {"name": "Enterprise",   "users": -1,  "documents": -1,     "queries_month": -1,      "max_mb": 200, "price_usd": None, "is_active": True, "sort_order": 2},
}

_CACHE: dict[str, dict] | None = None
_CACHE_AT: float = 0.0
_CACHE_TTL_S = 60.0


async def _load_all() -> dict[str, dict]:
    """Carga todos los planes de la tabla. Devuelve {} si falla (→ fallback)."""
    from core.database import get_pg_session
    try:
        async with get_pg_session(None) as session:
            rows = (await session.execute(text(
                "SELECT id, name, users, documents, queries_month, max_mb, "
                "price_usd, is_active, sort_order FROM public.plans"
            ))).mappings().all()
        out: dict[str, dict] = {}
        for r in rows:
            out[r["id"]] = {
                "name":          r["name"],
                "users":         r["users"],
                "documents":     r["documents"],
                "queries_month": r["queries_month"],
                "max_mb":        r["max_mb"],
                "price_usd":     float(r["price_usd"]) if r["price_usd"] is not None else None,
                "is_active":     r["is_active"],
                "sort_order":    r["sort_order"],
            }
        return out
    except Exception as exc:
        logger.warning("plans_load_failed error=%s — usando fallback hardcodeado", exc)
        return {}


async def get_all_plans(force: bool = False) -> dict[str, dict]:
    """Todos los planes (cache TTL). Si la tabla falla/vacía, cae al fallback."""
    global _CACHE, _CACHE_AT
    now = time.monotonic()
    if not force and _CACHE is not None and (now - _CACHE_AT) < _CACHE_TTL_S:
        return _CACHE
    loaded = await _load_all()
    # Fallback como base; lo que esté en la tabla pisa. Si la tabla no trajo
    # nada (falla), quedan solo los hardcodeados.
    merged = {**_FALLBACK_LIMITS, **loaded}
    _CACHE = merged
    _CACHE_AT = now
    return merged


async def get_plan_limits(plan: str) -> dict:
    """Límites efectivos de un plan. Nunca rompe (cae a starter si no existe)."""
    plans = await get_all_plans()
    return plans.get(plan) or plans.get("starter") or _FALLBACK_LIMITS["starter"]


def invalidate_cache() -> None:
    """Forzar recarga en la próxima lectura (llamar tras crear/editar un plan)."""
    global _CACHE
    _CACHE = None
