"""Administración de conectores de terceros (pantalla /admin/connectors).

Materializa la Fase 1 de docs/PANTALLA_CONECTORES_PLAN.md: CRUD de la config
que el executor genérico interpreta (tenant_connectors / connector_tools /
connector_roles), más:

  POST /admin/connectors/{id}/tools/{tool_id}/test  → dry-run REAL contra el
       tercero: arma la ruta, valida egress, llama, devuelve crudo + mapeado
       + sugerencia de response_map. Es lo que hace la pantalla usable (D3).
  PUT  /admin/connectors/{id}/secret                → write-only: cifra con
       Fernet y nunca se devuelve (D1).
  PATCH /admin/connectors/{id}/active               → activar exige que cada
       host de egress_allow esté aprobado por super-admin o sea un host
       interno de confianza en dev (D2 — gobierno híbrido).

Los hosts aprobados viven en public.approved_connector_hosts (global); su alta
es de super-admin. El admin del tenant configura y prueba libremente mientras
el conector está inactivo.
"""

import asyncio
import logging
import re
import time
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field, field_validator

from core.audit import record as audit, fire_and_log
from core.config import settings
from core.egress_guard import EgressBlocked, assert_egress_allowed
from core.security import CurrentUser, require_admin_or_super, require_super_admin
from services import connectors_dao as dao
from services.connector_secrets import SUPPORTED_AUTH_TYPES, build_auth, open_secret, seal_secret

logger = logging.getLogger(__name__)
router = APIRouter()

_HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
# 'publico' = abierto a cualquiera · 'personal' = requiere identificar a la persona.
# 'afiliado'/'profesional' se aceptan por compat con conectores ya creados.
_IDENTITY_KINDS = {"publico", "personal", "afiliado", "profesional"}


def _own_tenant(current_user: CurrentUser) -> str:
    if not current_user.tenant_id or current_user.tenant_id == "__platform__":
        raise HTTPException(status_code=400, detail="No tenant context")
    return current_user.tenant_id


def _default_egress(base_url: str) -> list[str]:
    """Allowlist por defecto cuando el admin la deja vacía: el host de la URL
    base. Es lo que promete la UI — sin esto, la allowlist vacía bloquea todo."""
    from urllib.parse import urlparse
    host = (urlparse(base_url).hostname or "").lower()
    return [host] if host else []


def _audit(request: Request, user: CurrentUser, action: str, resource: str, detail: dict | None = None):
    fire_and_log(audit(
        tenant_id=user.tenant_id or "__platform__", actor_id=user.user_id,
        actor_email=user.email, actor_role=user.role.value,
        action=action, resource=resource, detail=detail, request=request,
    ), context="connectors.admin")


# ── Schemas ───────────────────────────────────────────────────────────────────

def _require_scheme(v: str | None) -> str | None:
    """Una base sin http(s):// produce URLs sin esquema que fallan silenciosamente
    en el executor ("no respondió", sin status) — rechazarla acá con mensaje claro."""
    if v is not None and not re.match(r"^https?://", v.strip(), re.IGNORECASE):
        raise ValueError("La URL base debe empezar con http:// o https:// (ej. https://api.proveedor.com)")
    return v.strip() if v else v


class ConnectorIn(BaseModel):
    slug: str = Field(min_length=2, max_length=60, pattern=r"^[a-z0-9_\-]+$")
    display_name: str = Field(min_length=2, max_length=120)
    base_url: str = Field(min_length=8, max_length=300)

    _v_base = field_validator("base_url")(_require_scheme)
    egress_allow: list[str] = Field(default_factory=list)
    auth_type: str = "none"
    auth_config: dict = Field(default_factory=dict)
    auth_validate_path: str | None = None
    timeout_ms: int = Field(default=4000, ge=500, le=30000)


class ConnectorUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=2, max_length=120)
    base_url: str | None = Field(default=None, min_length=8, max_length=300)

    _v_base = field_validator("base_url")(_require_scheme)
    egress_allow: list[str] | None = None
    auth_type: str | None = None
    auth_config: dict | None = None
    auth_validate_path: str | None = None
    timeout_ms: int | None = Field(default=None, ge=500, le=30000)


class SecretIn(BaseModel):
    secret: str = Field(min_length=1, max_length=4000)


class ActiveIn(BaseModel):
    is_active: bool


class ToolIn(BaseModel):
    slug: str = Field(min_length=2, max_length=60, pattern=r"^[a-z0-9_\-]+$")
    display_name: str = Field(min_length=2, max_length=120)
    description: str | None = Field(default=None, max_length=600)
    examples: list[str] = Field(default_factory=list, max_length=20)
    http_method: str = "GET"
    path_template: str = Field(min_length=1, max_length=300)
    params_schema: dict = Field(default_factory=dict)
    response_map: dict = Field(default_factory=dict)
    identity_kind: str = "publico"
    is_read_only: bool = True
    roles: list[str] = Field(default_factory=list)


class ToolUpdate(BaseModel):
    display_name: str | None = None
    description: str | None = None
    examples: list[str] | None = Field(default=None, max_length=20)
    http_method: str | None = None
    path_template: str | None = None
    params_schema: dict | None = None
    response_map: dict | None = None
    identity_kind: str | None = None
    is_active: bool | None = None
    roles: list[str] | None = None



class TestIn(BaseModel):
    identity: str = Field(default="", max_length=40)   # valor de prueba para {identity}
    params: dict = Field(default_factory=dict)


class HostIn(BaseModel):
    host: str = Field(min_length=3, max_length=200)
    note: str | None = None


# Usuarios autorizados por conector (registro de identidad, modo platform_registry).
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class ConnectorUserIn(BaseModel):
    documento: str = Field(min_length=3, max_length=40)   # se normaliza a dígitos
    email: str = Field(min_length=5, max_length=200)
    nombre: str = Field(min_length=2, max_length=120)
    is_active: bool = True


class ConnectorUserUpdate(BaseModel):
    documento: str | None = Field(default=None, min_length=3, max_length=40)
    email: str | None = Field(default=None, min_length=5, max_length=200)
    nombre: str | None = Field(default=None, min_length=2, max_length=120)
    is_active: bool | None = None


def _clean_user_fields(data: dict) -> dict:
    """Normaliza documento a solo dígitos (así matchea el login, que hace lo mismo)
    y valida el formato del email. Muta y devuelve el dict."""
    if data.get("documento") is not None:
        doc = re.sub(r"\D", "", data["documento"])
        if len(doc) < 3:
            raise HTTPException(status_code=422, detail="El documento debe tener al menos 3 dígitos")
        data["documento"] = doc
    if data.get("email") is not None:
        email = data["email"].strip().lower()
        if not _EMAIL_RE.match(email):
            raise HTTPException(status_code=422, detail="Email inválido")
        data["email"] = email
    if data.get("nombre") is not None:
        data["nombre"] = data["nombre"].strip()
    return data


def _validate_connector_payload(auth_type: str | None):
    if auth_type is not None and auth_type not in SUPPORTED_AUTH_TYPES:
        raise HTTPException(status_code=422, detail=f"auth_type debe ser uno de {sorted(SUPPORTED_AUTH_TYPES)}")


def _validate_tool_payload(method: str | None, identity_kind: str | None, path: str | None):
    if method is not None and method.upper() not in _HTTP_METHODS:
        raise HTTPException(status_code=422, detail=f"http_method debe ser uno de {sorted(_HTTP_METHODS)}")
    if identity_kind is not None and identity_kind not in _IDENTITY_KINDS:
        raise HTTPException(status_code=422, detail=f"identity_kind debe ser uno de {sorted(_IDENTITY_KINDS)}")
    if path is not None and not path.startswith("/"):
        raise HTTPException(status_code=422, detail="path_template debe empezar con '/'")


