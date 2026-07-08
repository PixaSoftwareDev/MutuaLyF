"""Repara mojibake (doble-encoding) en consultas_log de un tenant.

El texto corrupto (ej: batch de junio de mutualyf) fragmenta clusters y ensucia
las intenciones aprendidas. Este script recorre las filas, aplica repair_mojibake
y actualiza solo las que cambian. Idempotente y seguro.

Uso (dentro del contenedor backend):
    python ../scripts/repair_consultas_mojibake.py <tenant_id>
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from sqlalchemy import text  # noqa: E402

from core.database import get_pg_session  # noqa: E402
from core.text_utils import repair_mojibake  # noqa: E402


async def repair_tenant(tenant_id: str) -> None:
    fixed = 0
    async with get_pg_session(tenant_id) as session:
        rows = (await session.execute(text(
            "SELECT id, question_text FROM consultas_log WHERE question_text IS NOT NULL"
        ))).fetchall()

        for row_id, qt in rows:
            repaired = repair_mojibake(qt)
            if repaired and repaired != qt:
                await session.execute(
                    text("UPDATE consultas_log SET question_text = :qt WHERE id = :id"),
                    {"qt": repaired[:500], "id": row_id},
                )
                fixed += 1

    print(f"[mojibake] tenant={tenant_id} filas_reparadas={fixed}")


if __name__ == "__main__":
    tid = sys.argv[1] if len(sys.argv) > 1 else "mutualyf"
    asyncio.run(repair_tenant(tid))
