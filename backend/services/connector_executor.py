"""Executor HTTP genérico de conectores — el intérprete de la config.

Una sola pieza de código sirve a N conectores. Dada una ToolBinding (resuelta por
connectors_dao) + la identidad de la sesión + los params que decidió el LLM:

1. valida los params contra params_schema (subset de JSON Schema, sin deps)
2. arma la URL: path_template con {identity} server-side + placeholders de params;
   los params sobrantes van como query string (GET) o body (POST)
3. valida el egress con core.egress_guard (anti-SSRF) antes de salir
4. invoca: stub in-process (dev) o httpx real, con circuit breaker + timeout
5. normaliza la respuesta cruda al contrato canónico con response_map

Contrato canónico de outcome: ok | empty | auth_required | forbidden | upstream_error.
El {identity} SIEMPRE viene de la sesión (server-side), NUNCA de params ni del
texto del usuario (defensa BOLA/IDOR).
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field

import httpx

from core.config import settings
from core.egress_guard import EgressBlocked, assert_egress_allowed

logger = logging.getLogger(__name__)

# Outcomes del contrato canónico.
OK = "ok"
EMPTY = "empty"
AUTH_REQUIRED = "auth_required"
FORBIDDEN = "forbidden"
UPSTREAM_ERROR = "upstream_error"


@dataclass
class ExecResult:
    outcome: str
    data: dict | list | None = None
    tool_slug: str = ""
    latency_ms: int = 0
    detail: dict = field(default_factory=dict)


class ParamValidationError(Exception):
    """Los params provistos no cumplen params_schema."""


# ── Circuit breaker por-proceso (patrón replicado de services/neo4j_client.py) ──
class ConnectorCircuitOpen(Exception):
    """El circuit breaker del executor está abierto (fallos recientes)."""


_circuit_failure_count = 0
_CIRCUIT_THRESHOLD = 3
_CIRCUIT_OPEN_AT: float | None = None
_CIRCUIT_HALF_OPEN_TTL = 30.0


def _record_failure() -> None:
    global _circuit_failure_count, _CIRCUIT_OPEN_AT
    _circuit_failure_count += 1
    if _circuit_failure_count >= _CIRCUIT_THRESHOLD and _CIRCUIT_OPEN_AT is None:
        _CIRCUIT_OPEN_AT = time.monotonic()
        logger.error("connector_circuit_opened retry_after=%.0fs", _CIRCUIT_HALF_OPEN_TTL)


def _reset_circuit() -> None:
    global _circuit_failure_count, _CIRCUIT_OPEN_AT
    _circuit_failure_count = 0
    _CIRCUIT_OPEN_AT = None


def _circuit_is_open() -> bool:
    global _circuit_failure_count, _CIRCUIT_OPEN_AT
    if _circuit_failure_count < _CIRCUIT_THRESHOLD:
        return False
    if _CIRCUIT_OPEN_AT is not None and (time.monotonic() - _CIRCUIT_OPEN_AT) >= _CIRCUIT_HALF_OPEN_TTL:
        _circuit_failure_count = _CIRCUIT_THRESHOLD - 1  # deja pasar una prueba (half-open)
        _CIRCUIT_OPEN_AT = None
        return False
    return True


# ── Validación mínima de params (subset de JSON Schema, sin dependencias) ──────
_PY_TYPES = {
    "string": str, "integer": int, "number": (int, float),
    "boolean": bool, "object": dict, "array": list,
}


def validate_params(params: dict, schema: dict) -> dict:
    """Valida y devuelve solo los params permitidos por schema. Lanza si falta un
    required o si un tipo no coincide. Descarta claves no declaradas (no las pasa)."""
    params = params or {}
    if not schema or schema.get("type") not in (None, "object"):
        return {}
    props: dict = schema.get("properties", {})
    required: list = schema.get("required", [])

    for req in required:
        if req not in params or params[req] is None:
            raise ParamValidationError(f"falta el parámetro requerido: {req}")

    clean: dict = {}
    for key, spec in props.items():
        if key not in params or params[key] is None:
            continue
        expected = _PY_TYPES.get(spec.get("type", "string"), str)
        # bool es subclase de int en Python; evitá que un bool pase como integer.
        if expected in (int, (int, float)) and isinstance(params[key], bool):
            raise ParamValidationError(f"parámetro {key}: se esperaba número, no booleano")
        if not isinstance(params[key], expected):
            raise ParamValidationError(f"parámetro {key}: tipo inválido")
        clean[key] = params[key]
    return clean


def _build_path(path_template: str, identity: str, params: dict) -> tuple[str, dict]:
    """Sustituye {identity} (server-side) y {param} en el path. Devuelve (path, query)
    donde query son los params que no se consumieron en el path."""
    path = path_template.replace("{identity}", str(identity))
    query = dict(params)
    for key in list(query.keys()):
        placeholder = "{" + key + "}"
        if placeholder in path:
            path = path.replace(placeholder, str(query.pop(key)))
    return path, query


def _apply_response_map(raw: dict | list, response_map: dict) -> ExecResult:
    """Normaliza la respuesta cruda al contrato canónico según response_map.

    Vocabulario soportado (chico y explícito, no JSONPath completo todavía):
      items_path:        clave (dotted) hacia la lista/dato de interés
      empty_when_empty:  si la lista está vacía → outcome=empty
      not_found_field / not_found_value: si raw[field]==value → forbidden
    """
    rm = response_map or {}

    # Marcador de "identidad no encontrada" → forbidden (no exponemos nada).
    nf_field = rm.get("not_found_field")
    if nf_field and isinstance(raw, dict) and raw.get(nf_field) == rm.get("not_found_value"):
        return ExecResult(outcome=FORBIDDEN, data=None)

    data = raw
    items_path = rm.get("items_path")
    if items_path and isinstance(raw, dict):
        node = raw
        for part in items_path.split("."):
            node = node.get(part) if isinstance(node, dict) else None
        data = node

    if rm.get("empty_when_empty", True) and isinstance(data, (list, dict)) and len(data) == 0:
        return ExecResult(outcome=EMPTY, data=data)

    return ExecResult(outcome=OK, data=data)


async def _invoke_stub(binding, identity: str, query: dict) -> dict | list:
    from services.nexa_stub import STUB_OPERATIONS
    op = STUB_OPERATIONS.get((binding.connector_slug, binding.tool_slug))
    if op is None:
        raise RuntimeError(f"stub sin operación para {binding.connector_slug}/{binding.tool_slug}")
    # Los stubs son síncronos y baratos; envolver por si en el futuro son async.
    result = op(identity, **query) if query else op(identity)
    return result


async def _invoke_http(binding, path: str, query: dict) -> dict | list:
    url = binding.base_url.rstrip("/") + "/" + path.lstrip("/")
    # Anti-SSRF: el host debe estar en la allowlist del conector y no resolver a
    # una IP interna. En prod exigimos https. En dev, hosts mock de confianza
    # (ej. mock_nexa) quedan exentos de la verificación de IP interna.
    allow_http = settings.environment == "development"
    assert_egress_allowed(
        url, binding.egress_allow, allow_http=allow_http,
        trusted_internal_hosts=settings.trusted_internal_hosts_set,
    )

    # Auth real (Fase 1): none/api_key/bearer/basic. El secreto se descifra acá,
    # nunca vive en claro fuera de este borde. auth_type='none'/'stub' → sin cambios.
    from services.connector_secrets import build_auth, open_secret
    auth_kwargs = build_auth(
        binding.auth_type,
        getattr(binding, "auth_config", {}) or {},
        open_secret(getattr(binding, "auth_secret_enc", None)),
    )

    timeout = binding.timeout_ms / 1000
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.request(
            binding.http_method.upper(), url,
            params=query or None,
            headers=auth_kwargs["headers"] or None,
            auth=auth_kwargs["auth"],
        )
        resp.raise_for_status()
        return resp.json()


async def validate_second_factor(binding, identity: str, code: str) -> dict:
    """Valida el 2º factor (DNI/CUIT + código) contra el conector.

    stub → in-process; conector real → HTTP GET {base_url}/afiliados/{identity}/validar.
    Devuelve {'ok': bool, 'nombre'?: str, 'reason'?: str}. Fail-closed: cualquier
    error upstream → ok=False, reason='upstream' (no se autentica ante la duda).
    """
    if settings.nexa_stub_enabled and binding.auth_type == "stub":
        from services.nexa_stub import validar_totp
        return validar_totp(identity, code)

    # Convención afiliado (Fase 2 la hará config-driven vía columna auth_validate_path).
    url = binding.base_url.rstrip("/") + f"/afiliados/{identity}/validar"
    allow_http = settings.environment == "development"
    try:
        assert_egress_allowed(
            url, binding.egress_allow, allow_http=allow_http,
            trusted_internal_hosts=settings.trusted_internal_hosts_set,
        )
        async with httpx.AsyncClient(timeout=binding.timeout_ms / 1000) as client:
            resp = await client.get(url, params={"codigo": code})
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:
        logger.warning("second_factor_upstream_error connector=%s error=%s",
                       binding.connector_slug, exc)
        return {"ok": False, "reason": "upstream"}


async def execute_tool(binding, identity: str, params: dict | None = None) -> ExecResult:
    """Ejecuta la tool y devuelve el resultado normalizado al contrato canónico.

    identity: SIEMPRE viene de la sesión autenticada (server-side).
    """
    start = time.monotonic()
    tool_slug = binding.tool_slug

    # 1) Validar params (lo que el LLM decide). identity NUNCA está acá.
    try:
        clean_params = validate_params(params or {}, binding.params_schema)
    except ParamValidationError as exc:
        logger.info("tool_param_invalid tool=%s error=%s", tool_slug, exc)
        return ExecResult(outcome=UPSTREAM_ERROR, tool_slug=tool_slug,
                          detail={"error": "param_invalid", "msg": str(exc)},
                          latency_ms=int((time.monotonic() - start) * 1000))

    # 2) Armar path + query.
    path, query = _build_path(binding.path_template, identity, clean_params)

    # 3) Circuit breaker.
    if _circuit_is_open():
        logger.warning("tool_circuit_open tool=%s", tool_slug)
        return ExecResult(outcome=UPSTREAM_ERROR, tool_slug=tool_slug,
                          detail={"error": "circuit_open"},
                          latency_ms=int((time.monotonic() - start) * 1000))

    # 4) Invocar (stub in-process en dev, o httpx real).
    is_stub = settings.nexa_stub_enabled and binding.auth_type == "stub"
    try:
        async with asyncio.timeout(binding.timeout_ms / 1000 + 1):
            if is_stub:
                raw = await _invoke_stub(binding, identity, query)
            else:
                raw = await _invoke_http(binding, path, query)
        _reset_circuit()
    except EgressBlocked as exc:
        # No cuenta para el breaker: es un rechazo de política, no un fallo upstream.
        logger.warning("tool_egress_blocked tool=%s error=%s", tool_slug, exc)
        return ExecResult(outcome=UPSTREAM_ERROR, tool_slug=tool_slug,
                          detail={"error": "egress_blocked"},
                          latency_ms=int((time.monotonic() - start) * 1000))
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        _record_failure() if code >= 500 else None
        # 401/403 del upstream → el usuario necesita (re)autenticar o no tiene permiso.
        outcome = AUTH_REQUIRED if code == 401 else FORBIDDEN if code == 403 else UPSTREAM_ERROR
        return ExecResult(outcome=outcome, tool_slug=tool_slug,
                          detail={"error": f"http_{code}"},
                          latency_ms=int((time.monotonic() - start) * 1000))
    except (asyncio.TimeoutError, httpx.HTTPError, ConnectorCircuitOpen, Exception) as exc:
        _record_failure()
        logger.warning("tool_upstream_error tool=%s error=%s", tool_slug, exc)
        return ExecResult(outcome=UPSTREAM_ERROR, tool_slug=tool_slug,
                          detail={"error": "upstream"},
                          latency_ms=int((time.monotonic() - start) * 1000))

    # 5) Normalizar al contrato canónico.
    result = _apply_response_map(raw, binding.response_map)
    result.tool_slug = tool_slug
    result.latency_ms = int((time.monotonic() - start) * 1000)
    return result
