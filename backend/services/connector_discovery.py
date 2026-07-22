"""Conexión automática: descubre las rutas del proveedor, la IA las clasifica,
las prueba en vivo y propone la config completa de tools.

Pipeline (docs/PANTALLA_CONECTORES_PLAN.md → wizard):
  1. fetch_spec()      — busca el catálogo OpenAPI del proveedor (con su credencial).
  2. parse_openapi()   — extrae rutas GET con sus parámetros (tipos/enums del spec).
  3. classify_routes() — el LLM decide: personal/pública, {identity}, perfil para
                         OTP, intención + frases de ejemplo, descartes (health/validar).
  4. dry_run()         — prueba cada ruta candidata contra el proveedor real y
                         sugiere el response_map desde la respuesta.
  5. build_proposal()  — arma todo para que el admin revise y confirme en 1 clic.

Segunda puerta de entrada al MISMO pipeline: cuando el proveedor no publica
OpenAPI, el admin sube su documentación como archivo (PDF/Word/TXT/JSON) y
routes_from_document() extrae las rutas con el LLM. Desde ahí el flujo
(clasificar → probar → proponer) es idéntico — ver propose_from_routes().

Nada se crea ni activa acá: este módulo solo PROPONE. La creación la hace el
endpoint /apply con confirmación explícita del admin (fail-closed intacto).
"""

from __future__ import annotations

import json
import logging
import re
import time

import httpx

from core.config import settings
from core.egress_guard import EgressBlocked, assert_egress_allowed
from services.connector_secrets import build_auth, open_secret

logger = logging.getLogger(__name__)

# Rutas típicas donde los frameworks publican su catálogo.
SPEC_PATHS = ["/openapi.json", "/swagger.json", "/api-docs", "/v3/api-docs", "/swagger/v1/swagger.json"]


# ── 1. Descubrir el catálogo ───────────────────────────────────────────────────

async def fetch_spec(connector: dict, secret_enc: str | None) -> tuple[dict | None, str | None]:
    """Prueba las rutas conocidas del catálogo. Devuelve (spec, url) o (None, None).
    Envía la credencial del conector: muchos proveedores protegen también el spec."""
    auth_kwargs = build_auth(connector["auth_type"], connector.get("auth_config") or {},
                             open_secret(secret_enc))
    allow_http = settings.environment == "development"
    async with httpx.AsyncClient(timeout=connector["timeout_ms"] / 1000) as client:
        for path in SPEC_PATHS:
            url = connector["base_url"].rstrip("/") + path
            try:
                assert_egress_allowed(url, connector["egress_allow"], allow_http=allow_http,
                                      trusted_internal_hosts=settings.trusted_internal_hosts_set)
                resp = await client.get(url, headers=auth_kwargs["headers"] or None,
                                        auth=auth_kwargs["auth"])
                if resp.status_code == 200 and "json" in (resp.headers.get("content-type") or ""):
                    spec = resp.json()
                    if isinstance(spec, dict) and ("paths" in spec):
                        return spec, url
            except (EgressBlocked, httpx.HTTPError, ValueError) as exc:
                logger.debug("spec_probe_miss url=%s err=%s", url, exc)
    return None, None


# ── 2. Parsear rutas GET del OpenAPI ───────────────────────────────────────────

def parse_openapi(spec: dict) -> list[dict]:
    """[{path, method, params:[{name, in, required, type, enum}], summary}] — solo GET
    (Fase 1 es read-only)."""
    routes: list[dict] = []
    for path, methods in (spec.get("paths") or {}).items():
        op = (methods or {}).get("get")
        if not isinstance(op, dict):
            continue
        params = []
        for p in op.get("parameters", []):
            schema = p.get("schema") or {}
            # FastAPI 3.1 usa anyOf a veces; tomamos el primer tipo con enum si hay.
            if "anyOf" in schema:
                for cand in schema["anyOf"]:
                    if cand.get("enum") or cand.get("type"):
                        schema = cand
                        break
            params.append({
                "name": p.get("name"), "in": p.get("in", "query"),
                "required": bool(p.get("required")),
                "type": schema.get("type", "string"),
                "enum": schema.get("enum"),
            })
        routes.append({
            "path": path, "method": "GET", "params": params,
            "summary": op.get("summary") or op.get("description") or "",
        })
    return routes


# ── 3. Clasificación con IA ────────────────────────────────────────────────────

