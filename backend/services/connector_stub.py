"""Doble de pruebas in-process del framework de conectores — NO es un sistema real.

Simula un sistema externo genérico para probar el flujo completo de Tool Calling
(router → FSM de login → executor → session store → respuesta) en tests y en dev,
sin depender de ningún proveedor. Se activa solo cuando
`settings.connector_stub_enabled` (default: False; en local via CONNECTOR_STUB_ENABLED).

Contrato canónico que emula (el mismo que implementa cualquier conector real):
- validar_totp(identity, code) -> dict con outcome   (acepta code == STUB_VALID_CODE)
- ordenes_pendientes(identity) -> lista de órdenes ficticias

Datos ficticios deterministas por identidad para poder escribir tests estables.
"""

from __future__ import annotations

STUB_VALID_CODE = "111111"  # único código que el stub acepta

# Usuarios ficticios: DNI → nombre + órdenes pendientes.
_USUARIOS: dict[str, dict] = {
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
        "ordenes": [],  # usuario válido SIN órdenes → prueba el outcome 'empty'
    },
}


def validar_totp(identity: str, code: str) -> dict:
    """Valida el segundo factor. Devuelve dict con outcome del contrato canónico.

    - code correcto y usuario existe → {'ok': True, 'nombre': ...}
    - code incorrecto               → {'ok': False, 'reason': 'wrong_code'}
    - usuario no existe             → {'ok': False, 'reason': 'not_found'}
    """
    identity = (identity or "").strip()
    if identity not in _USUARIOS:
        return {"ok": False, "reason": "not_found"}
    if (code or "").strip() != STUB_VALID_CODE:
        return {"ok": False, "reason": "wrong_code"}
    return {"ok": True, "nombre": _USUARIOS[identity]["nombre"]}


def ordenes_pendientes(identity: str) -> dict:
    """Órdenes pendientes del usuario. Estructura estilo respuesta JSON de una API.

    Devuelve la forma cruda que devolvería la API; el executor la normaliza con el
    response_map de la tool al contrato canónico.
    """
    identity = (identity or "").strip()
    usuario = _USUARIOS.get(identity)
    if usuario is None:
        # El executor lo mapeará a forbidden/empty según el response_map.
        return {"usuario": identity, "ordenes": [], "encontrado": False}
    return {"usuario": identity, "ordenes": usuario["ordenes"], "encontrado": True}


# Registro de operaciones del stub, indexado por (connector_slug, tool_slug).
# El executor lo usa para resolver una tool a su función stub in-process.
STUB_OPERATIONS = {
    ("demo", "ordenes_pendientes"): ordenes_pendientes,
}