# ── Identificador de la persona: derivado del parámetro que detecta el discovery ──
# 100% automático: el admin no escribe cómo se llama el dato. El discovery extrae el
# nombre EXACTO del parámetro de la API (dni, id_cliente, patente...) y de ahí sale
# el nombre visible + el formato. Preset conocido → label + longitudes; desconocido
# → se prolija el nombre del parámetro con rango genérico.
_ID_PARAM_PRESETS: dict[str, tuple[str, int, int]] = {
    "dni":         ("DNI", 7, 8),
    "documento":   ("documento", 6, 12),
    "cuit":        ("CUIT", 11, 11),
    "cuil":        ("CUIL", 11, 11),
    "legajo":      ("legajo", 3, 12),
    "matricula":   ("matrícula", 3, 12),
    "patente":     ("patente", 5, 8),
    "id_cliente":  ("número de cliente", 3, 12),
    "nro_cliente": ("número de cliente", 3, 12),
    "cliente":     ("número de cliente", 3, 12),
    "id_socio":    ("número de socio", 3, 12),
    "nro_socio":   ("número de socio", 3, 12),
    "socio":       ("número de socio", 3, 12),
}
_ID_ABBR = {"nro": "número", "num": "número", "id": "número de", "doc": "documento", "cod": "código"}


def _identifier_config(param_name: str | None) -> dict:
    """Deriva {identity_label, identity_min_digits, identity_max_digits} desde el
    nombre del parámetro detectado. None/'identity' → genérico 'documento'."""
    key = (param_name or "").strip().lower()
    if key in ("", "identity"):
        label, lo, hi = "documento", 3, 12
    elif key in _ID_PARAM_PRESETS:
        label, lo, hi = _ID_PARAM_PRESETS[key]
    else:
        words = [_ID_ABBR.get(w, w) for w in re.split(r"[_\s\-]+", key) if w]
        label, lo, hi = (" ".join(words) or "documento"), 3, 12
    return {"identity_label": label, "identity_min_digits": lo, "identity_max_digits": hi}


# ── Hosts aprobados (D2) — rutas estáticas ANTES de /{connector_id} ───────────

@router.get("/admin/connectors/approved-hosts")
async def get_approved_hosts(current_user: CurrentUser = Depends(require_admin_or_super)):
    """El admin puede VER qué hosts están aprobados (para saber si podrá activar)."""
    return {"hosts": await dao.list_approved_hosts()}


@router.post("/admin/connectors/approved-hosts", status_code=201)
async def add_approved_host(
    body: HostIn, request: Request,
    current_user: CurrentUser = Depends(require_super_admin),
):
    host = body.host.strip().lower()
    await dao.approve_host(host, current_user.email or current_user.user_id, body.note)
    _audit(request, current_user, "connector_host_approved", host, {"note": body.note})
    return {"host": host, "approved": True}


@router.get("/admin/connectors/overview")
async def connectors_overview(current_user: CurrentUser = Depends(require_super_admin)):
    """Oversight de plataforma: TODOS los conectores de TODOS los tenants con sus
    rutas a la vista, más el feed de cambios recientes (30 días). La aprobación
    sigue siendo por host; esto es visibilidad continua — el super-admin ve la
    película (qué está habilitado hoy y qué cambió), no solo la foto del pedido."""
    connectors: list[dict] = []
    changes: list[dict] = []
    for t in await dao.list_tenant_ids():
        tenant_id, tenant_name = t["id"], t.get("name") or t["id"]
        try:
            conns = await dao.list_connectors(tenant_id)
        except Exception:  # noqa: BLE001 — tenant sin schema de conectores
            continue
        # id/slug → nombre humano, para que el feed no muestre UUIDs crudos.
        names: dict[str, str] = {}
        for c in conns:
            names[c["id"]] = c["display_name"]
            names[c.get("slug") or ""] = c["display_name"]
            try:
                tools = await dao.list_tools(tenant_id, c["id"])
            except Exception:  # noqa: BLE001
                tools = []
            for x in tools:
                names[x["id"]] = f"{x['display_name']} ({c['display_name']})"
            connectors.append({
                "tenant_id": tenant_id, "tenant_name": tenant_name,
                "id": c["id"], "display_name": c["display_name"],
                "base_url": c["base_url"], "is_active": c["is_active"],
                "auth_type": c["auth_type"], "egress_allow": c["egress_allow"],
                "tools": [{"display_name": x["display_name"], "http_method": x["http_method"],
                           "path_template": x["path_template"], "is_active": x["is_active"]}
                          for x in tools],
            })
        if conns:
            try:
                for ch in await dao.recent_connector_changes(tenant_id):
                    # resource puede ser: connector_id, tool_id, slug, o "uuid/slug".
                    res = ch.get("resource") or ""
                    if "/" in res:
                        cid, _, slug = res.partition("/")
                        label = f"{slug} ({names.get(cid, 'conector eliminado')})"
                    else:
                        label = names.get(res)
                        if label is None:
                            # UUID de algo que ya no existe → decirlo; texto plano → tal cual.
                            label = "(ya eliminado)" if re.match(r"^[0-9a-f-]{36}$", res) else (res or None)
                    changes.append({"tenant_id": tenant_id, "tenant_name": tenant_name,
                                    "resource_label": label, **ch})
            except Exception as exc:  # noqa: BLE001 — el feed es best-effort
                logger.warning("connector_changes_failed tenant=%s error=%s", tenant_id, exc)
    changes.sort(key=lambda x: x.get("created_at") or 0, reverse=True)
    return {"connectors": connectors, "changes": changes[:50]}


@router.get("/admin/connectors/activation-requests")
async def list_activation_requests(current_user: CurrentUser = Depends(require_super_admin)):
    """Panel super-admin: qué tenants están pidiendo activar conectores. Cada
    solicitud trae el conector con sus rutas a la vista para decidir con
    fundamento. Auto-limpieza: solicitudes de conectores borrados o ya activos
    se eliminan al listarlas."""
    out = []
    for req in await dao.list_activation_requests():
        tenant_id, connector_id = req["tenant_id"], req["connector_id"]
        try:
            conn = await dao.get_connector(tenant_id, connector_id)
        except Exception:  # noqa: BLE001 — schema del tenant inaccesible
            conn = None
        if conn is None or conn.get("is_active"):
            try:
                await dao.delete_activation_request(tenant_id, connector_id)
            except Exception:  # noqa: BLE001
                pass
            continue
        hosts = []
        for h in req["hosts"] or []:
            hosts.append({"host": h, "approved": await dao.is_host_approved(h)})
        # Todos los hosts aprobados → el trabajo del super-admin terminó: la
        # solicitud sale de la lista (el admin del tenant solo tiene que
        # reactivar; si no lo hace, no es un pendiente NUESTRO).
        if all(h["approved"] for h in hosts):
            try:
                await dao.delete_activation_request(tenant_id, connector_id)
            except Exception:  # noqa: BLE001
                pass
            continue
        try:
            tools = await dao.list_tools(tenant_id, connector_id)
        except Exception:  # noqa: BLE001
            tools = []
        out.append({
            "tenant_id": tenant_id,
            "tenant_name": req.get("tenant_name") or tenant_id,
            "connector_id": connector_id,
            "connector_name": conn["display_name"],
            "base_url": conn["base_url"],
            "hosts": hosts,
            "requested_by": req.get("requested_by"),
            "requested_at": req.get("created_at"),
            "tools": [{"display_name": t["display_name"], "http_method": t["http_method"],
                       "path_template": t["path_template"], "is_active": t["is_active"]}
                      for t in tools],
        })
    return {"requests": out}


