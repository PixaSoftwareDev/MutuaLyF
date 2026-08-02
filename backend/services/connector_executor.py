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
import re
import time
from dataclasses import dataclass, field

import httpx

from urllib.parse import urlparse

from core.config import settings
from core.egress_guard import EgressBlocked, EgressUnreachable, assert_egress_allowed

logger = logging.getLogger(__name__)


def _allow_http_for(url: str) -> bool:
    """¿Se permite HTTP plano para esta URL? True en dev, o en prod si el host
    está en la allowlist interina connector_http_allow_hosts (excepción INSEGURA
    para un tercero sin HTTPS todavía). Fuera de eso, el egress_guard exige https.
    """
    if settings.environment == "development":
        return True
    host = (urlparse(url).hostname or "").lower()
    return host in settings.http_allow_hosts_set

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


# ── Circuit breaker por-proceso ───────────────────────────────────────────────
class ConnectorCircuitOpen(Exception):
    """El circuit breaker del executor está abierto (fallos recientes)."""


# Breaker POR CONECTOR (clave tenant:connector_id). Antes era estado global del
# módulo: un solo conector con el upstream roto (visto 2026-07-22: cert SSL
# inválido) abría el circuito para TODAS las tools de TODOS los tenants del
# worker. El estado sigue siendo per-proceso (cada worker uvicorn aprende solo),
# aceptable: el costo de un probe extra por worker es una llamada con timeout.
_CIRCUIT_THRESHOLD = 3
_CIRCUIT_HALF_OPEN_TTL = 30.0

_circuits: dict[str, dict] = {}


def _circuit_key(binding) -> str:
    return f"{getattr(binding, 'tenant_id', '')}:{getattr(binding, 'connector_id', '') or binding.connector_slug}"


def _record_failure(key: str) -> None:
    st = _circuits.setdefault(key, {"failures": 0, "opened_at": None})
    st["failures"] += 1
    if st["failures"] >= _CIRCUIT_THRESHOLD and st["opened_at"] is None:
        st["opened_at"] = time.monotonic()
        logger.error("connector_circuit_opened connector=%s retry_after=%.0fs",
                     key, _CIRCUIT_HALF_OPEN_TTL)


def _reset_circuit(key: str) -> None:
    _circuits.pop(key, None)


def _circuit_is_open(key: str) -> bool:
    st = _circuits.get(key)
    if st is None or st["failures"] < _CIRCUIT_THRESHOLD:
        return False
    if st["opened_at"] is not None and (time.monotonic() - st["opened_at"]) >= _CIRCUIT_HALF_OPEN_TTL:
        st["failures"] = _CIRCUIT_THRESHOLD - 1  # deja pasar una prueba (half-open)
        st["opened_at"] = None
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


def apply_param_defaults(params: dict, schema: dict) -> dict:
    """Completa los params que el schema declara con 'default'.

    Son las constantes técnicas del proveedor (qué variables pedir, formato,
    versión, tamaño de página): no las decide el modelo — si tuviera que
    adivinarlas, cualquier omisión devuelve una respuesta vacía y el bot dice
    "no encontré" con la API andando. El default lo fija el admin al configurar
    la operación y viaja siempre; lo que el modelo mandó explícitamente gana.
    """
    props = (schema or {}).get("properties") or {}
    out = dict(params or {})
    for name, spec in props.items():
        if not isinstance(spec, dict):
            continue
        if out.get(name) is None and spec.get("default") is not None:
            out[name] = spec["default"]
    return out


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


def join_url(base_url: str, path: str) -> str:
    """Une base + ruta tolerando el prefijo duplicado: la doc del proveedor trae
    las rutas con el prefijo (/3, /v2, /crmpixs/api) que el admin ya puso en la
    URL base. Se dedupe el SOLAPAMIENTO MÁXIMO entre el final del path de la
    base y el principio de la ruta — prefijos de varios segmentos incluidos
    (base .../crmpixs/api + ruta /crmpixs/api/contacts → un solo /crmpixs/api).
    Solo toca el path; el host nunca entra en la comparación."""
    # Ruta absoluta: el proveedor reparte su API en varios subdominios
    # (api./geocoding-api./air-quality-api. de un mismo servicio). Se usa tal
    # cual — sin relajar nada: el host igual tiene que estar en egress_allow y
    # aprobado por el super-admin, que es donde vive la defensa.
    if re.match(r"^https?://", path, re.IGNORECASE):
        return path
    base = base_url.rstrip("/")
    path = "/" + path.lstrip("/")
    base_segs = [s for s in urlparse(base).path.strip("/").split("/") if s]
    path_segs = [s for s in path.strip("/").split("/") if s]
    # Del solapamiento más largo al más corto: el primero que coincide gana.
    for k in range(min(len(base_segs), len(path_segs)), 0, -1):
        if base_segs[-k:] == path_segs[:k]:
            path_segs = path_segs[k:]
            break
    return base + ("/" + "/".join(path_segs) if path_segs else "/")


