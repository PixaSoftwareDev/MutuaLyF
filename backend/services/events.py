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
# TTL holgado para sobrevivir reconexiones del EventSource (Chrome throttlea
# pestañas en background y puede reconectar cada ~60s). Con keepalive cada 15s
# el TTL se refresca seis veces antes de expirar, y si el cliente cae 1 min
# y vuelve, la presencia no parpadea.
_PRESENCE_TTL = 90  # seconds


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


async def wait_for_event(tenant_id: str, predicate, timeout: float = 25.0) -> dict | None:
    """Subscribe to tenant channel and return the first event matching predicate.

    Used by long-polling endpoints (e.g. widget /poll) to hold the request
    open until something interesting happens. Returns None on timeout —
    callers should treat that as "nothing new, client will retry".

    `predicate(event_dict) -> bool` decides which events count. Each event
    dict has at least a `type` field plus whatever the publisher attached.
    """
    import asyncio
    from core.database import new_redis_pubsub_connection

    redis_conn = new_redis_pubsub_connection()
    pubsub = redis_conn.pubsub()
    await pubsub.subscribe(_channel(tenant_id))
    deadline = asyncio.get_event_loop().time() + timeout
    try:
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                return None
            try:
                msg = await asyncio.wait_for(
                    pubsub.get_message(ignore_subscribe_messages=True),
                    timeout=remaining,
                )
            except asyncio.TimeoutError:
                return None
            if msg is None or msg.get("type") != "message":
                await asyncio.sleep(0.02)
                continue
            try:
                event = json.loads(msg["data"])
            except Exception:
                continue
            if predicate(event):
                return event
    finally:
        try:
            await pubsub.unsubscribe(_channel(tenant_id))
            await pubsub.aclose()
            await redis_conn.aclose()
        except Exception:
            pass


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
        # OJO: NO llamamos clear_presence acá. Si el cliente reconecta rápido
        # (caso común con EventSource y pestaña en background), el cleanup del
        # SSE viejo puede ejecutarse DESPUÉS del set_presence del SSE nuevo y
        # borrar la key recién creada. Mejor dejar que expire por TTL —
        # el costo es que un operador que cierra la pestaña aparece online
        # hasta 90s, que es aceptable.
        try:
            await pubsub.unsubscribe(_channel(tenant_id))
            await pubsub.aclose()
            await redis_conn.aclose()
        except Exception:
            pass
        logger.info("sse_unsubscribed tenant=%s user=%s", tenant_id, user_id)