_CLASSIFY_SYSTEM = """Sos el asistente de configuración de conectores de una plataforma de chatbots
para organizaciones de cualquier rubro. Te paso las rutas GET del API de un proveedor
y devolvés SOLO un JSON array (sin markdown, sin explicación) con un objeto por ruta:

{
 "path": "<la ruta tal cual te la pasé>",
 "include": true|false,          // false para infraestructura (health/metrics/docs) y rutas de
                                 // validación de códigos/OTP (la plataforma valida por su cuenta)
 "discard_reason": "...",        // solo si include=false, en español, corto
 "slug": "snake_case_corto",
 "display_name": "Nombre humano en español",
 "identity_kind": "publico"|"personal",  // "personal" si la ruta expone datos de UNA persona
                                 // identificada por un documento/identificador en el path
                                 // (DNI, legajo, nº de cliente, nº de socio, etc.)
 "identity_param": "dni"|"id_cliente"|null,  // NOMBRE EXACTO del parámetro del path que identifica
                                 // a la persona, tal cual figura en el API (se reemplaza por la
                                 // identidad de la sesión, NUNCA la elige el bot)
 "is_lookup": true|false,        // true SOLO para la ruta que devuelve el perfil/datos de
                                 // contacto de la persona (sirve para enviar el código OTP)
 "sample_params": {"param": "valor"}  // valores de prueba realistas para probar la ruta
                                 // (para el param de identidad usá "IDENTITY" literal)
}
Reglas: rutas que muestran listados o catálogos generales (productos, sucursales, servicios,
horarios) son "publico". Rutas con el documento/identificador de una persona en el path son
"personal". La ruta de perfil de la persona (datos de contacto) marcala is_lookup=true e include=true.
IMPORTANTE: que una ruta devuelva información sensible o privada de la persona (facturación, cuenta,
saldos, historial) NO es motivo de descarte — es el caso de uso central: incluila con
identity_kind="personal" (la plataforma la protege con login + código de verificación).
Descartá ÚNICAMENTE infraestructura (health/metrics/docs) y validación de códigos/OTP."""


def _parse_llm_json_array(raw: str) -> list[dict]:
    """Parseo defensivo del output del LLM: puede envolver en ```json ... ```."""
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end == -1:
        raise ValueError(f"LLM no devolvió un JSON array: {raw[:200]}")
    return json.loads(text[start:end + 1])


async def _tenant_context(tenant_id: str) -> str:
    """Contexto del tenant (nombre + descripción/alcance del bot) para que el LLM
    de discovery entienda el rubro SIN hardcodear ninguno — así una concesionaria,
    un súper o una mutual clasifican bien sus propias rutas. Best-effort: si no hay
    config, devuelve '' y el prompt queda genérico. public.tenants es global, se
    consulta con prefijo de schema (no depende del search_path del tenant)."""
    try:
        from core.database import get_pg_session
        from sqlalchemy import text
        async with get_pg_session(tenant_id) as session:
            row = (await session.execute(
                text("SELECT name, bot_description, bot_scope FROM public.tenants WHERE id = :tid"),
                {"tid": tenant_id},
            )).mappings().first()
    except Exception as exc:
        logger.warning("tenant_context_failed tenant=%s error=%s", tenant_id, exc)
        return ""
    if not row:
        return ""
    parts = []
    if row["name"]:
        parts.append(f"Organización: {row['name']}.")
    if row["bot_description"]:
        parts.append(f"Qué hace su asistente: {str(row['bot_description'])[:600]}")
    if row["bot_scope"]:
        parts.append(f"Alcance/temas: {str(row['bot_scope'])[:400]}")
    if not parts:
        return ""
    return ("\n\nContexto de esta organización (usalo para elegir nombres claros y para decidir "
            "qué rutas exponen datos personales):\n" + " ".join(parts))


async def classify_routes(routes: list[dict], tenant_id: str) -> list[dict]:
    from services.groq_client import complete
    payload = json.dumps(routes, ensure_ascii=False)
    raw = await complete(
        [{"role": "system", "content": _CLASSIFY_SYSTEM + await _tenant_context(tenant_id)},
         {"role": "user", "content": f"Rutas del proveedor:\n{payload}"}],
        temperature=0.1, max_tokens=8000, tenant_id=tenant_id, timeout_s=120,
    )
    return _parse_llm_json_array(raw)


# ── 3b. Extracción de rutas desde documentación subida (PDF/Word/TXT/JSON) ─────

