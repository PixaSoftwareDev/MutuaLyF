"""Defensas del framework de conectores que se rompieron una vez y no pueden volver.

Cada test corresponde a un agujero REAL encontrado en la auditoría previa a
producción (2026-08-02). No son ejemplos teóricos: los tres estaban explotables
en el código que ya corría.
"""

import pytest

from core.egress_guard import _is_blocked_ip
from services.connector_discovery import _build_tool_fields


# ── 1. SSRF: IPv6 que envuelve una IPv4 ───────────────────────────────────────
# Comparar ::ffff:10.0.0.5 contra las redes v4 da False (versiones distintas, sin
# error): un host de la allowlist con ese AAAA alcanzaba loopback y la metadata
# del cloud esquivando toda la lista de bloqueo.

@pytest.mark.parametrize("ip", [
    "127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.5", "::ffff:169.254.169.254",
    "2002:a9fe:a9fe::1",   # 6to4 envolviendo 169.254.169.254
    "198.18.0.1", "240.0.0.1",
])
def test_destinos_internos_bloqueados(ip):
    assert _is_blocked_ip(ip) is True


@pytest.mark.parametrize("ip", [
    "8.8.8.8", "1.1.1.1", "149.50.152.218", "2606:4700:4700::1111",
])
def test_destinos_publicos_permitidos(ip):
    assert _is_blocked_ip(ip) is False


# ── 2. BOLA: identidad que viaja como query param ─────────────────────────────
# El discovery la descartaba: la tool quedaba "personal" (pedía login + OTP) pero
# salía SIN filtro de identidad y devolvía los datos de TODAS las personas.

def test_identidad_por_query_param_no_se_pierde():
    route = {"path": "/ordenes", "method": "GET", "params": [
        {"name": "dni", "in": "query", "required": True, "type": "string"},
        {"name": "estado", "in": "query", "required": False, "type": "string"},
    ]}
    path, schema = _build_tool_fields(route, {"identity_param": "dni"})
    assert schema.get("x-identity-query-param") == "dni", "el executor no podría inyectarla"
    assert "dni" not in (schema.get("properties") or {}), "el LLM no debe poder setear la identidad"
    assert "estado" in schema["properties"], "los demás params se conservan"


def test_identidad_en_el_path_sigue_como_placeholder():
    route = {"path": "/afiliados/{dni}/ordenes", "method": "GET", "params": [
        {"name": "dni", "in": "path", "required": True, "type": "string"},
    ]}
    path, schema = _build_tool_fields(route, {"identity_param": "dni"})
    assert path == "/afiliados/{identity}/ordenes"
    assert "x-identity-query-param" not in schema
    assert "dni" not in (schema.get("properties") or {})


# ── 3. Prefijo duplicado y ruta absoluta ──────────────────────────────────────
# La base /crmpixs/api + rutas con el mismo prefijo producían URLs duplicadas
# (404 en todas las operaciones del proveedor).

def test_join_url_prefijo_multisegmento_y_absoluta():
    from services.connector_executor import join_url
    assert join_url("http://h/crmpixs/api", "/crmpixs/api/contacts") == "http://h/crmpixs/api/contacts"
    assert join_url("https://api.x.com", "https://geo.x.com/v1/search") == "https://geo.x.com/v1/search"