def _apply_response_map(raw: dict | list, response_map: dict) -> ExecResult:
    """Normaliza la respuesta cruda al contrato canónico según response_map.

    Vocabulario soportado (chico y explícito, no JSONPath completo todavía):
      items_path:        clave (dotted) hacia la lista/dato de interés
      empty_when_empty:  si la lista está vacía → outcome=empty
      not_found_field / not_found_value: si raw[field]==value → forbidden
      total_path:        clave (dotted) hacia el total declarado por el
                         proveedor; si está, gana sobre la heurística de
                         nombres comunes (total/totalResults/has_more/...)
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
        if node is None:
            # items_path que no resuelve devolvía OK con data=None y el bot
            # respondía "esto es lo que encontré: null". Es un error de config,
            # no un resultado: decilo como error para que se pueda arreglar.
            logger.error("response_map_items_path_no_resuelve path=%s", items_path)
            return ExecResult(outcome=UPSTREAM_ERROR, data=None,
                              detail={"error": "items_path_invalido", "items_path": items_path})
        data = node

    if rm.get("empty_when_empty", True) and isinstance(data, (list, dict)) and len(data) == 0:
        return ExecResult(outcome=EMPTY, data=data)

    # ¿La respuesta es una PÁGINA de un conjunto más grande? Muchas APIs lo
    # declaran (total/count/total_results/has_more/next). Si lo hace y trajimos
    # menos de lo que dice, el turno NO puede contar ni totalizar: el modelo
    # sumaría sobre datos parciales y daría una cifra falsa con desglose y todo.
    detail: dict = {}
    if isinstance(raw, dict) and isinstance(data, list):
        total_path = rm.get("total_path")
        if total_path:
            # Config explícita del conector: es autoritativa. Si resuelve a un
            # entero, decide sola (== len → completo, > len → parcial) y la
            # heurística no corre. Si no resuelve, no es un error del turno
            # (el dato llegó igual): se loguea y cae a la heurística.
            node = raw
            for part in str(total_path).split("."):
                node = node.get(part) if isinstance(node, dict) else None
            if isinstance(node, int) and not isinstance(node, bool):
                if node > len(data):
                    detail = {"parcial": True, "traidos": len(data), "total_declarado": node}
                return ExecResult(outcome=OK, data=data, detail=detail)
            logger.warning("response_map_total_path_no_resuelve path=%s", total_path)
        for clave in ("total", "totalCount", "total_count", "total_results",
                      "totalResults", "count", "totalItems"):
            valor = raw.get(clave)
            if isinstance(valor, int) and valor > len(data):
                detail = {"parcial": True, "traidos": len(data), "total_declarado": valor}
                break
        if not detail:
            for clave in ("has_more", "hasMore", "next", "next_page", "nextCursor", "next_cursor"):
                if raw.get(clave):
                    detail = {"parcial": True, "traidos": len(data)}
                    break

    return ExecResult(outcome=OK, data=data, detail=detail)


async def _invoke_stub(binding, identity: str, query: dict) -> dict | list:
    from services.connector_stub import STUB_OPERATIONS
    op = STUB_OPERATIONS.get((binding.connector_slug, binding.tool_slug))
    if op is None:
        raise RuntimeError(f"stub sin operación para {binding.connector_slug}/{binding.tool_slug}")
    # Los stubs son síncronos y baratos; envolver por si en el futuro son async.
    result = op(identity, **query) if query else op(identity)
    return result


def _oauth_ctx(binding) -> dict:
    """Contexto mínimo que necesita connector_oauth para emitir/cachear tokens."""
    return {
        "connector_id": getattr(binding, "connector_id", "") or binding.connector_slug,
        "slug": binding.connector_slug,
        "egress_allow": binding.egress_allow,
        "timeout_ms": binding.timeout_ms,
    }


async def _binding_auth(binding) -> dict:
    # El secreto se descifra acá, nunca vive en claro fuera de este borde.
    # oauth2 → resolve_auth emite/renueva el token; resto → estático como siempre.
    from services.connector_secrets import open_secret, resolve_auth
    return await resolve_auth(
        binding.auth_type,
        getattr(binding, "auth_config", {}) or {},
        open_secret(getattr(binding, "auth_secret_enc", None)),
        oauth_ctx=_oauth_ctx(binding),
    )


class ResponseTooLarge(Exception):
    """El proveedor devolvió más de lo que estamos dispuestos a procesar."""


def _safe_err(exc: Exception) -> str:
    """Texto de una excepción apto para log.

    httpx mete la URL COMPLETA en el str() de sus errores, y nuestras URLs
    llevan el código OTP y la api key en el querystring (van como params
    justamente para que NO aparezcan en logs). Un 401 del proveedor escribía
    los dos en texto plano. Para errores de httpx logueamos tipo y estado.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        return f"{type(exc).__name__}: HTTP {exc.response.status_code}"
    if isinstance(exc, httpx.RequestError):
        host = exc.request.url.host if exc.request is not None else "?"
        return f"{type(exc).__name__} contra {host}"
    return f"{type(exc).__name__}: {str(exc)[:200]}"


