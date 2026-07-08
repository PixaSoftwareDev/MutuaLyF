"""Provisiona el tenant 'pixs' y lo puebla con el escenario completo (seed_full_demo).

Pensado para el ambiente de desarrollo LOCAL aislado (base propia, datos de
ejemplo). NO copia datos reales de clientes — todo es sintético.

Crea: admin + 3 operadores, 4 sectores, ~15 conversaciones (mix bot/handoff/
human/closed), intenciones y logs. Idempotente (se puede re-correr).

Uso (ambiente local):
    ./scripts/dev-local.sh seed-pixs
    # o directo:
    docker compose -f docker-compose.local.yml --env-file .env.local \\
        exec backend python ../scripts/seed_pixs.py

Login que deja listo:
    admin@pixs.local / pixs1234!            (admin)
    laura.gomez@pixs.local / operador123!   (operador)  y otros 2 operadores
"""

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

# seed_full_demo lee SEED_TENANT_ID al importarse → hay que setearlo ANTES.
os.environ.setdefault("SEED_TENANT_ID", "pixs")
TENANT_ID = os.environ["SEED_TENANT_ID"]

from provision_tenant import provision_tenant  # noqa: E402


async def main() -> None:
    print(f"[seed-pixs] Provisionando tenant '{TENANT_ID}'...")
    try:
        await provision_tenant(
            tenant_id=TENANT_ID,
            name="Pixs",
            plan="professional",
            admin_email=f"admin@{TENANT_ID}.local",
            admin_name="Admin Pixs",
            admin_password="pixs1234!",
        )
        print(f"[seed-pixs] Tenant '{TENANT_ID}' creado.")
    except Exception as e:
        if "exist" in str(e).lower() or "duplicate" in str(e).lower():
            print(f"[seed-pixs] Tenant '{TENANT_ID}' ya existe — sigo con el poblado.")
        else:
            print(f"[seed-pixs] ERROR provisionando: {e}")
            raise

    # Poblado del escenario. Se importa acá, con SEED_TENANT_ID ya seteado, para
    # que apunte a 'pixs'. Es idempotente (limpia y recarga los datos de demo).
    import seed_full_demo  # noqa: E402
    await seed_full_demo.main()


if __name__ == "__main__":
    asyncio.run(main())