# Techo de texto que le pasamos al LLM. La doc de un API cabe holgada; si el
# admin sube un manual gigante, el excedente casi seguro no describe rutas.
_MAX_DOC_CHARS = 30_000

_EXTRACT_ROUTES_SYSTEM = """Sos un parser de documentación de APIs. Te paso el texto de la
documentación que un proveedor le entregó a su cliente (puede venir de un PDF, Word, TXT o JSON,
con formato sucio) y devolvés SOLO un JSON array (sin markdown, sin explicación) con las rutas
HTTP que describe, un objeto por ruta:

{
 "path": "/ruta/tal/cual/{param}",   // path con sus parámetros entre llaves, sin el host
 "method": "GET",
 "summary": "qué devuelve, en 1 línea en español",
 "params": [{"name": "dni", "in": "path"|"query", "required": true|false,
             "type": "string"|"integer"|"number"|"boolean", "enum": ["a","b"]|null}]
}

Reglas:
- SOLO rutas de LECTURA (GET). Ignorá POST/PUT/PATCH/DELETE salvo rutas de login/token, que
  también ignorás (la credencial ya está configurada en la plataforma).
- Si la doc muestra la URL completa (https://api.x.com/v1/clientes), quedate con el path (/v1/clientes).
- Parámetros entre llaves o marcados como :param en el path van con "in": "path" y required=true.
- No inventes rutas que el texto no menciona. Si no hay ninguna ruta, devolvé []."""


async def routes_from_document(doc_text: str, tenant_id: str) -> list[dict]:
    """Extrae rutas GET desde documentación en texto libre. Misma forma que parse_openapi()."""
    from services.groq_client import complete
    raw = await complete(
        [{"role": "system", "content": _EXTRACT_ROUTES_SYSTEM + await _tenant_context(tenant_id)},
         {"role": "user", "content": f"Documentación del API:\n{doc_text[:_MAX_DOC_CHARS]}"}],
        temperature=0.0, max_tokens=8000, tenant_id=tenant_id, timeout_s=120,
    )
    routes = _parse_llm_json_array(raw)
    # Normalizar a la forma de parse_openapi y filtrar basura del LLM.
    out: list[dict] = []
    for r in routes:
        path = (r.get("path") or "").strip()
        if not path.startswith("/") or (r.get("method") or "GET").upper() != "GET":
            continue
        params = []
        for p in r.get("params") or []:
            if not p.get("name"):
                continue
            params.append({
                "name": p["name"], "in": p.get("in", "query"),
                "required": bool(p.get("required")),
                "type": p.get("type") or "string",
                "enum": p.get("enum"),
            })
        out.append({"path": path, "method": "GET", "params": params,
                    "summary": r.get("summary") or ""})
    return out


# ── 4. Dry-run + sugerencia de response_map ───────────────────────────────────

def suggest_response_map(raw) -> dict:
    suggestion: dict = {}
    if isinstance(raw, dict):
        list_keys = [k for k, v in raw.items() if isinstance(v, list)]
        if len(list_keys) == 1:
            suggestion["items_path"] = list_keys[0]
            suggestion["empty_when_empty"] = True
        for k, v in raw.items():
            if isinstance(v, bool) and k.lower() in ("encontrado", "found", "exists", "ok", "existe"):
                suggestion["not_found_field"] = k
                suggestion["not_found_value"] = False
                break
    return suggestion


async def dry_run(connector: dict, secret_enc: str | None, path_template: str,
                  query_params: dict, identity: str) -> dict:
    """GET real contra el proveedor con la credencial. Devuelve {ok, status, latency_ms,
    raw?, suggested_response_map?} — mismo espíritu que el botón Probar."""
    path = path_template.replace("{identity}", identity)
    url = connector["base_url"].rstrip("/") + path
    allow_http = settings.environment == "development"
    out: dict = {"url": url}
    try:
        assert_egress_allowed(url, connector["egress_allow"], allow_http=allow_http,
                              trusted_internal_hosts=settings.trusted_internal_hosts_set)
        auth_kwargs = build_auth(connector["auth_type"], connector.get("auth_config") or {},
                                 open_secret(secret_enc))
        start = time.monotonic()
        async with httpx.AsyncClient(timeout=connector["timeout_ms"] / 1000) as client:
            resp = await client.get(url, params=query_params or None,
                                    headers=auth_kwargs["headers"] or None, auth=auth_kwargs["auth"])
        out["latency_ms"] = int((time.monotonic() - start) * 1000)
        out["status"] = resp.status_code
        out["ok"] = resp.status_code < 400
        if out["ok"] and "json" in (resp.headers.get("content-type") or ""):
            raw = resp.json()
            out["suggested_response_map"] = suggest_response_map(raw)
    except (EgressBlocked, httpx.HTTPError, ValueError) as exc:
        out.update(ok=False, error=str(exc)[:200])
    return out