@router.delete("/admin/connectors/approved-hosts/{host}")
async def delete_approved_host(
    host: str, request: Request,
    current_user: CurrentUser = Depends(require_super_admin),
):
    removed = await dao.remove_approved_host(host.strip().lower())
    if not removed:
        raise HTTPException(status_code=404, detail="Host no encontrado")
    _audit(request, current_user, "connector_host_removed", host)
    return {"host": host, "approved": False}


# ── Conectores ────────────────────────────────────────────────────────────────

async def _unapproved_hosts(egress_allow: list[str]) -> list[str]:
    """Hosts del conector que todavía necesitan aprobación del super-admin
    (excluye los internos de confianza). Compartido por activar y por el flag
    pending_approval de los GET."""
    trusted = settings.trusted_internal_hosts_set
    out = []
    for host in egress_allow:
        if host in trusted:
            continue
        if not await dao.is_host_approved(host):
            out.append(host)
    return out


async def _pending_approval(tenant_id: str, conn: dict, requested_ids: set[str]) -> bool:
    """True si el conector está esperando al super-admin: hay solicitud viva Y
    sigue habiendo hosts sin aprobar. Se recalcula contra los hosts actuales
    para que el estado caiga solo apenas el super-admin aprueba."""
    if conn["is_active"] or conn["id"] not in requested_ids:
        return False
    return bool(await _unapproved_hosts(conn["egress_allow"]))


@router.get("/admin/connectors")
async def list_connectors(current_user: CurrentUser = Depends(require_admin_or_super)):
    tenant_id = _own_tenant(current_user)
    conns = await dao.list_connectors(tenant_id)
    # Salud desde tool_call_audit — best-effort: si la consulta falla, el listado
    # sale igual (health=None → la UI muestra "sin datos").
    try:
        health = await dao.connectors_health(tenant_id)
    except Exception as exc:
        logger.warning("connectors_health_failed tenant=%s error=%s", tenant_id, exc)
        health = {}
    try:
        requested = await dao.list_activation_request_ids(tenant_id)
    except Exception as exc:  # noqa: BLE001 — el flag es informativo
        logger.warning("activation_request_ids_failed tenant=%s error=%s", tenant_id, exc)
        requested = set()
    for c in conns:
        c["health"] = health.get(c["id"])
        c["pending_approval"] = await _pending_approval(tenant_id, c, requested)
    return {"connectors": conns}


