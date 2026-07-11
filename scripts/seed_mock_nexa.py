"""Seed del conector NEXA en modo HTTP REAL apuntando al servicio mock_nexa.

Configura el conector 'nexa' como http (base_url=http://mock_nexa:4003) y crea las
4 tools + intenciones + bindings. Supera al seed stub para el tenant elegido: acá
el executor hace requests HTTP reales (httpx + egress_guard) contra mock_nexa.

Tools:
  PÚBLICAS (identity_kind='publico', sin login):
    profesionales_por_especialidad  GET /profesionales?especialidad=…
    horarios_profesional            GET /profesionales/{matricula}/horarios
  PERSONALES (identity_kind='afiliado', login DNI+código):
    ordenes_pendientes              GET /afiliados/{identity}/ordenes
    cuenta_afiliado                 GET /afiliados/{identity}/cuenta

Uso: docker exec local_backend python /tmp/seed_mock_nexa.py <tenant_id>
"""

from __future__ import annotations

import asyncio
import json
import sys

from sqlalchemy import text

from core.database import get_pg_session

BASE_URL = "http://mock_nexa:4003"
EGRESS = "mock_nexa"

TOOLS = [
    {
        "slug": "profesionales_por_especialidad",
        "display": "Profesionales por especialidad",
        "method": "GET", "path": "/profesionales",
        "params": {"type": "object",
                   "properties": {"especialidad": {"type": "string",
                       "enum": ["Cardiología", "Pediatría", "Traumatología", "Dermatología"]}},
                   "required": ["especialidad"]},
        "rmap": {"items_path": "profesionales", "empty_when_empty": True},
        "identity_kind": "publico",
        "intent": "buscar_profesional_especialidad",
        "intent_desc": "Buscar profesionales/médicos por especialidad y sus horarios",
        "roles": ["afiliado", "publico"],
    },
    {
        "slug": "horarios_profesional",
        "display": "Horarios de atención de un profesional",
        "method": "GET", "path": "/profesionales/{matricula}/horarios",
        "params": {"type": "object",
                   "properties": {"matricula": {"type": "string", "pattern": "MP-\\d+"}},
                   "required": ["matricula"]},
        "rmap": {},
        "identity_kind": "publico",
        "intent": "consultar_horarios_profesional",
        "intent_desc": "Consultar los horarios de atención de un profesional por matrícula",
        "roles": ["afiliado", "publico"],
    },
    {
        "slug": "ordenes_pendientes",
        "display": "Órdenes pendientes del afiliado",
        "method": "GET", "path": "/afiliados/{identity}/ordenes",
        "params": {},
        "rmap": {"items_path": "ordenes", "empty_when_empty": True,
                 "not_found_field": "encontrado", "not_found_value": False},
        "identity_kind": "afiliado",
        "intent": "consulta_ordenes_pendientes",
        "intent_desc": "Consulta de órdenes/autorizaciones pendientes del afiliado",
        "roles": ["afiliado"],
    },
    {
        "slug": "cuenta_afiliado",
        "display": "Cuenta corriente del afiliado",
        "method": "GET", "path": "/afiliados/{identity}/cuenta",
        "params": {},
        "rmap": {"not_found_field": "encontrado", "not_found_value": False, "empty_when_empty": False},
        "identity_kind": "afiliado",
        "intent": "consulta_cuenta_corriente",
        "intent_desc": "Consulta de saldo / deuda de cuenta corriente del afiliado",
        "roles": ["afiliado"],
    },
]


async def seed(tenant_id: str) -> dict:
    async with get_pg_session(tenant_id) as session:
        # Conector nexa en modo HTTP real.
        connector_id = (await session.execute(text("""
            INSERT INTO tenant_connectors
                (slug, display_name, base_url, egress_allow, auth_type, auth_secret_ref, is_active, timeout_ms)
            VALUES ('nexa', 'NEXA (mock HTTP)', :base, ARRAY[:egress], 'none', NULL, TRUE, 4000)
            ON CONFLICT (slug) DO UPDATE SET
                base_url = EXCLUDED.base_url, egress_allow = EXCLUDED.egress_allow,
                auth_type = 'none', is_active = TRUE
            RETURNING id::text
        """), {"base": BASE_URL, "egress": EGRESS})).scalar()

        created = []
        for t in TOOLS:
            intent_id = (await session.execute(text("""
                INSERT INTO intenciones (label, description, is_active)
                VALUES (:label, :desc, TRUE)
                ON CONFLICT (label) DO UPDATE SET is_active = TRUE
                RETURNING id::text
            """), {"label": t["intent"], "desc": t["intent_desc"]})).scalar()

            tool_id = (await session.execute(text("""
                INSERT INTO connector_tools
                    (connector_id, slug, display_name, http_method, path_template,
                     params_schema, response_map, identity_kind, is_read_only, is_active)
                VALUES (CAST(:cid AS uuid), :slug, :disp, :method, :path,
                        CAST(:params AS jsonb), CAST(:rmap AS jsonb), :ikind, TRUE, TRUE)
                ON CONFLICT (connector_id, slug) DO UPDATE SET
                    path_template = EXCLUDED.path_template, params_schema = EXCLUDED.params_schema,
                    response_map = EXCLUDED.response_map, identity_kind = EXCLUDED.identity_kind,
                    is_active = TRUE
                RETURNING id::text
            """), {"cid": connector_id, "slug": t["slug"], "disp": t["display"],
                   "method": t["method"], "path": t["path"],
                   "params": json.dumps(t["params"]), "rmap": json.dumps(t["rmap"]),
                   "ikind": t["identity_kind"]})).scalar()

            for role in t["roles"]:
                await session.execute(text("""
                    INSERT INTO connector_roles (tool_id, role) VALUES (CAST(:tid AS uuid), :role)
                    ON CONFLICT (tool_id, role) DO NOTHING
                """), {"tid": tool_id, "role": role})

            await session.execute(text("""
                INSERT INTO connector_intent_bindings (intencion_id, tool_id, min_confidence, is_active)
                VALUES (CAST(:iid AS uuid), CAST(:tid AS uuid), 0.70, TRUE)
                ON CONFLICT (intencion_id, tool_id) DO UPDATE SET is_active = TRUE
            """), {"iid": intent_id, "tid": tool_id})
            created.append(t["slug"])

        await session.commit()
    return {"tenant_id": tenant_id, "connector_id": connector_id, "tools": created}


if __name__ == "__main__":
    tid = sys.argv[1] if len(sys.argv) > 1 else "intellix"
    print("seed mock_nexa OK:", asyncio.run(seed(tid)))
