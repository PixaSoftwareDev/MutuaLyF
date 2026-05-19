"""Genera un widget_token nuevo para tenant 'mutual' y sincroniza el hash en DB.

Igual a lo que hace POST /tenants/{id}/widget-token pero sin necesidad de JWT admin.
Solo para testing local.
"""

import asyncio
import hashlib
import sys


async def main(tenant_id: str = "mutual") -> None:
    from core.security import create_widget_token
    from core.database import get_pg_session, get_redis_cache
    from sqlalchemy import text

    token = create_widget_token(tenant_id)
    token_hash = hashlib.sha256(token.encode()).hexdigest()

    async with get_pg_session(None) as session:
        await session.execute(
            text("UPDATE tenants SET widget_token_hash = :h, updated_at = NOW() WHERE id = :tid"),
            {"h": token_hash, "tid": tenant_id},
        )

    redis = get_redis_cache()
    try:
        await redis.delete(f"{tenant_id}:widget_token_hash")
    except Exception:
        pass

    print(token)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "mutual"))