def _parse_response(resp, binding):
    """Cuerpo de la respuesta → dict/list, con dos defensas que faltaban:

    1. TAMAÑO: sin tope, una API que devuelve decenas de MB se carga entera en
       memoria, bloquea el event loop al parsear (afecta a TODOS los tenants del
       worker) y terminaba volcada al navegador por el fallback de formato.
    2. CONTENT-TYPE: `resp.json()` a ciegas hacía que un proveedor XML/CSV/HTML
       fallara como "error del proveedor" y sumara al circuit breaker, sin que
       nadie supiera que el problema real era el formato.
    """
    limite = settings.connector_max_response_bytes
    declarado = resp.headers.get("content-length")
    if declarado and declarado.isdigit() and int(declarado) > limite:
        raise ResponseTooLarge(f"el proveedor declaró {int(declarado)} bytes (tope {limite})")
    if len(resp.content) > limite:
        raise ResponseTooLarge(f"el proveedor devolvió {len(resp.content)} bytes (tope {limite})")
    ctype = (resp.headers.get("content-type") or "").lower()
    try:
        return resp.json()
    except ValueError as exc:
        raise ValueError(
            f"el proveedor respondió {ctype or 'sin content-type'} y esperábamos JSON"
        ) from exc


async def _invoke_http(binding, path: str, query: dict) -> dict | list:
    url = join_url(binding.base_url, path)
    # Anti-SSRF: el host debe estar en la allowlist del conector y no resolver a
    # una IP interna. En prod exigimos https (salvo host en la allowlist HTTP
    # interina). En dev, hosts mock de confianza quedan exentos de la verif. de IP.
    allow_http = _allow_http_for(url)
    assert_egress_allowed(
        url, binding.egress_allow, allow_http=allow_http,
        trusted_internal_hosts=settings.trusted_internal_hosts_set,
    )

    auth_kwargs = await _binding_auth(binding)

    timeout = binding.timeout_ms / 1000
    async with httpx.AsyncClient(timeout=timeout) as client:
        for intento in (1, 2):
            # La clave por query (auth_kwargs['params']) se mergea acá y no en la
            # URL: así nunca aparece en logs, auditoría ni mensajes de error.
            send_params = {**(query or {}), **auth_kwargs["params"]} or None
            resp = await client.request(
                binding.http_method.upper(), url,
                params=send_params,
                headers=auth_kwargs["headers"] or None,
                auth=auth_kwargs["auth"],
            )
            # Retry-once: el proveedor puede revocar un token oauth2 antes de su
            # vencimiento. UNA re-emisión y reintento; si el 401 persiste es un
            # problema de permisos/credencial, no de frescura.
            if resp.status_code == 401 and binding.auth_type == "oauth2" and intento == 1:
                from services.connector_oauth import invalidate
                await invalidate(_oauth_ctx(binding)["connector_id"])
                auth_kwargs = await _binding_auth(binding)
                continue
            resp.raise_for_status()
            return _parse_response(resp, binding)


