"""Real-time event bus via Redis Pub/Sub.

Publishers call `publish(tenant_id, event_type, payload)` after any state change.
Subscribers (SSE endpoint) call `subscribe(tenant_id)` to get an async generator
that yields JSON-encoded event strings.

Channel naming: `events:{tenant_id}`
"""

import json
import logging

logger = logging.getLogger(__name__)

_CHANNEL_PREFIX = "events:"
_PRESENCE_PREFIX = "presence:"
_PRESENCE_TTL = 35  # seconds — keepalive is 15s so 35s gives 2 missed keepalives before expiry


def _channel(tenant_id: str) -> str:
    return f"{_CHANNEL_PREFIX}{tenant_id}"


def _presence_key(tenant_id: str, user_id: str) -> str:
    return f"{_PRESENCE_PREFIX}{tenant_id}:{user_id}"


async def set_presence(tenant_id: str, user_id: str, name: str) -> None:
    """Mark operator as online. Call on SSE connect and each keepalive."""
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        await redis.setex(_presence_key(tenant_id, user_id), _PRESENCE_TTL, name)
    except Exception as exc:
        logger.debug("presence_set_failed error=%s", exc)


async def clear_presence(tenant_id: str, user_id: str) -> None:
    """Mark operator as offline. Call on SSE disconnect."""
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        await redis.delete(_presence_key(tenant_id, user_id))
    except Exception as exc:
        logger.debug("presence_clear_failed error=%s", exc)


async def get_online_operators(tenant_id: str) -> list[dict]:
    """Return list of currently online operators: [{user_id, name}]."""
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        pattern = _presence_key(tenant_id, "*")
        keys = await redis.keys(pattern)
        if not keys:
            return []
        names = await redis.mget(*keys)
        result = []
        for key, name in zip(keys, names):
            if name is None:
                continue
            user_id = key.split(":")[-1]
            result.append({"user_id": user_id, "name": name})
        return result
    except Exception as exc:
        logger.debug("presence_get_failed error=%s", exc)
        return []


async def publish(tenant_id: str, event_type: str, payload: dict) -> None:
    """Publish an event to all SSE subscribers for this tenant."""
    try:
        from core.database import get_redis_cache
        redis = get_redis_cache()
        message = json.dumps({"type": event_type, **payload})
        await redis.publish(_channel(tenant_id), message)
        logger.debug("event_published tenant=%s type=%s", tenant_id, event_type)
    except Exception as exc:
        logger.warning("event_publish_failed tenant=%s type=%s error=%s", tenant_id, event_type, exc)


async def subscribe(tenant_id: str, user_id: str | None = None, user_name: str | None = None):
    """Async generator that yields SSE-formatted strings for this tenant.

    Yields keepalive comments every 15s so proxies don't close the connection.
    If user_id/user_name are provided, refreshes presence on each keepalive.
    Automatically cleans up the pubsub connection on client disconnect.
    """
    import asyncio
    from core.database import new_redis_pubsub_connection

    redis_conn = new_redis_pubsub_connection()
    pubsub = redis_conn.pubsub()
    await pubsub.subscribe(_channel(tenant_id))
    logger.info("sse_subscribed tenant=%s user=%s", tenant_id, user_id)

    if user_id and user_name:
        await set_presence(tenant_id, user_id, user_name)

    try:
        while True:
            try:
                message = await asyncio.wait_for(pubsub.get_message(ignore_subscribe_messages=True), timeout=15.0)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                if user_id and user_name:
                    await set_presence(tenant_id, user_id, user_name)
                continue

            if message is None:
                await asyncio.sleep(0.05)
                continue

            if message["type"] == "message":
                data = message["data"]
                yield f"data: {data}\n\n"

    except asyncio.CancelledError:
        pass
    finally:
        if user_id:
            await clear_presence(tenant_id, user_id)
        try:
            await pubsub.unsubscribe(_channel(tenant_id))
            await pubsub.aclose()
            await redis_conn.aclose()
        except Exception:
            pass
        logger.info("sse_unsubscribed tenant=%s user=%s", tenant_id, user_id)
