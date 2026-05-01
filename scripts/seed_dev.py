"""Create a dev tenant and seed minimal data for smoke testing.

Usage (inside backend container or with correct .env loaded):
    python scripts/seed_dev.py
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from provision_tenant import provision_tenant  # noqa: E402


async def main() -> None:
    print("[seed] Creating dev tenant 'demo'...")
    try:
        await provision_tenant(
            tenant_id="demo",
            name="Demo Organization",
            plan="professional",
            admin_email="admin@demo.local",
            admin_name="Admin Demo",
            admin_password="demo1234!",
        )
        print("[seed] Tenant 'demo' created successfully.")
        print()
        print("  Tenant ID : demo")
        print("  Admin     : admin@demo.local")
        print("  Password  : demo1234!")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate" in str(e).lower():
            print(f"[seed] Tenant 'demo' already exists — skipping.")
        else:
            print(f"[seed] ERROR: {e}")
            raise


if __name__ == "__main__":
    asyncio.run(main())