async def validate_second_factor(binding, identity: str, code: str) -> dict:
    """Valida el 2º factor (identificador + código) contra el conector.

    stub → in-process; conector real → HTTP GET a la ruta de validación del
    proveedor. La ruta es config-driven vía `connector.auth_validate_path`
    (ej. '/clientes/{identity}/validar'); si no está seteada se usa la
    convención histórica '/afiliados/{identity}/validar' (compat).
    Devuelve {'ok': bool, 'nombre'?: str, 'reason'?: str}. Fail-closed: cualquier
    error upstream → ok=False, reason='upstream' (no se autentica ante la duda).
    """
    if settings.connector_stub_enabled and binding.auth_type == "stub":
        from services.connector_stub import validar_totp
        return validar_totp(identity, code)

    tmpl = (getattr(binding, "auth_validate_path", None) or "/afiliados/{identity}/validar")
    if not tmpl.startswith("/"):
        tmpl = "/" + tmpl
    url = join_url(binding.base_url, tmpl.replace("{identity}", identity))
    allow_http = _allow_http_for(url)
    try:
        assert_egress_allowed(
            url, binding.egress_allow, allow_http=allow_http,
            trusted_internal_hosts=settings.trusted_internal_hosts_set,
        )
        auth_kwargs = await _binding_auth(binding)
        async with httpx.AsyncClient(timeout=binding.timeout_ms / 1000) as client:
            resp = await client.get(url, params={"codigo": code, **auth_kwargs["params"]},
                                    headers=auth_kwargs["headers"] or None, auth=auth_kwargs["auth"])
            resp.raise_for_status()
            return _parse_response(resp, binding)
    except Exception as exc:
        logger.warning("second_factor_upstream_error connector=%s error=%s",
                       binding.connector_slug, _safe_err(exc))
        return {"ok": False, "reason": "upstream"}


async def lookup_identity(binding, identity: str, cfg: dict | None = None) -> tuple[dict | None, str]:
    """Busca el perfil de la persona en el proveedor (datos de contacto para el
    OTP propio). GET {base_url}{identity_lookup_path}.

    Devuelve (perfil, motivo):
      - (dict, 'ok')         → encontrado.
      - (None, 'not_found')  → el proveedor respondió y la persona NO existe
                               (404, o found_field en falso). Se le puede decir
                               al usuario que ese identificador no figura.
      - (None, 'upstream')   → no pudimos preguntar (caído/timeout/config). NO
                               afirmar que no existe: fail-closed sin código.

    cfg (de connector.auth_config): identity_lookup_path (config-driven; default
    de compat '/afiliados/{identity}'), found_field (default 'encontrado').
    """
    cfg = cfg or {}
    path = (cfg.get("identity_lookup_path") or "/afiliados/{identity}").replace("{identity}", identity)
    url = join_url(binding.base_url, path)
    allow_http = _allow_http_for(url)
    try:
        assert_egress_allowed(
            url, binding.egress_allow, allow_http=allow_http,
            trusted_internal_hosts=settings.trusted_internal_hosts_set,
        )
        auth_kwargs = await _binding_auth(binding)
        async with httpx.AsyncClient(timeout=binding.timeout_ms / 1000) as client:
            resp = await client.get(url, params=auth_kwargs["params"] or None,
                                    headers=auth_kwargs["headers"] or None, auth=auth_kwargs["auth"])
            if resp.status_code == 404:
                return None, "not_found"
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        logger.warning("identity_lookup_failed connector=%s error=%s", binding.connector_slug, _safe_err(exc))
        return None, "upstream"
    found_field = cfg.get("found_field", "encontrado")
    if isinstance(data, dict) and found_field in data and not data.get(found_field):
        return None, "not_found"
    if not isinstance(data, dict):
        return None, "not_found"
    return data, "ok"


