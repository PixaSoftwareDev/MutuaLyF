"""Sliding-window rate limiter per tenant using Redis DB 2.

Limits: settings.rate_limit_requests_per_minute per tenant per minute.
Algorithm: fixed 60-second window with atomic INCR + EXPIRE.

Applied as a FastAPI dependency on query and ingest endpoints.
Returns HTTP 429 with Retry-After header when limit exceeded.
"""

import logging
import time

from fastapi import Depends, HTTPException, Request, status

from core.config import settings
from core.database import get_redis_ratelimit
from core.tenant import get_tenant_id

logger = logging.getLogger(__name__)

_WINDOW_SECONDS = 60


async def check_rate_limit(
    request: Request,
    tenant_id: str = Depends(get_tenant_id),
) -> None:
    """FastAPI dependency — raises 429 if the tenant exceeds the per-minute limit."""
    redis = get_redis_ratelimit()
    window_key = int(time.time()) // _WINDOW_SECONDS
    key = f"{tenant_id}:rl:{window_key}"

    try:
        pipe = redis.pipeline()
        await pipe.incr(key)
        await pipe.expire(key, _WINDOW_SECONDS + 5)  # +5s grace for clock skew
        results = await pipe.execute()
        count = results[0]
    except Exception as exc:
        # Redis unavailable — fail open (don't block the request)
        logger.warning("rate_limit_redis_unavailable tenant_id=%s error=%s", tenant_id, exc)
        return

    limit = settings.rate_limit_requests_per_minute
    if count > limit:
        retry_after = _WINDOW_SECONDS - (int(time.time()) % _WINDOW_SECONDS)
        logger.warning(
            "rate_limit_exceeded tenant_id=%s count=%d limit=%d retry_after=%d",
            tenant_id, count, limit, retry_after,
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Límite de {limit} solicitudes por minuto superado. Reintentá en {retry_after}s.",
            headers={"Retry-After": str(retry_after)},
        )
