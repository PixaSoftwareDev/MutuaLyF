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
from services.connector_secrets import open_secret, resolve_auth


def _conn_oauth_ctx(connector: dict) -> dict:
    """Contexto para connector_oauth desde el dict del conector (panel/discovery)."""
    return {
        "connector_id": str(connector.get("id") or connector.get("slug") or ""),
        "slug": connector.get("slug"),
        "egress_allow": connector.get("egress_allow") or [],
        "timeout_ms": connector.get("timeout_ms") or 4000,
    }

logger = logging.getLogger(__name__)

# Rutas típicas donde los frameworks publican su catálogo.
SPEC_PATHS = ["/openapi.json", "/swagger.json", "/api-docs", "/v3/api-docs", "/swagger/v1/swagger.json"]


# ── 1. Descubrir el catálogo ───────────────────────────────────────────────────

async def fetch_spec(connector: dict, secret_enc: str | None) -> tuple[dict | None, str | None]:
    """Prueba las rutas conocidas del catálogo. Devuelve (spec, url) o (None, None).
    Envía la credencial del conector: muchos proveedores protegen también el spec."""
    auth_kwargs = await resolve_auth(connector["auth_type"], connector.get("auth_config") or {},
                                     open_secret(secret_enc), oauth_ctx=_conn_oauth_ctx(connector))
    allow_http = settings.environment == "development"
    async with httpx.AsyncClient(timeout=connector["timeout_ms"] / 1000) as client:
        for path in SPEC_PATHS:
            url = connector["base_url"].rstrip("/") + path
            try:
                assert_egress_allowed(url, connector["egress_allow"], allow_http=allow_http,
                                      trusted_internal_hosts=settings.trusted_internal_hosts_set)
                resp = await client.get(url, params=auth_kwargs["params"] or None,
                                        headers=auth_kwargs["headers"] or None,
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
            example = p.get("example", schema.get("example", schema.get("default")))
            params.append({
                "name": p.get("name"), "in": p.get("in", "query"),
                "required": bool(p.get("required")),
                "type": schema.get("type", "string"),
                "enum": schema.get("enum"),
                # Metadata para humanos y para el LLM: la descripción y el
                # ejemplo del spec alimentan el panel Probar y el tool schema.
                "description": (p.get("description") or schema.get("description") or "").strip() or None,
                "example": example,
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
 "description": "1-2 oraciones en español: qué devuelve exactamente y cuándo conviene usarla",
 "identity_kind": "publico"|"personal",  // "personal" si la ruta expone datos privados que
                                 // requieren que la persona se identifique antes de consultar
 "identity_param": "dni"|"legajo"|null,  // SOLO si un parámetro del path es el identificador de
                                 // la PERSONA que consulta (DNI, legajo, nº de cliente/socio —
                                 // algo que la persona tipea sobre sí misma). Se reemplaza por
                                 // la identidad de la sesión, NUNCA la elige el bot.
                                 // IMPORTANTE: un id genérico de RECURSO (el "id" de un
                                 // proyecto, pedido, documento, etc., que sale de una ruta de
                                 // listado) NO es identity_param — dejalo null; ese parámetro
                                 // queda como parámetro normal de la operación.
 "is_lookup": true|false,        // true SOLO para la ruta que devuelve el perfil/datos de
                                 // contacto de la persona (sirve para enviar el código OTP)
 "sample_params": {"param": "valor"},  // valores de prueba realistas para probar la ruta
                                 // (para el param de identidad usá "IDENTITY" literal)
 "params_doc": {"param": "..."}  // para CADA parámetro de la ruta (path y query): qué es y
                                 // qué formato espera, en 1 línea y SIEMPRE en español (si el
                                 // proveedor documentó en inglés, traducí; si no hay dato,
                                 // inferilo del nombre y el contexto de la ruta)
}
Reglas — identity_kind, la prueba de fuego: ¿la respuesta sería LA MISMA para cualquier
persona que consulte? → "publico". Marcá "personal" SOLO si la respuesta depende de QUIÉN
pregunta (sus datos, su cuenta, su historial) o si el dato es interno del negocio y exige
estar registrado para verlo. Catálogos, listados generales, contenido del mundo (productos,
sucursales, horarios, noticias, clima, películas, precios públicos) son SIEMPRE "publico" —
marcarlos "personal" obliga a la gente a loguearse para nada. Rutas con el documento/
identificador de una persona en el path son "personal". La ruta de perfil de la persona (datos de contacto) marcala is_lookup=true e include=true.
IMPORTANTE: que una ruta devuelva información sensible o privada de la persona (facturación, cuenta,
saldos, historial) NO es motivo de descarte — es el caso de uso central: incluila con
identity_kind="personal" (la plataforma la protege con login + código de verificación).
Descartá ÚNICAMENTE infraestructura (health/metrics/docs), validación de códigos/OTP y
rutas que exponen SECRETOS del sistema (credenciales, tokens, claves de API, contraseñas,
accesos — ej. /credentials, /secrets, /api-keys, /tokens). Estas últimas NUNCA deben ir a
un chatbot: un secreto filtrado compromete el sistema entero. Marcalas include=false con
discard_reason claro (ej. "expone credenciales — riesgo de seguridad").
Si la documentación la subió el admin, asumí que TODAS las rutas de NEGOCIO que lista son
usables: ante la MÍNIMA duda marcá include=true — el descarte es solo una sugerencia que el
admin ve y puede revertir, nunca elimina la ruta. La EXCEPCIÓN son las rutas de secretos de
arriba: esas van descartadas siempre, aunque el resto lo incluyas con criterio amplio."""


async def _registry_text(slug: str) -> str:
    """Prompt override-aware desde el registro (default = constantes de este módulo)."""
    from services.prompt_registry import get_text
    return await get_text(slug)


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
        [{"role": "system", "content": (await _registry_text("discovery_clasificador")) + await _tenant_context(tenant_id)},
         {"role": "user", "content": f"Rutas del proveedor:\n{payload}"}],
        # 60s y no más: una llamada normal tarda 7-25s; cuando el proveedor LLM se
        # cuelga, conviene cortar rápido y que el retry (que sí responde) resuelva.
        # Con 120s un solo cuelgue hacía que el cliente HTTP del admin cortara antes
        # de que el backend terminara — el admin veía un error genérico.
        temperature=0.1, max_tokens=8000, tenant_id=tenant_id, timeout_s=60,
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
             "type": "string"|"integer"|"number"|"boolean", "enum": ["a","b"]|null,
             "description": "qué es y qué formato espera, en español, 1 línea (si la doc lo dice)",
             "example": "valor de ejemplo SOLO si la doc muestra uno"|null}]
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
        [{"role": "system", "content": (await _registry_text("discovery_rutas")) + await _tenant_context(tenant_id)},
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
        # Normalizar ':id' (Express) → '{id}' acá, en el borde: todo lo aguas
        # abajo (clasificación, vínculo lista↔detalle, template) ve UNA forma.
        out.append({"path": _normalize_path_params(path), "method": "GET", "params": params,
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
    from services.connector_executor import join_url
    url = join_url(connector["base_url"], path)
    allow_http = settings.environment == "development"
    out: dict = {"url": url}
    try:
        assert_egress_allowed(url, connector["egress_allow"], allow_http=allow_http,
                              trusted_internal_hosts=settings.trusted_internal_hosts_set)
        auth_kwargs = await resolve_auth(connector["auth_type"], connector.get("auth_config") or {},
                                         open_secret(secret_enc), oauth_ctx=_conn_oauth_ctx(connector))
        start = time.monotonic()
        async with httpx.AsyncClient(timeout=connector["timeout_ms"] / 1000) as client:
            resp = await client.get(url, params={**(query_params or {}), **auth_kwargs["params"]} or None,
                                    headers=auth_kwargs["headers"] or None, auth=auth_kwargs["auth"])
        out["latency_ms"] = int((time.monotonic() - start) * 1000)
        out["status"] = resp.status_code
        out["ok"] = resp.status_code < 400
        if out["ok"] and "json" in (resp.headers.get("content-type") or ""):
            raw = resp.json()
            # raw es interno (para encadenar ids reales lista→detalle); se quita
            # antes de mandar la propuesta a la UI.
            out["raw"] = raw
            out["suggested_response_map"] = suggest_response_map(raw)
    except (EgressBlocked, httpx.HTTPError, ValueError) as exc:
        out.update(ok=False, error=str(exc)[:200])
    return out


# ── 5. Armar la propuesta completa ─────────────────────────────────────────────

_PATH_PARAM_RE = re.compile(r"\{(\w+)\}")
_EXPRESS_PARAM_RE = re.compile(r":(\w+)")


def _normalize_path_params(path: str) -> str:
    """Unifica estilos de parámetro de path: ':id' (Express) → '{id}'. Sin esto,
    una ruta documentada como /projects/:id quedaba con ':id' LITERAL en el
    template — la URL salía tal cual y el proveedor respondía 404."""
    return _EXPRESS_PARAM_RE.sub(r"{\1}", path)


# Nombres de parámetro que inequívocamente identifican a una PERSONA. Para estos
# se respeta siempre lo que dijo el LLM; la salvaguarda estructural solo pisa
# nombres genéricos (id, identity, uuid...) que los proveedores usan para recursos.
_PERSON_PARAM_RE = re.compile(r"dni|legajo|cuil|cuit|documento|socio|afiliado|matricula|member", re.I)


def _effective_identity_param(cls: dict, classified_by_path: dict[str, dict]) -> str | None:
    """Salvaguarda dura sobre identity_param (no confiar solo en el prompt).

    El LLM a veces marca el id de un RECURSO como identidad de la persona —
    típico cuando el proveedor llama '{identity}' o '{id}' a sus params de path
    (/documents/{identity}). Regla estructural: si la colección dueña del param
    (la ruta sin el tramo '/{param}') existe como ruta incluida, ese param es un
    id de recurso que sale de esa lista, NO la identidad de quien consulta.
    Sin esto, el param se traga del schema, el encadenado lista→detalle no corre
    y en runtime iría la identidad de la sesión donde va el id del recurso."""
    name = cls.get("identity_param")
    if not name:
        return None
    if cls.get("is_lookup"):
        return name  # la ruta de perfil resuelve a la persona por SU identidad
    path = _normalize_path_params(cls.get("path") or "")
    if "{" + name + "}" not in path:
        return name  # identidad por query param — la salvaguarda es solo de path
    if _PERSON_PARAM_RE.search(name):
        return name
    parent = path.split("/{" + name + "}")[0]
    sib = classified_by_path.get(parent)
    if sib and sib.get("include"):
        logger.info("identity_param_override path=%s param=%s lista=%s",
                    path, name, parent)
        return None
    return name


def _list_sibling(path: str, classified_by_path: dict[str, dict]) -> dict | None:
    """La lista dueña del id es lo que está ANTES del primer parámetro:
    /X/{id} → /X, y también /X/{id}/Y → /X (anidada: el id es de X, no de Y).
    Es el vínculo que le dice al LLM de dónde salen los ids."""
    m = re.match(r"^(.*?)/\{\w+\}", path)
    if not m:
        return None
    sib = classified_by_path.get(m.group(1))
    return sib if sib and sib.get("include") else None


def _build_tool_fields(route: dict, cls: dict,
                       classified_by_path: dict[str, dict] | None = None) -> tuple[str, dict]:
    """(path_template, params_schema) — sustituye el param de IDENTIDAD DE PERSONA
    por {identity}; los ids de RECURSO quedan como parámetros de path visibles al
    LLM (marcados x-resource-id, con la lista hermana referenciada en la
    descripción: de ahí salen los valores). El resto arma el JSON Schema con
    tipos/enums del spec."""
    path_template = _normalize_path_params(route["path"])
    identity_param = cls.get("identity_param")
    declared = {p["name"] for p in route["params"]}
    props: dict = {}
    required: list[str] = []

    # Params de path presentes en el template pero no declarados en el spec/doc
    # (pasa con docs informales): tratarlos como declarados-requeridos.
    params = list(route["params"])
    for name in _PATH_PARAM_RE.findall(path_template):
        if name not in declared:
            params.append({"name": name, "in": "path", "required": True, "type": "string"})

    for p in params:
        name = p["name"]
        if identity_param and name == identity_param:
            path_template = path_template.replace("{" + name + "}", "{identity}")
            continue
        spec_prop: dict = {"type": p.get("type") or "string"}
        if p.get("enum"):
            spec_prop["enum"] = p["enum"]
        if p.get("description"):
            spec_prop["description"] = p["description"]
        if p.get("example") is not None:
            spec_prop["x-example"] = p["example"]
        # Param de path que no es la identidad → id de recurso: el LLM lo completa
        # con un valor que salió de un resultado previo (lista hermana).
        # EXCEPCIÓN: si tiene enum es un SELECTOR (/trending/{media_type} con
        # movie|tv), no un id — se elige del enum o del pedido del usuario, no
        # requiere procedencia de una lista.
        is_path_param = p.get("in") == "path" or ("{" + name + "}") in path_template
        if is_path_param and not p.get("enum"):
            spec_prop["x-resource-id"] = True
            sib = _list_sibling(path_template, classified_by_path or {})
            origen = f" Obtené el valor de la operación '{sib['slug']}'." if sib and sib.get("slug") else \
                     " Obtené el valor de la operación de listado correspondiente."
            spec_prop["description"] = f"Identificador del recurso.{origen} Nunca lo inventes."
            # Sin ejemplo del spec: un id "de muestra" invita a inventar ids.
            spec_prop.pop("x-example", None)
        if is_path_param and not p.get("required"):
            p["required"] = True  # un placeholder del path siempre necesita valor
        props[name] = spec_prop
        if p.get("required"):
            required.append(name)
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


# Rutas que exponen secretos del sistema — NUNCA a un chatbot. Defensa en
# profundidad: aunque la IA (o un admin distraído) las incluya, el discovery las
# fuerza a descartadas. Un secreto filtrado compromete el sistema entero.
_SECRET_PATH_RE = re.compile(
    r"/(credentials?|secrets?|api[-_]?keys?|tokens?|passwords?|claves?|"
    r"credenciales?|contrasen|accesos?)(/|$|\?)", re.IGNORECASE)


def _is_secret_route(path: str) -> bool:
    return bool(_SECRET_PATH_RE.search(path or ""))


def _sample_query(cls: dict, params_schema: dict) -> dict:
    """Query params de muestra para el dry-run: solo los declarados en el schema,
    nunca el de identidad (ese lo maneja dry_run con test_identity). Los
    requeridos que la IA no cubrió caen al x-example del schema (spec/doc) —
    la IA es no-determinística y a veces omite un sample; sin este respaldo la
    ruta quedaba "sin probar" en la propuesta. Ids de recurso: 2ª pasada."""
    sample = dict(cls.get("sample_params") or {})
    props = params_schema.get("properties") or {}
    for name in (params_schema.get("required") or []):
        prop = props.get(name) or {}
        if name not in sample and not prop.get("x-resource-id") \
                and prop.get("x-example") is not None:
            sample[name] = prop["x-example"]
    sample.pop(cls.get("identity_param") or "", None)
    return {k: v for k, v in sample.items() if k in (params_schema.get("properties") or {})}


def _test_for_ui(test: dict) -> dict:
    """El raw es interno (encadenado de ids): no viaja en la propuesta a la UI."""
    return {k: v for k, v in test.items() if k != "raw"}


async def propose_from_routes(connector: dict, secret_enc: str | None, tenant_id: str,
                              test_identity: str, routes: list[dict],
                              source: str | None) -> dict:
    """Tramo común del wizard: clasifica con IA, prueba en vivo y arma la propuesta.
    `routes` puede venir del OpenAPI en vivo o de la documentación subida."""
    classified = await classify_routes(routes, tenant_id)
    by_path = {r["path"]: r for r in routes}
    # Clasificadas indexadas por path NORMALIZADO (para el vínculo lista↔detalle).
    classified_by_path = {
        _normalize_path_params(c.get("path") or ""): c for c in classified
    }
    # Salvaguarda estructural ANTES de armar nada: si el LLM confundió un id de
    # recurso con la identidad de la persona, acá se corrige para que el schema,
    # el sample y el item salgan consistentes.
    for cls in classified:
        cls["identity_param"] = _effective_identity_param(cls, classified_by_path)

    proposal: list[dict] = []
    # Detalles a probar en 2ª pasada (con id real de su lista) y listas ya
    # probadas (path_template → test con raw) para sacarles ese id.
    pending_detail: list[tuple[dict, dict, dict, list[str]]] = []
    probed_by_path: dict[str, dict] = {}
    for cls in classified:
        route = by_path.get(cls.get("path"))
        if route is None:
            continue
        # Fallbacks para descartadas: el LLM puede omitir slug/nombre en ellas,
        # pero la UI permite re-incluirlas → siempre tienen que venir completas.
        fallback_slug = re.sub(r"[^a-z0-9]+", "_", cls["path"].lower()).strip("_")
        # Salvaguarda dura: una ruta de secretos va descartada AUNQUE la IA la
        # haya incluido (defensa en profundidad, no confiar solo en el prompt).
        is_secret = _is_secret_route(cls["path"])
        item = {
            "path": cls["path"],
            "include": bool(cls.get("include")) and not is_secret,
            "discard_reason": ("Expone credenciales/secretos — nunca debe ir a un chatbot."
                               if is_secret else cls.get("discard_reason")),
            "slug": cls.get("slug") or fallback_slug,
            "display_name": cls.get("display_name") or cls["path"],
            "description": (cls.get("description") or "").strip() or None,
            "http_method": "GET",
            "identity_kind": cls.get("identity_kind") or "publico",
            "identity_param": cls.get("identity_param"),
            "is_lookup": bool(cls.get("is_lookup")),
        }
        # La config del tool se arma SIEMPRE (también en descartadas, para que el
        # admin pueda corregir a la IA y re-incluirlas). El dry-run solo corre en
        # las incluidas — no gastamos llamadas al proveedor en descartes.
        path_template, params_schema = _build_tool_fields(route, cls, classified_by_path)
        # Metadata por parámetro, dos fuentes con criterio distinto:
        # - description: gana la de la IA (params_doc) porque es SIEMPRE en
        #   español — la del spec (que la IA recibió de entrada) suele venir en
        #   inglés. Los x-resource-id conservan su descripción sintética.
        # - x-example: gana el spec (formato exacto garantizado); los
        #   sample_params de la IA rellenan solo donde el spec no trajo.
        #   Antes se usaban una vez para el dry-run y se tiraban.
        props = params_schema.get("properties") or {}
        for pname, pdesc in (cls.get("params_doc") or {}).items():
            prop = props.get(pname)
            if prop is not None and not prop.get("x-resource-id") \
                    and isinstance(pdesc, str) and pdesc.strip():
                prop["description"] = pdesc.strip()
        for pname, pval in (cls.get("sample_params") or {}).items():
            prop = props.get(pname)
            if prop is not None and "x-example" not in prop and not prop.get("x-resource-id") \
                    and str(pval).strip() and str(pval) != "IDENTITY":
                prop["x-example"] = pval
        item["path_template"] = path_template
        item["params_schema"] = params_schema
        item["response_map"] = {}
        proposal.append(item)

        needs_identity = "{identity}" in path_template
        if not item["include"] or (needs_identity and not test_identity):
            continue  # sin dato de identidad → "sin probar", se prueba después
        resource_params = [n for n in _PATH_PARAM_RE.findall(path_template) if n != "identity"]
        if resource_params:
            # Detalle: se prueba en la 2ª pasada con un id REAL de su lista.
            pending_detail.append((item, cls, params_schema, resource_params))
            continue
        query = _sample_query(cls, params_schema)
        test = await dry_run(connector, secret_enc, path_template, query, test_identity)
        probed_by_path[path_template] = test
        item["test"] = _test_for_ui(test)
        item["response_map"] = test.get("suggested_response_map") or {}

    # ── 2ª pasada: detalles con id REAL sacado de la lista hermana ya probada —
    # el MISMO recorrido que el botón Probar. Nunca ids de ejemplo inventados
    # (probar /projects/1 con un id fake mostraba un "Revisar · no existe" falso).
    # Sin lista hermana OK o sin elementos → queda "sin probar" (test=None), que
    # es honesto: se prueba después desde la pantalla, encadenando en vivo.
    from services.connector_memory import summarize_result
    for item, cls, params_schema, resource_params in pending_detail:
        probe_path = item["path_template"]
        for name in resource_params:
            parent = item["path_template"].split("/{" + name + "}")[0]
            sib = probed_by_path.get(parent)
            items = summarize_result(sib.get("raw")) if sib and sib.get("ok") else []
            if not items:
                probe_path = None
                break
            probe_path = probe_path.replace("{" + name + "}", str(items[0]["id"]))
        if probe_path is None:
            continue
        test = await dry_run(connector, secret_enc, probe_path,
                             _sample_query(cls, params_schema), test_identity)
        item["test"] = _test_for_ui(test)
        item["response_map"] = test.get("suggested_response_map") or {}

    return {"spec_found": True, "spec_url": source, "routes": proposal}
