"""Seed idempotente del conector NEXA (stub) para el demo de Fase 1.

Crea, en el schema de un tenant:
- intención 'consulta_ordenes_pendientes' (para bindear)
- conector 'nexa' (auth_type='stub' → se resuelve in-process, sin red)
- tool 'ordenes_pendientes' con path_template + response_map
- role 'afiliado'
- binding intención → tool

NO siembra ejemplos en Qdrant (eso requiere embeddings / OpenAI). El clasificador
en vivo empezará a matchear cuando se restaure la cuota; para el demo/test la
clasificación se prueba mockeada. La config de conectores queda 100% lista.

Uso:  docker exec local_backend python /app/../scripts/seed_connectors_demo.py <tenant_id>
      (o vía el runner de tests que importa seed_connectors)
"""

from __future__ import annotations

import asyncio
import sys

from sqlalchemy import text

from core.database import get_pg_session

NEXA_BASE_URL = "https://api.nexa.com.ar"  # placeholder; en stub no se llama


async def seed_connectors(tenant_id: str) -> dict:
    async with get_pg_session(tenant_id) as session:
        # 1) Intención a bindear.
        intent_id = (await session.execute(text("""
            INSERT INTO intenciones (label, description, is_active)
            VALUES ('consulta_ordenes_pendientes', 'Consulta de órdenes/autorizaciones pendientes del afiliado', TRUE)
            ON CONFLICT (label) DO UPDATE SET is_active = TRUE
            RETURNING id::text
        """))).scalar()

        # 2) Conector NEXA (stub).
        connector_id = (await session.execute(text("""
            INSERT INTO tenant_connectors
                (slug, display_name, base_url, egress_allow, auth_type, auth_secret_ref, is_active, timeout_ms)
            VALUES
                ('nexa', 'NEXA Obra Social (stub)', :base_url, ARRAY['api.nexa.com.ar'],
                 'stub', 'NEXA_BASIC_CRED', TRUE, 4000)
            ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, base_url = EXCLUDED.base_url
            RETURNING id::text
        """), {"base_url": NEXA_BASE_URL})).scalar()

        # 3) Tool ordenes_pendientes. Los JSONB van como bind params para que el
        # parser de text() no confunda los ':' del JSON con bind params.
        response_map = ('{"items_path":"ordenes","empty_when_empty":true,'
                        '"not_found_field":"encontrado","not_found_value":false}')
        tool_id = (await session.execute(text("""
            INSERT INTO connector_tools
                (connector_id, slug, display_name, http_method, path_template,
                 params_schema, response_map, identity_kind, is_read_only, is_active)
            VALUES
                (CAST(:cid AS uuid), 'ordenes_pendientes', 'Órdenes pendientes del afiliado',
                 'GET', '/afiliados/{identity}/ordenes',
                 CAST(:params AS jsonb), CAST(:rmap AS jsonb),
                 'afiliado', TRUE, TRUE)
            ON CONFLICT (connector_id, slug) DO UPDATE SET is_active = TRUE
            RETURNING id::text
        """), {"cid": connector_id, "params": "{}", "rmap": response_map})).scalar()

        # 4) Role afiliado.
        await session.execute(text("""
            INSERT INTO connector_roles (tool_id, role)
            VALUES (CAST(:tid AS uuid), 'afiliado')
            ON CONFLICT (tool_id, role) DO NOTHING
        """), {"tid": tool_id})

        # 5) Binding intención → tool.
        await session.execute(text("""
            INSERT INTO connector_intent_bindings (intencion_id, tool_id, min_confidence, is_active)
            VALUES (CAST(:iid AS uuid), CAST(:tid AS uuid), 0.70, TRUE)
            ON CONFLICT (intencion_id, tool_id) DO UPDATE SET is_active = TRUE
        """), {"iid": intent_id, "tid": tool_id})

        await session.commit()

    return {"tenant_id": tenant_id, "intent_id": intent_id,
            "connector_id": connector_id, "tool_id": tool_id}


if __name__ == "__main__":
    tid = sys.argv[1] if len(sys.argv) > 1 else "intellix"
    result = asyncio.run(seed_connectors(tid))
    print("seed OK:", result)
