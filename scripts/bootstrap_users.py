"""One-shot bootstrap: create super_admin PIXS, tenant MUTUAL with admin + operator.

Run inside the backend container:
    docker compose exec backend python /app/scripts/bootstrap_users.py
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
sys.path.insert(0, "/app")

import asyncpg

from core.config import settings
from core.security import hash_password
from provision_tenant import provision_tenant


async def create_super_admin() -> None:
    dsn = settings.postgres_dsn_sync.replace("+asyncpg", "")
    conn = await asyncpg.connect(dsn)
    try:
        existing = await conn.fetchval(
            "SELECT id FROM public.platform_users WHERE email = $1",
            "pixs@platform.local",
        )
        if existing:
            print(f"[bootstrap] super_admin PIXS already exists (id={existing}). Skipping.")
            return
        await conn.execute(
            """
            INSERT INTO public.platform_users (email, name, hashed_password, is_active)
            VALUES ($1, $2, $3, TRUE)
            """,
            "pixs@platform.local",
            "PIXS",
            hash_password("pixs1234!"),
        )
        print("[bootstrap] super_admin PIXS created.")
    finally:
        await conn.close()


async def create_operator() -> None:
    """Add operator to tenant_mutual.usuarios."""
    dsn = settings.postgres_dsn_sync.replace("+asyncpg", "")
    conn = await asyncpg.connect(dsn)
    try:
        existing = await conn.fetchval(
            'SELECT id FROM "tenant_mutual".usuarios WHERE email = $1',
            "operador@mutual.local",
        )
        if existing:
            print(f"[bootstrap] operator already exists (id={existing}). Skipping.")
            return
        await conn.execute(
            """
            INSERT INTO "tenant_mutual".usuarios (email, name, hashed_password, role)
            VALUES ($1, $2, $3, 'operator')
            """,
            "operador@mutual.local",
            "Operador 1",
            hash_password("operador1234!"),
        )
        print("[bootstrap] operator created in tenant_mutual.")
    finally:
        await conn.close()


async def main() -> None:
    print("[bootstrap] Creating super_admin PIXS...")
    await create_super_admin()

    print("[bootstrap] Provisioning tenant MUTUAL...")
    try:
        await provision_tenant(
            tenant_id="mutual",
            name="MUTUAL",
            plan="professional",
            admin_email="admin@mutual.local",
            admin_name="Admin MUTUAL",
            admin_password="mutual1234!",
        )
        print("[bootstrap] tenant MUTUAL provisioned with admin.")
    except Exception as e:
        msg = str(e).lower()
        if "already exists" in msg or "duplicate" in msg:
            print(f"[bootstrap] tenant MUTUAL already exists. Skipping provision.")
        else:
            raise

    print("[bootstrap] Creating operator...")
    await create_operator()

    print()
    print("=" * 60)
    print("LISTO — credenciales:")
    print("=" * 60)
    print("SUPER ADMIN")
    print("  email   : pixs@platform.local")
    print("  password: pixs1234!")
    print()
    print("ADMIN (tenant MUTUAL)")
    print("  tenant  : mutual")
    print("  email   : admin@mutual.local")
    print("  password: mutual1234!")
    print()
    print("OPERATOR (tenant MUTUAL)")
    print("  tenant  : mutual")
    print("  email   : operador@mutual.local")
    print("  password: operador1234!")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