async def execute_tool(binding, identity: str, params: dict | None = None) -> ExecResult:
    """Ejecuta la tool y devuelve el resultado normalizado al contrato canónico.

    identity: SIEMPRE viene de la sesión autenticada (server-side).
    """
    start = time.monotonic()
    tool_slug = binding.tool_slug

    # 1) Validar params (lo que el LLM decide) y completar los defaults de la
    #    config (constantes técnicas del proveedor). identity NUNCA está acá.
    try:
        clean_params = validate_params(params or {}, binding.params_schema)
        clean_params = apply_param_defaults(clean_params, binding.params_schema)
    except ParamValidationError as exc:
        logger.info("tool_param_invalid tool=%s error=%s", tool_slug, exc)
        return ExecResult(outcome=UPSTREAM_ERROR, tool_slug=tool_slug,
                          detail={"error": "param_invalid", "msg": str(exc)},
                          latency_ms=int((time.monotonic() - start) * 1000))

    # 2) Armar path + query.
    path, query = _build_path(binding.path_template, identity, clean_params)

    # Identidad que el proveedor espera como QUERY param (?dni=...): se inyecta
    # ACÁ, server-side, igual que {identity} en el path — nunca desde el schema
    # visible al LLM ni desde el texto del usuario. Sin esto la tool sale sin
    # filtro y devuelve los datos de todas las personas.
    iqp = (binding.params_schema or {}).get("x-identity-query-param")
    if iqp:
        if binding.identity_kind != "publico" and not identity:
            logger.error("tool_identity_missing tool=%s — se rechaza por seguridad", tool_slug)
            return ExecResult(outcome=FORBIDDEN, tool_slug=tool_slug,
                              detail={"error": "identity_required"},
                              latency_ms=int((time.monotonic() - start) * 1000))
        query[iqp] = identity

    # 2b) Fase 1 es SOLO LECTURA y esto lo hace cierto, no accidental.
    #     is_read_only existía en la base y no lo miraba nadie: una tool creada a
    #     mano con DELETE /clientes/{id} quedaba en el catálogo del LLM y era
    #     ejecutable por decisión del modelo, sin confirmación humana. El circuito
    #     de aprobación del super-admin autoriza HOSTS, no métodos.
    metodo = (binding.http_method or "GET").upper()
    if metodo != "GET" or getattr(binding, "is_read_only", True) is False:
        logger.error("tool_write_blocked tool=%s metodo=%s — escrituras deshabilitadas",
                     tool_slug, metodo)
        return ExecResult(outcome=FORBIDDEN, tool_slug=tool_slug,
                          detail={"error": "write_not_allowed"},
                          latency_ms=int((time.monotonic() - start) * 1000))

    # 3) Circuit breaker (por conector).
    ckey = _circuit_key(binding)
    if _circuit_is_open(ckey):
        logger.warning("tool_circuit_open tool=%s connector=%s", tool_slug, binding.connector_slug)
        return ExecResult(outcome=UPSTREAM_ERROR, tool_slug=tool_slug,
                          detail={"error": "circuit_open"},
                          latency_ms=int((time.monotonic() - start) * 1000))

    # 4) Invocar (stub in-process en dev, o httpx real).
    is_stub = settings.connector_stub_enabled and binding.auth_type == "stub"
    try:
        async with asyncio.timeout(binding.timeout_ms / 1000 + 1):
            if is_stub:
                raw = await _invoke_stub(binding, identity, query)
            else:
                raw = await _invoke_http(binding, path, query)
        _reset_circuit(ckey)
    except EgressBlocked as exc:
        # No cuenta para el breaker: es un rechazo de política, no un fallo upstream.
        logger.warning("tool_egress_blocked tool=%s error=%s", tool_slug, exc)
        return ExecResult(outcome=UPSTREAM_ERROR, tool_slug=tool_slug,
                          detail={"error": "egress_blocked"},
                          latency_ms=int((time.monotonic() - start) * 1000))
    except EgressUnreachable as exc:
        # El host está permitido pero no resuelve: es el proveedor el que está
        # caído. SÍ cuenta para el breaker — si no, cada consulta de cada
        # usuario paga una resolución DNS contra un dominio muerto.
        _record_failure(ckey)
        logger.warning("tool_upstream_unreachable tool=%s error=%s", tool_slug, exc)
        return ExecResult(outcome=UPSTREAM_ERROR, tool_slug=tool_slug,
                          detail={"error": "unreachable"},
                          latency_ms=int((time.monotonic() - start) * 1000))
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        _record_failure(ckey) if code >= 500 else None
        # 401/403 del upstream → el usuario necesita (re)autenticar o no tiene permiso.
        outcome = AUTH_REQUIRED if code == 401 else FORBIDDEN if code == 403 else UPSTREAM_ERROR
        return ExecResult(outcome=outcome, tool_slug=tool_slug,
                          detail={"error": f"http_{code}"},
                          latency_ms=int((time.monotonic() - start) * 1000))
    except ResponseTooLarge as exc:
        # El proveedor CONTESTÓ: es config (nuestra o suya) lo que hay que
        # corregir, no una caída — no ensucia el circuit breaker.
        logger.error("tool_response_too_large tool=%s error=%s", tool_slug, exc)
        return ExecResult(outcome=UPSTREAM_ERROR, tool_slug=tool_slug,
                          detail={"error": "response_too_large"},
                          latency_ms=int((time.monotonic() - start) * 1000))
    except (asyncio.TimeoutError, httpx.HTTPError, ConnectorCircuitOpen, Exception) as exc:
        _record_failure(ckey)
        logger.warning("tool_upstream_error tool=%s error=%s", tool_slug, _safe_err(exc))
        return ExecResult(outcome=UPSTREAM_ERROR, tool_slug=tool_slug,
                          detail={"error": "upstream"},
                          latency_ms=int((time.monotonic() - start) * 1000))

    # 5) Normalizar al contrato canónico.
    result = _apply_response_map(raw, binding.response_map)
    result.tool_slug = tool_slug
    result.latency_ms = int((time.monotonic() - start) * 1000)
    return result