# ── 5. Armar la propuesta completa ─────────────────────────────────────────────

def _build_tool_fields(route: dict, cls: dict) -> tuple[str, dict]:
    """(path_template, params_schema) — sustituye el param de identidad por {identity}
    y arma el JSON Schema de los params restantes usando tipos/enums del spec."""
    path_template = route["path"]
    identity_param = cls.get("identity_param")
    props: dict = {}
    required: list[str] = []
    for p in route["params"]:
        if identity_param and p["name"] == identity_param:
            path_template = path_template.replace("{" + p["name"] + "}", "{identity}")
            continue
        spec_prop: dict = {"type": p.get("type") or "string"}
        if p.get("enum"):
            spec_prop["enum"] = p["enum"]
        props[p["name"]] = spec_prop
        if p.get("required"):
            required.append(p["name"])
    schema = {"type": "object", "properties": props}
    if required:
        schema["required"] = required
    if not props:
        schema = {}
    return path_template, schema


async def build_proposal(connector: dict, secret_enc: str | None, tenant_id: str,
                         test_identity: str) -> dict:
    spec, spec_url = await fetch_spec(connector, secret_enc)
    if spec is None:
        return {"spec_found": False, "routes": [],
                "hint": "No encontré un catálogo OpenAPI en las rutas conocidas. "
                        "Pedile al proveedor la URL de su spec, subí su documentación "
                        "como archivo, o cargá las rutas a mano."}
    return await propose_from_routes(connector, secret_enc, tenant_id, test_identity,
                                     parse_openapi(spec), spec_url)


async def propose_from_routes(connector: dict, secret_enc: str | None, tenant_id: str,
                              test_identity: str, routes: list[dict],
                              source: str | None) -> dict:
    """Tramo común del wizard: clasifica con IA, prueba en vivo y arma la propuesta.
    `routes` puede venir del OpenAPI en vivo o de la documentación subida."""
    classified = await classify_routes(routes, tenant_id)
    by_path = {r["path"]: r for r in routes}

    proposal: list[dict] = []
    for cls in classified:
        route = by_path.get(cls.get("path"))
        if route is None:
            continue
        # Fallbacks para descartadas: el LLM puede omitir slug/nombre en ellas,
        # pero la UI permite re-incluirlas → siempre tienen que venir completas.
        fallback_slug = re.sub(r"[^a-z0-9]+", "_", cls["path"].lower()).strip("_")
        item = {
            "path": cls["path"],
            "include": bool(cls.get("include")),
            "discard_reason": cls.get("discard_reason"),
            "slug": cls.get("slug") or fallback_slug,
            "display_name": cls.get("display_name") or cls["path"],
            "http_method": "GET",
            "identity_kind": cls.get("identity_kind") or "publico",
            "identity_param": cls.get("identity_param"),
            "is_lookup": bool(cls.get("is_lookup")),
        }
        # La config del tool se arma SIEMPRE (también en descartadas, para que el
        # admin pueda corregir a la IA y re-incluirlas). El dry-run solo corre en
        # las incluidas — no gastamos llamadas al proveedor en descartes.
        path_template, params_schema = _build_tool_fields(route, cls)
        item["path_template"] = path_template
        item["params_schema"] = params_schema
        item["response_map"] = {}
        # Probar en vivo solo lo que se puede sin un dato de prueba: las rutas que
        # necesitan identidad ({identity} en el path) sin test_identity quedan "sin
        # probar" (item["test"]=None) — se prueban después por operación. Así no
        # pedimos un dato antes de tiempo ni mostramos "Revisar" engañoso.
        needs_identity = "{identity}" in path_template
        if item["include"] and not (needs_identity and not test_identity):
            sample = dict(cls.get("sample_params") or {})
            sample.pop(cls.get("identity_param") or "", None)
            query = {k: v for k, v in sample.items()
                     if k in (params_schema.get("properties") or {})}
            test = await dry_run(connector, secret_enc, path_template, query, test_identity)
            item["test"] = test
            item["response_map"] = test.get("suggested_response_map") or {}
        proposal.append(item)

    return {"spec_found": True, "spec_url": source, "routes": proposal}