@router.post("/admin/connectors", status_code=201)
async def create_connector(
    body: ConnectorIn, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    tenant_id = _own_tenant(current_user)
    _validate_connector_payload(body.auth_type)
    data = body.model_dump()
    data["egress_allow"] = [h.strip().lower() for h in data["egress_allow"] if h.strip()]
    if not data["egress_allow"]:
        data["egress_allow"] = _default_egress(data["base_url"])
    try:
        cid = await dao.create_connector(tenant_id, data)
    except Exception as exc:
        if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
            raise HTTPException(status_code=409, detail=f"Ya existe un conector con slug '{body.slug}'")
        raise
    _audit(request, current_user, "connector_created", body.slug)
    return {"id": cid}


@router.get("/admin/connectors/{connector_id}")
async def get_connector(connector_id: str, current_user: CurrentUser = Depends(require_admin_or_super)):
    tenant_id = _own_tenant(current_user)
    conn = await dao.get_connector(tenant_id, connector_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="Conector no encontrado")
    conn["tools"] = await dao.list_tools(tenant_id, connector_id)
    try:
        requested = await dao.list_activation_request_ids(tenant_id)
    except Exception:  # noqa: BLE001 — el flag es informativo
        requested = set()
    conn["pending_approval"] = await _pending_approval(tenant_id, conn, requested)
    return conn


@router.put("/admin/connectors/{connector_id}")
async def update_connector(
    connector_id: str, body: ConnectorUpdate, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    tenant_id = _own_tenant(current_user)
    _validate_connector_payload(body.auth_type)
    data = {k: v for k, v in body.model_dump().items() if v is not None}
    if "egress_allow" in data:
        data["egress_allow"] = [h.strip().lower() for h in data["egress_allow"] if h.strip()]
    # Mantener la promesa de la UI también al editar: si la allowlist final
    # queda vacía, se usa el host de la URL base (la nueva o la existente).
    if ("egress_allow" in data and not data["egress_allow"]) or "base_url" in data:
        current = await dao.get_connector(tenant_id, connector_id)
        if current is None:
            raise HTTPException(status_code=404, detail="Conector no encontrado")
        final_egress = data.get("egress_allow", current["egress_allow"])
        if not final_egress:
            data["egress_allow"] = _default_egress(data.get("base_url", current["base_url"]))
    # oauth2: el token endpoint suele vivir en OTRO host que la API
    # (auth.proveedor.com vs api.proveedor.com). Se suma solo a la allowlist —
    # sigue pasando por el mismo circuito de aprobación de hosts al activar.
    token_url = (data.get("auth_config") or {}).get("token_url") \
        if isinstance(data.get("auth_config"), dict) else None
    if token_url:
        host = (urlparse(str(token_url)).hostname or "").strip().lower()
        if host:
            current = await dao.get_connector(tenant_id, connector_id)
            if current is None:
                raise HTTPException(status_code=404, detail="Conector no encontrado")
            final_egress = [h.lower() for h in data.get("egress_allow", current["egress_allow"])]
            if host not in final_egress:
                data["egress_allow"] = final_egress + [host]
    if not await dao.update_connector(tenant_id, connector_id, data):
        raise HTTPException(status_code=404, detail="Conector no encontrado")
    if "auth_config" in data or "auth_type" in data:
        # La credencial cambió: el token oauth2 cacheado (si lo hay) ya no vale.
        from services.connector_oauth import invalidate
        await invalidate(connector_id)
    # Cambiar la config de un conector activo lo desactiva: hay que re-probar y
    # re-activar (fail-closed — la config nueva no está validada).
    await dao.set_connector_active(tenant_id, connector_id, False)
    _audit(request, current_user, "connector_updated", connector_id, {"fields": list(data)})
    return {"ok": True, "deactivated": True}


@router.delete("/admin/connectors/{connector_id}")
async def delete_connector(
    connector_id: str, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    tenant_id = _own_tenant(current_user)
    if not await dao.delete_connector(tenant_id, connector_id):
        raise HTTPException(status_code=404, detail="Conector no encontrado")
    _audit(request, current_user, "connector_deleted", connector_id)
    return {"ok": True}


@router.put("/admin/connectors/{connector_id}/secret")
async def put_secret(
    connector_id: str, body: SecretIn, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Write-only: se cifra y nunca se devuelve. La UI solo ve has_secret."""
    tenant_id = _own_tenant(current_user)
    if await dao.get_connector(tenant_id, connector_id) is None:
        raise HTTPException(status_code=404, detail="Conector no encontrado")
    await dao.set_connector_secret(tenant_id, connector_id, seal_secret(body.secret))
    # Secreto nuevo → el token oauth2 cacheado con el anterior ya no vale.
    from services.connector_oauth import invalidate
    await invalidate(connector_id)
    _audit(request, current_user, "connector_secret_set", connector_id)
    return {"ok": True, "has_secret": True}


@router.post("/admin/connectors/{connector_id}/test-auth")
async def test_auth(
    connector_id: str, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Valida la credencial sin tocar las operaciones. oauth2: fuerza una emisión
    REAL de token contra el proveedor (invalida el cache primero). Tipos
    estáticos: valida que la config esté completa — la validez real de una api
    key solo se comprueba probando una operación."""
    tenant_id = _own_tenant(current_user)
    conn = await dao.get_connector(tenant_id, connector_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="Conector no encontrado")
    secret = open_secret(await dao.get_connector_secret_enc(tenant_id, connector_id))
    start = time.monotonic()
    try:
        if conn["auth_type"] == "oauth2":
            from services.connector_discovery import _conn_oauth_ctx
            from services.connector_oauth import get_access_token, invalidate
            await invalidate(str(conn["id"]))
            await get_access_token(_conn_oauth_ctx(conn), conn.get("auth_config") or {}, secret)
            note = None
        else:
            build_auth(conn["auth_type"], conn.get("auth_config") or {}, secret)
            note = "Config completa. La validez real de la clave se comprueba al probar una operación."
    except (ValueError, EgressBlocked) as exc:
        _audit(request, current_user, "connector_auth_tested", connector_id, {"ok": False})
        return {"ok": False, "detail": str(exc)[:300]}
    _audit(request, current_user, "connector_auth_tested", connector_id, {"ok": True})
    return {"ok": True, "latency_ms": int((time.monotonic() - start) * 1000), "note": note}


@router.patch("/admin/connectors/{connector_id}/active")
async def set_active(
    connector_id: str, body: ActiveIn, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Activar/desactivar. Activar exige hosts aprobados (D2): cada host de
    egress_allow debe estar en approved_connector_hosts, o ser un host interno
    de confianza (mocks en dev). Desactivar es siempre libre."""
    tenant_id = _own_tenant(current_user)
    conn = await dao.get_connector(tenant_id, connector_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="Conector no encontrado")

    if body.is_active:
        if not conn["egress_allow"]:
            raise HTTPException(status_code=422, detail="El conector no tiene hosts en egress_allow")
        pending = await _unapproved_hosts(conn["egress_allow"])
        if pending:
            # No es un error del admin: es un paso del circuito. Queda registrada
            # la solicitud (el super-admin la ve en su panel con tenant + conector
            # + hosts + rutas) y el conector queda "esperando aprobación" — la UI
            # lo muestra como estado, no como rebote.
            try:
                await dao.upsert_activation_request(
                    tenant_id, connector_id, pending,
                    current_user.email or current_user.user_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning("activation_request_failed tenant=%s error=%s", tenant_id, exc)
            _audit(request, current_user, "connector_activation_requested", connector_id,
                   {"hosts": pending})
            return {"ok": True, "is_active": False,
                    "pending_approval": True, "pending_hosts": pending}

    await dao.set_connector_active(tenant_id, connector_id, body.is_active)
    if body.is_active:
        # Activado con éxito → la solicitud pendiente (si había) ya no corre.
        try:
            await dao.delete_activation_request(tenant_id, connector_id)
        except Exception:  # noqa: BLE001 — limpieza best-effort
            pass
    _audit(request, current_user, "connector_active_changed", connector_id, {"is_active": body.is_active})
    return {"ok": True, "is_active": body.is_active}


# ── Tools ─────────────────────────────────────────────────────────────────────

@router.post("/admin/connectors/{connector_id}/tools", status_code=201)
async def create_tool(
    connector_id: str, body: ToolIn, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    tenant_id = _own_tenant(current_user)
    if await dao.get_connector(tenant_id, connector_id) is None:
        raise HTTPException(status_code=404, detail="Conector no encontrado")
    _validate_tool_payload(body.http_method, body.identity_kind, body.path_template)
    data = body.model_dump(exclude={"roles"})
    data["http_method"] = data["http_method"].upper()
    try:
        tid = await dao.create_tool(tenant_id, connector_id, data)
    except Exception as exc:
        if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
            raise HTTPException(status_code=409, detail=f"Ya existe una tool con slug '{body.slug}'")
        raise
    if body.roles:
        await dao.set_tool_roles(tenant_id, tid, body.roles)
    # Nueva tool arranca activa (el gate real es el conector, que sigue inactivo).
    await dao.update_tool(tenant_id, tid, {"is_active": True})
    _audit(request, current_user, "connector_tool_created", f"{connector_id}/{body.slug}")
    return {"id": tid}


@router.put("/admin/connectors/tools/{tool_id}")
async def update_tool(
    tool_id: str, body: ToolUpdate, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    tenant_id = _own_tenant(current_user)
    _validate_tool_payload(body.http_method, body.identity_kind, body.path_template)
    data = {k: v for k, v in body.model_dump(exclude={"roles"}).items() if v is not None}
    if "http_method" in data:
        data["http_method"] = data["http_method"].upper()
    if data and not await dao.update_tool(tenant_id, tool_id, data):
        raise HTTPException(status_code=404, detail="Tool no encontrada")
    if body.roles is not None:
        await dao.set_tool_roles(tenant_id, tool_id, body.roles)
    _audit(request, current_user, "connector_tool_updated", tool_id, {"fields": list(data)})
    return {"ok": True}


@router.delete("/admin/connectors/tools/{tool_id}")
async def delete_tool(
    tool_id: str, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    tenant_id = _own_tenant(current_user)
    if not await dao.delete_tool(tenant_id, tool_id):
        raise HTTPException(status_code=404, detail="Tool no encontrada")
    _audit(request, current_user, "connector_tool_deleted", tool_id)
    return {"ok": True}


# ── Data flywheel: candidatos a ejemplo (consultas reales que rutearon OK) ───────
@router.get("/admin/connectors/tools/{tool_id}/example-candidates")
async def list_example_candidates(
    tool_id: str, current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Consultas reales que rutearon OK a esta operación y todavía no son ejemplos.
    El admin las revisa y aprueba las buenas → mejoran el ruteo."""
    tenant_id = _own_tenant(current_user)
    return {"candidates": await dao.list_example_candidates(tenant_id, tool_id)}


@router.post("/admin/connectors/example-candidates/{candidate_id}/approve")
async def approve_example_candidate(
    candidate_id: str, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Aprueba un candidato → pasa a los ejemplos de la operación."""
    tenant_id = _own_tenant(current_user)
    query = await dao.approve_example_candidate(tenant_id, candidate_id)
    if query is None:
        raise HTTPException(status_code=404, detail="Candidato no encontrado")
    _audit(request, current_user, "connector_example_approved", candidate_id, {"query": query})
    return {"ok": True, "query": query}


@router.post("/admin/connectors/example-candidates/{candidate_id}/dismiss")
async def dismiss_example_candidate(
    candidate_id: str, current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Descarta un candidato: no se vuelve a sugerir."""
    tenant_id = _own_tenant(current_user)
    if not await dao.dismiss_example_candidate(tenant_id, candidate_id):
        raise HTTPException(status_code=404, detail="Candidato no encontrado")
    return {"ok": True}


# ── Usuarios autorizados por conector (registro de identidad, platform_registry) ──
# La identidad de quién puede consultar la validamos nosotros: lista blanca con
# documento + email + nombre. El login busca por documento y manda OTP al email.
# Solo admin del tenant (require_admin_or_super). Aislado por schema.

@router.get("/admin/connectors/{connector_id}/users")
async def list_connector_users(
    connector_id: str, current_user: CurrentUser = Depends(require_admin_or_super),
):
    tenant_id = _own_tenant(current_user)
    if await dao.get_connector(tenant_id, connector_id) is None:
        raise HTTPException(status_code=404, detail="Conector no encontrado")
    return {"users": await dao.list_connector_users(tenant_id, connector_id)}


@router.post("/admin/connectors/{connector_id}/users", status_code=201)
async def create_connector_user(
    connector_id: str, body: ConnectorUserIn, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    tenant_id = _own_tenant(current_user)
    if await dao.get_connector(tenant_id, connector_id) is None:
        raise HTTPException(status_code=404, detail="Conector no encontrado")
    data = _clean_user_fields(body.model_dump())
    try:
        uid = await dao.create_connector_user(tenant_id, connector_id, data)
    except Exception as exc:
        if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
            raise HTTPException(status_code=409, detail="Ya existe un usuario con ese documento o email en este conector")
        raise
    _audit(request, current_user, "connector_user_created", connector_id, {"documento": data["documento"]})
    return {"id": uid}


@router.patch("/admin/connectors/users/{user_id}")
async def update_connector_user(
    user_id: str, body: ConnectorUserUpdate, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    tenant_id = _own_tenant(current_user)
    data = _clean_user_fields({k: v for k, v in body.model_dump().items() if v is not None})
    if not data:
        raise HTTPException(status_code=422, detail="Nada para actualizar")
    try:
        ok = await dao.update_connector_user(tenant_id, user_id, data)
    except Exception as exc:
        if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
            raise HTTPException(status_code=409, detail="Ya existe un usuario con ese documento o email en este conector")
        raise
    if not ok:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    _audit(request, current_user, "connector_user_updated", user_id, {"fields": list(data)})
    return {"ok": True}


@router.delete("/admin/connectors/users/{user_id}")
async def delete_connector_user(
    user_id: str, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    tenant_id = _own_tenant(current_user)
    if not await dao.delete_connector_user(tenant_id, user_id):
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    _audit(request, current_user, "connector_user_deleted", user_id)
    return {"ok": True}


# ── Conexión automática: descubrir + aplicar (wizard con IA) ──────────────────

class DiscoverIn(BaseModel):
    test_identity: str = Field(default="", max_length=40)


class ApplyToolIn(BaseModel):
    slug: str
    display_name: str
    description: str | None = None
    http_method: str = "GET"
    path_template: str
    params_schema: dict = Field(default_factory=dict)
    response_map: dict = Field(default_factory=dict)
    identity_kind: str = "publico"
    is_lookup: bool = False
    identity_param: str | None = None  # nombre del identificador en el API (dni, legajo...)


class ApplyIn(BaseModel):
    tools: list[ApplyToolIn]


@router.post("/admin/connectors/{connector_id}/discover")
async def discover_connector(
    connector_id: str, body: DiscoverIn, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Lee el catálogo OpenAPI del proveedor, clasifica las rutas con IA, las prueba
    en vivo y devuelve la propuesta completa. NO crea nada: el admin revisa y aplica."""
    from services.connector_discovery import build_proposal

    tenant_id = _own_tenant(current_user)
    conn = await dao.get_connector(tenant_id, connector_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="Conector no encontrado")
    secret_enc = await dao.get_connector_secret_enc(tenant_id, connector_id)
    try:
        proposal = await build_proposal(conn, secret_enc, tenant_id, body.test_identity.strip())
    except Exception as exc:
        logger.warning("discovery_failed connector=%s error=%s", connector_id, exc)
        raise HTTPException(status_code=502, detail=f"No pude analizar el API del proveedor: {str(exc)[:200]}")
    _audit(request, current_user, "connector_discovered", connector_id,
           {"spec_found": proposal.get("spec_found"), "routes": len(proposal.get("routes", []))})
    return proposal


# ── Conexión desde documentación subida (sin OpenAPI en vivo) ──────────────────

_DISCOVER_FILE_MAX_BYTES = 15 * 1024 * 1024  # la doc de un API no debería pesar más
_DISCOVER_FILE_EXT_MIME = {
    ".pdf":  "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt":  "text/plain",
    ".md":   "text/plain",
    ".html": "text/html",
    ".htm":  "text/html",
    ".json": "application/json",
}


@router.post("/admin/connectors/{connector_id}/discover-file")
async def discover_connector_from_file(
    connector_id: str, request: Request,
    file: UploadFile = File(...),
    test_identity: str = Form(default="", max_length=40),
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Mismo wizard que /discover, pero las rutas salen de la documentación que
    subió el admin (PDF/Word/TXT/Markdown/JSON) en vez del OpenAPI en vivo.
    Si el JSON subido ya ES un OpenAPI, se parsea directo sin LLM."""
    from services.chunker import extract_text_from_bytes
    from services.connector_discovery import (
        parse_openapi, propose_from_routes, routes_from_document,
    )

    tenant_id = _own_tenant(current_user)
    conn = await dao.get_connector(tenant_id, connector_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="Conector no encontrado")

    filename = file.filename or "documentacion"
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    mime = _DISCOVER_FILE_EXT_MIME.get(ext)
    if mime is None:
        raise HTTPException(status_code=415,
                            detail="Formato no soportado. Subí PDF, Word (docx), TXT, Markdown o JSON.")
    content = await file.read()
    if len(content) > _DISCOVER_FILE_MAX_BYTES:
        raise HTTPException(status_code=413, detail="El archivo supera los 15 MB.")
    if not content:
        raise HTTPException(status_code=422, detail="El archivo está vacío.")

    # JSON que ya es un OpenAPI → parseo directo, sin LLM.
    routes: list[dict] | None = None
    if mime == "application/json":
        import json as _json
        try:
            spec = _json.loads(content)
            if isinstance(spec, dict) and "paths" in spec:
                routes = parse_openapi(spec)
        except ValueError:
            pass  # no es JSON válido → sigue como texto libre

    if routes is None:
        # PDF/docx parsean CPU-bound → executor, igual que en el pipeline de ingesta.
        loop = asyncio.get_running_loop()
        text = await loop.run_in_executor(None, extract_text_from_bytes, content, mime, filename)
        if not text.strip():
            raise HTTPException(status_code=422,
                                detail="No pude extraer texto del archivo (¿PDF escaneado sin OCR?).")
        try:
            routes = await routes_from_document(text, tenant_id)
        except Exception as exc:
            logger.warning("discover_file_extract_failed connector=%s error=%s", connector_id, exc)
            raise HTTPException(status_code=502,
                                detail=f"No pude interpretar la documentación: {str(exc)[:200]}")

    if not routes:
        _audit(request, current_user, "connector_discovered_file", connector_id,
               {"filename": filename, "routes": 0})
        return {"spec_found": False, "routes": [],
                "hint": "No encontré rutas en el archivo. Revisá que la documentación "
                        "describa los endpoints (método + path) o cargá las rutas a mano."}

    secret_enc = await dao.get_connector_secret_enc(tenant_id, connector_id)
    try:
        proposal = await propose_from_routes(conn, secret_enc, tenant_id,
                                             test_identity.strip(), routes,
                                             f"archivo: {filename}")
    except Exception as exc:
        logger.warning("discover_file_failed connector=%s error=%s", connector_id, exc)
        raise HTTPException(status_code=502,
                            detail=f"No pude armar la propuesta: {str(exc)[:200]}")
    _audit(request, current_user, "connector_discovered_file", connector_id,
           {"filename": filename, "routes": len(proposal.get("routes", []))})
    return proposal


async def _backfill_param_metadata(tenant_id: str, tool: dict, new_schema: dict) -> None:
    """Completa description/x-example en los parámetros de una tool existente a
    partir de una re-detección. Solo AGREGA claves ausentes en props ya
    declarados — nunca pisa valores ni cambia el set de parámetros."""
    old_schema = dict(tool.get("params_schema") or {})
    old_props = old_schema.get("properties") or {}
    changed = False
    for name, new_prop in ((new_schema or {}).get("properties") or {}).items():
        old_prop = old_props.get(name)
        if old_prop is None:
            continue
        for key in ("description", "x-example"):
            if key in new_prop and key not in old_prop:
                old_prop[key] = new_prop[key]
                changed = True
    if changed:
        await dao.update_tool(tenant_id, tool["id"], {"params_schema": old_schema})


@router.post("/admin/connectors/{connector_id}/apply")
async def apply_proposal(
    connector_id: str, body: ApplyIn, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Crea en bloque las tools confirmadas por el admin (+roles). Si hay ruta de
    perfil (is_lookup), configura el OTP propio automáticamente. El conector NO
    se activa: eso sigue siendo un clic explícito del admin."""
    tenant_id = _own_tenant(current_user)
    conn = await dao.get_connector(tenant_id, connector_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="Conector no encontrado")

    # Re-detección segura: una operación con la MISMA RUTA que una ya cargada se
    # CONSERVA intacta (no se recrea) — así el admin puede re-detectar para sumar
    # rutas nuevas sin perder los ejemplos, descripciones y params que curó a mano.
    # Se compara por (método, ruta), no por slug: la IA cambia el slug entre
    # corridas (español↔inglés) pero la ruta es estable.
    existing = await dao.list_tools(tenant_id, connector_id)
    existing_paths = {(e["http_method"].upper(), e["path_template"]) for e in existing}
    existing_by_path = {(e["http_method"].upper(), e["path_template"]): e for e in existing}

    created, kept, lookup_path, lookup_param = [], [], None, None
    id_params: list[str] = []   # identity_param de las operaciones personales
    for t in body.tools:
        _validate_tool_payload(t.http_method, t.identity_kind, t.path_template)
        if t.is_lookup:
            lookup_path = t.path_template
            lookup_param = t.identity_param
            continue  # el perfil no es una tool de chat: solo config del OTP
        if (t.http_method.upper(), t.path_template) in existing_paths:
            kept.append(t.slug)   # ya existe esa ruta → intacta, no la tocamos
            # …salvo la metadata de parámetros (descripción/ejemplo) que la
            # re-detección trae y la tool aún no tiene: se COMPLETA sin pisar
            # nada existente ni tocar lo curado a mano (ejemplos, response_map).
            await _backfill_param_metadata(
                tenant_id, existing_by_path[(t.http_method.upper(), t.path_template)],
                t.params_schema)
            continue
        data = t.model_dump(exclude={"is_lookup", "identity_param"})
        data["http_method"] = data["http_method"].upper()
        data["is_read_only"] = True
        try:
            tool_id = await dao.create_tool(tenant_id, connector_id, data)
        except Exception as exc:
            if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
                logger.info("apply_skip_duplicate slug=%s", t.slug)
                continue
            raise
        # El rol requerido = el propio identity_kind de la tool (genérico, no atado
        # a un rubro): el FSM setea session.rol = identity_kind al validar, y acá
        # se exige ese mismo rol. Las públicas no chequean rol (short-circuit).
        roles = ["publico"] if t.identity_kind == "publico" else [t.identity_kind]
        await dao.set_tool_roles(tenant_id, tool_id, roles)
        await dao.update_tool(tenant_id, tool_id, {"is_active": True})
        if t.identity_kind != "publico" and t.identity_param:
            id_params.append(t.identity_param.strip())
        created.append(t.slug)

    # Identificador de la persona: 100% automático desde lo que detectó el discovery.
    # Se toma el parámetro más frecuente entre las operaciones personales (o el de la
    # ruta de perfil), y de ahí salen el nombre visible y el formato — el admin no
    # escribe nada.
    detected_param = None
    if id_params:
        detected_param = max(set(id_params), key=id_params.count)
    elif lookup_param:
        detected_param = lookup_param

    cfg_updates: dict = {}
    if detected_param:
        cfg_updates.update(_identifier_config(detected_param))
    if lookup_path:
        cfg_updates["identity_validation"] = "platform_otp"
        cfg_updates["identity_lookup_path"] = lookup_path
    if cfg_updates:
        new_cfg = {**(conn.get("auth_config") or {}), **cfg_updates}
        await dao.update_connector(tenant_id, connector_id, {"auth_config": new_cfg})

    # Ejemplos de consulta autogenerados para las tools nuevas — cierra el
    # cold-start del ruteo (fraseos indirectos sin ejemplos rebotaban). No pisa
    # ejemplos existentes; best-effort: si el LLM falla, el apply sale igual.
    if created:
        try:
            from services.tool_example_gen import autofill_missing_examples
            await autofill_missing_examples(tenant_id, connector_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("apply_example_gen_failed connector=%s error=%s", connector_id, exc)

    _audit(request, current_user, "connector_proposal_applied", connector_id,
           {"tools": created, "kept": kept, "lookup": lookup_path})
    return {"created": created, "kept": kept, "identity_lookup_path": lookup_path}


# ── Dry-run (el corazón de la pantalla) ───────────────────────────────────────

async def _dry_run_tool(conn: dict, tool: dict, tenant_id: str, connector_id: str,
                        identity: str, params: dict) -> dict:
    """Núcleo del dry-run: arma la URL final, valida egress, llama al tercero y
    devuelve crudo + mapeado + sugerencia de response_map. Compartido por la
    prueba individual y la masiva."""
    from services.connector_executor import _apply_response_map, _build_path, join_url

    # Requeridos sin valor (el autofill ya completó enums e ids de recurso): mejor
    # un mensaje claro en castellano que el 400 del proveedor. En "Probar todas"
    # no hay campos para completar, así el admin sabe que debe probarla individual.
    props = ((tool.get("params_schema") or {}).get("properties") or {})
    faltan = [n for n in (tool.get("params_schema") or {}).get("required", [])
              if not str(params.get(n) or "").strip()]
    if faltan:
        desc = ((props.get(faltan[0]) or {}).get("description") or "").rstrip(".")
        hint = f" ({desc})" if desc else ""
        return {"url": None, "method": tool["http_method"], "ok": False,
                "error": "params_missing",
                "detail": f"Necesita el parámetro «{faltan[0]}»{hint}. "
                          f"Probala individualmente completando un valor."}

    path, query = _build_path(tool["path_template"], identity, dict(params))
    url = join_url(conn["base_url"], path)
    result: dict = {"url": url, "method": tool["http_method"]}

    try:
        assert_egress_allowed(
            url, conn["egress_allow"],
            allow_http=settings.environment == "development",
            trusted_internal_hosts=settings.trusted_internal_hosts_set,
        )
    except EgressBlocked as exc:
        result.update(ok=False, error="egress_blocked", detail=str(exc))
        return result

    from services.connector_discovery import _conn_oauth_ctx
    from services.connector_secrets import resolve_auth
    try:
        secret = open_secret(await dao.get_connector_secret_enc(tenant_id, connector_id))
        auth_kwargs = await resolve_auth(conn["auth_type"], conn.get("auth_config") or {},
                                         secret, oauth_ctx=_conn_oauth_ctx(conn))
    except ValueError as exc:
        result.update(ok=False, error="auth_config_invalid", detail=str(exc))
        return result

    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=conn["timeout_ms"] / 1000) as client:
            for intento in (1, 2):
                resp = await client.request(
                    tool["http_method"].upper(), url,
                    # La clave por query va como params, nunca en la URL: result["url"]
                    # se muestra al admin y se persiste — no debe contener el secreto.
                    params={**(query or {}), **auth_kwargs["params"]} or None,
                    headers=auth_kwargs["headers"] or None, auth=auth_kwargs["auth"],
                )
                # Retry-once oauth2: token revocado antes de vencer → re-emitir una vez.
                if resp.status_code == 401 and conn["auth_type"] == "oauth2" and intento == 1:
                    from services.connector_oauth import invalidate
                    await invalidate(str(conn["id"]))
                    auth_kwargs = await resolve_auth(conn["auth_type"], conn.get("auth_config") or {},
                                                     secret, oauth_ctx=_conn_oauth_ctx(conn))
                    continue
                break
        latency = int((time.monotonic() - start) * 1000)
        raw = resp.json() if "json" in (resp.headers.get("content-type") or "") else resp.text[:2000]
        result.update(ok=resp.status_code < 400, status=resp.status_code, latency_ms=latency, raw=raw)
        if resp.status_code < 400 and not isinstance(raw, str):
            mapped = _apply_response_map(raw, tool["response_map"])
            result["mapped"] = {"outcome": mapped.outcome, "data": mapped.data}
            from services.connector_discovery import suggest_response_map
            result["suggested_response_map"] = suggest_response_map(raw)
    except httpx.HTTPError as exc:
        result.update(ok=False, error="upstream", detail=str(exc)[:300],
                      latency_ms=int((time.monotonic() - start) * 1000))
    except ValueError as exc:
        # Re-emisión oauth2 fallida durante el retry-once → error de credencial claro.
        result.update(ok=False, error="auth_config_invalid", detail=str(exc)[:300])
    return result


async def _autofill_resource_ids(conn: dict, tool: dict, tools: list[dict],
                                 tenant_id: str, connector_id: str, identity: str,
                                 params: dict, _depth: int = 0,
                                 ) -> tuple[dict | None, list[dict], str | None]:
    """Recorrido automático de prueba: completa los params que el admin no puso.

    Reglas (config-driven, sin hardcodear ningún proveedor):
      - requerido con enum y sin valor → primer valor del enum.
      - x-resource-id sin valor → id REAL sacado de su operación de listado:
          * `x-resource-source` en el schema: slug de la lista, o dict
            {valor_de_enum: slug} cuando la fuente depende de otro param (ej.
            entityType=project → lista_proyectos).
          * sin fuente declarada: la hermana estructural (misma ruta sin el
            último tramo `/{param}`).
        La lista intermedia se autocompleta recursivamente (profundidad ≤ 2).
    Devuelve (params, autos, error_descriptivo) — si un tramo no conecta, el
    error dice exactamente cuál."""
    from services.connector_memory import summarize_result
    props = ((tool.get("params_schema") or {}).get("properties") or {})
    required = (tool.get("params_schema") or {}).get("required", [])
    autos: list[dict] = []
    filled = dict(params)

    # 1) Requeridos con enum → primer valor (los selectores no bloquean la prueba).
    for name in required:
        spec = props.get(name) or {}
        if spec.get("enum") and not str(filled.get(name) or "").strip():
            filled[name] = spec["enum"][0]

    # 1b) Requeridos sin valor con ejemplo declarado (spec/IA/doc/admin) →
    #     usarlo. Solo requeridos: probar con el mínimo real es lo más parecido
    #     al uso; llenar opcionales solo suma modos de falla espurios.
    for name in required:
        spec = props.get(name) or {}
        if spec.get("x-resource-id") or spec.get("enum"):
            continue
        if str(filled.get(name) or "").strip():
            continue
        ex = spec.get("x-example")
        if ex is not None and str(ex).strip():
            filled[name] = ex
            autos.append({"param": name, "value": ex, "from": "__example__"})

    # 2) Ids de recurso → conseguir un id real desde su lista.
    for name, spec in props.items():
        if not (isinstance(spec, dict) and spec.get("x-resource-id")):
            continue
        if str(filled.get(name) or "").strip():
            continue

        src = spec.get("x-resource-source")
        if isinstance(src, dict):
            # La fuente depende del valor de otro param enum (ej. entityType).
            selector = next((n for n, s in props.items()
                             if isinstance(s, dict) and s.get("enum")
                             and set(map(str, s["enum"])) & set(src.keys())), None)
            sel_val = str(filled.get(selector) or "") if selector else ""
            if sel_val not in src:
                sel_val = next(iter(src))
                if selector:
                    filled[selector] = sel_val
            list_tool = next((t for t in tools if t["slug"] == src[sel_val]), None)
            faltante_hint = f"la operación «{src[sel_val]}»"
        elif isinstance(src, str):
            list_tool = next((t for t in tools if t["slug"] == src), None)
            faltante_hint = f"la operación «{src}»"
        else:
            # La colección dueña del id es lo que está ANTES del parámetro:
            # /projects/{id} → /projects, y también /contacts/{id}/opportunities
            # → /contacts (anidada: el id es del contacto, no de "opportunities").
            parent_path = tool["path_template"].split("/{" + name + "}")[0]
            list_tool = next((t for t in tools
                              if t["path_template"] == parent_path and t["id"] != tool["id"]), None)
            if list_tool is None:
                # Muchas APIs no exponen la colección pelada sino variantes:
                # /movie/{id} sin /movie pero con /movie/popular o /movie/top_rated.
                # Cualquier GET sin parámetros de path bajo el mismo prefijo lista
                # recursos de esa colección — sus ids sirven. La más corta primero
                # (la más cercana a "la lista canónica").
                candidatos = sorted(
                    (t for t in tools
                     if t["id"] != tool["id"] and "{" not in t["path_template"]
                     and t["http_method"].upper() == "GET"
                     and t["path_template"].startswith(parent_path + "/")),
                    key=lambda t: len(t["path_template"]),
                )
                list_tool = candidatos[0] if candidatos else None
            faltante_hint = f"una operación de listado bajo {parent_path}"

        if list_tool is None:
            return None, [], (f"Esta operación necesita un «{name}» y no encontré "
                              f"{faltante_hint} para conseguir un valor real. "
                              f"Cargá esa operación, o probá poniendo un {name} a mano.")

        # La lista intermedia puede necesitar sus propios params → recursión acotada.
        list_params: dict = {}
        if _depth < 2:
            sub, _sub_autos, sub_err = await _autofill_resource_ids(
                conn, list_tool, tools, tenant_id, connector_id, identity, {}, _depth + 1)
            if sub_err is not None:
                return None, [], (f"Para conseguir un «{name}» real necesitábamos "
                                  f"“{list_tool['display_name']}”, pero: {sub_err}")
            list_params = sub or {}

        lr = await _dry_run_tool(conn, list_tool, tenant_id, connector_id, identity, list_params)
        if not lr.get("ok"):
            reason = lr.get("detail") or lr.get("error") or f"HTTP {lr.get('status')}"
            return None, [], (f"Para conseguir un «{name}» real llamamos primero a "
                              f"“{list_tool['display_name']}”, pero esa llamada falló: {reason}")
        items = summarize_result(lr.get("raw"))
        if not items:
            return None, [], (f"“{list_tool['display_name']}” respondió pero sin elementos con id — "
                              f"no hay un «{name}» real para probar. Cargá datos en el sistema "
                              f"del proveedor o probá con un {name} a mano.")
        filled[name] = items[0]["id"]
        autos.append({"param": name, "value": items[0]["id"],
                      "label": items[0].get("label"), "from": list_tool["display_name"]})
    return filled, autos, None


async def _maybe_apply_suggested_map(tenant_id: str, tool: dict, result: dict) -> None:
    """Prueba OK + tool sin mapeo + heurística con sugerencia → se aplica sola
    (es exactamente lo que el admin hacía con el botón). El preview `mapped` del
    resultado se recalcula con el mapa recién aplicado para que lo que se muestra
    sea lo que va a pasar en runtime."""
    if not (result.get("ok") and not (tool.get("response_map") or {})
            and result.get("suggested_response_map")):
        return
    suggestion = result["suggested_response_map"]
    try:
        if await dao.update_tool(tenant_id, tool["id"], {"response_map": suggestion}):
            result["response_map_applied"] = True
            raw = result.get("raw")
            if raw is not None and not isinstance(raw, str):
                from services.connector_executor import _apply_response_map
                mapped = _apply_response_map(raw, suggestion)
                result["mapped"] = {"outcome": mapped.outcome, "data": mapped.data}
    except Exception as exc:  # noqa: BLE001 — la prueba vale aunque no se aplique
        logger.warning("auto_response_map_failed tool=%s error=%s", tool["id"], exc)


# Claves que suelen llevar el mensaje humano en cuerpos de error. No es una lista
# de proveedores: es el patrón de nombre — cubre message, status_message, msg,
# error, errors[], error_description, detail, reason... de cualquier API.
_MSG_KEY_RE = re.compile(r"message|msg|error|detail|reason|description", re.IGNORECASE)


def _upstream_message(raw, _depth: int = 0) -> str | None:
    """Mensaje humano del cuerpo de error del proveedor, sin asumir su formato:
    busca recursivamente (profundidad ≤ 2) el primer string no vacío bajo una
    clave que suene a mensaje. Es exactamente lo que el admin necesita ver para
    corregir la operación."""
    if isinstance(raw, str):
        return raw.strip()[:200] or None
    if _depth > 2:
        return None
    if isinstance(raw, list):
        for item in raw[:5]:
            if (m := _upstream_message(item, _depth + 1)):
                return m
        return None
    if not isinstance(raw, dict):
        return None
    for key, value in raw.items():
        if _MSG_KEY_RE.search(str(key)) and (m := _upstream_message(value, _depth + 1)):
            return m
    return None


def _test_detail(result: dict) -> str | None:
    """Resumen corto del fallo para persistir junto al estado (rojo en la UI)."""
    if result.get("ok"):
        return None
    if result.get("error") in ("resource_id_unavailable", "params_missing"):
        return (result.get("detail") or "")[:300]  # ya es descriptivo, sin código interno
    if result.get("error"):
        return f"{result['error']}: {result.get('detail', '')}"[:300]
    msg = _upstream_message(result.get("raw"))
    status = f"HTTP {result.get('status')}"
    return f"{status} — {msg}"[:300] if msg else status


async def _learn_examples_from_test(tenant_id: str, tool: dict, params: dict) -> None:
    """Guarda como x-example los valores tipeados en una prueba individual que
    salió OK, solo en params declarados que aún no tenían ejemplo (nunca pisa,
    nunca en ids de recurso). Best-effort: si falla, la prueba vale igual."""
    schema = dict(tool.get("params_schema") or {})
    props = schema.get("properties") or {}
    changed = False
    for name, val in (params or {}).items():
        prop = props.get(name)
        if prop is None or prop.get("x-resource-id") or "x-example" in prop:
            continue
        if val is None or not str(val).strip():
            continue
        prop["x-example"] = val
        changed = True
    if changed:
        try:
            await dao.update_tool(tenant_id, tool["id"], {"params_schema": schema})
        except Exception as exc:  # noqa: BLE001
            logger.warning("learn_example_failed tool=%s error=%s", tool["id"], exc)


async def _persist_test(tenant_id: str, tool_id: str, result: dict) -> None:
    # "Falta un parámetro" NO es una falla del proveedor (nunca lo llamamos):
    # no pisa el último estado conocido — la operación queda como estaba.
    if result.get("error") == "params_missing":
        return
    try:
        await dao.record_tool_test(tenant_id, tool_id, bool(result.get("ok")), _test_detail(result))
    except Exception as exc:  # noqa: BLE001 — el resultado de la prueba vale igual
        logger.warning("record_tool_test_failed tool=%s error=%s", tool_id, exc)


@router.post("/admin/connectors/{connector_id}/tools/{tool_id}/test")
async def test_tool(
    connector_id: str, tool_id: str, body: TestIn, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Dry-run real de UNA operación. Funciona con el conector INACTIVO a
    propósito: probar es parte de configurar (D2/D3). Persiste el resultado
    para que la lista muestre el estado (probada/falló/sin probar)."""
    tenant_id = _own_tenant(current_user)
    conn = await dao.get_connector(tenant_id, connector_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="Conector no encontrado")
    tools = await dao.list_tools(tenant_id, connector_id)
    tool = next((t for t in tools if t["id"] == tool_id), None)
    if tool is None:
        raise HTTPException(status_code=404, detail="Tool no encontrada")

    # Recorrido automático: si falta un id de recurso, lo conseguimos nosotros
    # llamando a la lista hermana — el admin no tiene que saber ningún id.
    filled, autos, err = await _autofill_resource_ids(
        conn, tool, tools, tenant_id, connector_id, body.identity, body.params)
    if err is not None:
        result = {"url": None, "method": tool["http_method"], "ok": False,
                  "error": "resource_id_unavailable", "detail": err}
    else:
        result = await _dry_run_tool(conn, tool, tenant_id, connector_id, body.identity, filled)
        if autos:
            result["auto_filled"] = autos
        await _maybe_apply_suggested_map(tenant_id, tool, result)
        if result.get("ok"):
            # Aprendizaje del uso: los valores que el admin tipeó y funcionaron
            # quedan como x-example de los params que no tenían — la próxima
            # «Probar todas» ya no depende de que alguien recuerde un valor.
            await _learn_examples_from_test(tenant_id, tool, body.params)
    await _persist_test(tenant_id, tool_id, result)
    _audit(request, current_user, "connector_tool_tested", f"{connector_id}/{tool['slug']}",
           {"ok": result.get("ok"), "status": result.get("status")})
    return result


@router.post("/admin/connectors/{connector_id}/tools/test-all")
async def test_all_tools(
    connector_id: str, body: TestIn, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Prueba TODAS las operaciones del conector de una pasada y persiste el
    estado de cada una. Las que necesitan {identity} usan body.identity; si no
    vino, quedan como 'skipped' (sin tocar su último estado). Concurrencia
    acotada para no clavar al proveedor."""
    tenant_id = _own_tenant(current_user)
    conn = await dao.get_connector(tenant_id, connector_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="Conector no encontrado")
    tools = await dao.list_tools(tenant_id, connector_id)

    sem = asyncio.Semaphore(4)

    async def run_one(tool: dict) -> dict:
        base = {"tool_id": tool["id"], "slug": tool["slug"], "display_name": tool["display_name"]}
        if "{identity}" in tool["path_template"] and not body.identity.strip():
            return {**base, "skipped": True, "ok": None,
                    "detail": "necesita un identificador de prueba"}
        async with sem:
            # Recorrido automático: los ids de recurso salen de la lista hermana.
            filled, autos, err = await _autofill_resource_ids(
                conn, tool, tools, tenant_id, connector_id, body.identity, body.params)
            if err is not None:
                result = {"ok": False, "error": "resource_id_unavailable", "detail": err}
            else:
                result = await _dry_run_tool(conn, tool, tenant_id, connector_id,
                                             body.identity, filled)
                await _maybe_apply_suggested_map(tenant_id, tool, result)
        if result.get("error") == "params_missing":
            # Sin datos para probarla (requerido sin valor ni ejemplo): queda
            # "sin probar", no "Falló" — el proveedor nunca fue llamado.
            return {**base, "skipped": True, "ok": None,
                    "detail": result.get("detail") or "sin datos para probar"}
        await _persist_test(tenant_id, tool["id"], result)
        out = {**base, "skipped": False, "ok": bool(result.get("ok")),
               "status": result.get("status"), "error": result.get("error"),
               "detail": _test_detail(result), "latency_ms": result.get("latency_ms")}
        if err is None and autos:
            out["auto_filled"] = autos
        return out

    results = await asyncio.gather(*(run_one(t) for t in tools))
    summary = {
        "total": len(results),
        "ok": sum(1 for r in results if r["ok"] is True),
        "failed": sum(1 for r in results if r["ok"] is False),
        "skipped": sum(1 for r in results if r["skipped"]),
    }
    _audit(request, current_user, "connector_tools_tested_all", connector_id, summary)
    return {"results": list(results), **summary}
