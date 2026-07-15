"""Stub in-process de NEXA para desarrollo/tests — NO es NEXA real.

Permite probar el flujo completo de Tool Calling y el FSM de login end-to-end en
local sin depender de que NEXA entregue Swagger/credenciales/entorno test. Se
activa solo cuando `settings.nexa_stub_enabled` (default: solo en development).

Contrato que emula (a confirmar contra el Swagger real de NEXA en el último paso):
- validar_totp(dni_or_cuit, code) -> bool   (acepta code == STUB_VALID_CODE)
- ordenes_pendientes(identity)    -> lista de órdenes ficticias

Datos ficticios deterministas por identidad para poder escribir tests estables.
"""

from __future__ import annotations

STUB_VALID_CODE = "111111"  # único código que el stub acepta (criterio de aceptación F1)

# Afiliados ficticios: DNI → nombre + órdenes pendientes.
_AFILIADOS: dict[str, dict] = {
    "30111222": {
        "nombre": "Guillermo Fernández",
        "ordenes": [
            {"id": "ORD-1001", "tipo": "Consulta cardiología", "estado": "pendiente",
             "prestador": "Dr. Pérez", "vence": "2026-08-15"},
            {"id": "ORD-1002", "tipo": "Laboratorio - análisis de sangre", "estado": "pendiente",
             "prestador": "Lab Central", "vence": "2026-07-30"},
        ],
    },
    "27888999": {
        "nombre": "María López",
        "ordenes": [],  # afiliado válido SIN órdenes → prueba el outcome 'empty'
    },
}


def validar_totp(identity: str, code: str) -> dict:
    """Valida el segundo factor. Devuelve dict con outcome del contrato canónico.

    - code correcto y afiliado existe → {'ok': True, 'nombre': ...}
    - code incorrecto                 → {'ok': False, 'reason': 'wrong_code'}
    - afiliado no existe              → {'ok': False, 'reason': 'not_found'}
    """
    identity = (identity or "").strip()
    if identity not in _AFILIADOS:
        return {"ok": False, "reason": "not_found"}
    if (code or "").strip() != STUB_VALID_CODE:
        return {"ok": False, "reason": "wrong_code"}
    return {"ok": True, "nombre": _AFILIADOS[identity]["nombre"]}


def ordenes_pendientes(identity: str) -> dict:
    """Órdenes pendientes del afiliado. Estructura estilo respuesta JSON de NEXA.

    Devuelve la forma cruda que devolvería la API; el executor la normaliza con el
    response_map de la tool al contrato canónico.
    """
    identity = (identity or "").strip()
    afiliado = _AFILIADOS.get(identity)
    if afiliado is None:
        # El executor lo mapeará a forbidden/empty según el response_map.
        return {"afiliado": identity, "ordenes": [], "encontrado": False}
    return {"afiliado": identity, "ordenes": afiliado["ordenes"], "encontrado": True}


# Registro de operaciones del stub, indexado por (connector_slug, tool_slug).
# El executor lo usa para resolver una tool a su función stub in-process.
STUB_OPERATIONS = {
    ("nexa", "ordenes_pendientes"): ordenes_pendientes,
}
