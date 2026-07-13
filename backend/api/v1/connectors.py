"""Administración de conectores de terceros (pantalla /admin/connectors).

Materializa la Fase 1 de docs/PANTALLA_CONECTORES_PLAN.md: CRUD de la config
que el executor genérico interpreta (tenant_connectors / connector_tools /
connector_roles / connector_intent_bindings), más:

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

import logging
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.audit import record as audit, fire_and_log
from core.config import settings
from core.egress_guard import EgressBlocked, assert_egress_allowed
from core.security import CurrentUser, require_admin_or_super, require_super_admin
from services import connectors_dao as dao
from services.connector_secrets import SUPPORTED_AUTH_TYPES, build_auth, open_secret, seal_secret

logger = logging.getLogger(__name__)
router = APIRouter()

_HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
_IDENTITY_KINDS = {"publico", "afiliado", "profesional"}


def _own_tenant(current_user: CurrentUser) -> str:
    if not current_user.tenant_id or current_user.tenant_id == "__platform__":
        raise HTTPException(status_code=400, detail="No tenant context")
    return current_user.tenant_id


def _audit(request: Request, user: CurrentUser, action: str, resource: str, detail: dict | None = None):
    fire_and_log(audit(
        tenant_id=user.tenant_id or "__platform__", actor_id=user.user_id,
        actor_email=user.email, actor_role=user.role.value,
        action=action, resource=resource, detail=detail, request=request,
    ), context="connectors.admin")


# ── Schemas ───────────────────────────────────────────────────────────────────

class ConnectorIn(BaseModel):
    slug: str = Field(min_length=2, max_length=60, pattern=r"^[a-z0-9_\-]+$")
    display_name: str = Field(min_length=2, max_length=120)
    base_url: str = Field(min_length=8, max_length=300)
    egress_allow: list[str] = Field(default_factory=list)
    auth_type: str = "none"
    auth_config: dict = Field(default_factory=dict)
    auth_validate_path: str | None = None
    timeout_ms: int = Field(default=4000, ge=500, le=30000)


class ConnectorUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=2, max_length=120)
    base_url: str | None = Field(default=None, min_length=8, max_length=300)
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
    http_method: str = "GET"
    path_template: str = Field(min_length=1, max_length=300)
    params_schema: dict = Field(default_factory=dict)
    response_map: dict = Field(default_factory=dict)
    identity_kind: str = "publico"
    is_read_only: bool = True
    roles: list[str] = Field(default_factory=list)


class ToolUpdate(BaseModel):
    display_name: str | None = None
    http_method: str | None = None
    path_template: str | None = None
    params_schema: dict | None = None
    response_map: dict | None = None
    identity_kind: str | None = None
    is_active: bool | None = None
    roles: list[str] | None = None


class BindingIn(BaseModel):
    # O bien una intención existente por id, o crear/reusar por label.
    intencion_id: str | None = None
    intent_label: str | None = Field(default=None, min_length=3, max_length=80)
    intent_description: str | None = None
    min_confidence: float = Field(default=0.70, ge=0.0, le=1.0)
    is_active: bool = True
    examples: list[str] = Field(default_factory=list, max_length=30)


class TestIn(BaseModel):
    identity: str = Field(default="", max_length=40)   # valor de prueba para {identity}
    params: dict = Field(default_factory=dict)


class HostIn(BaseModel):
    host: str = Field(min_length=3, max_length=200)
    note: str | None = None


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

@router.get("/admin/connectors")
async def list_connectors(current_user: CurrentUser = Depends(require_admin_or_super)):
    tenant_id = _own_tenant(current_user)
    return {"connectors": await dao.list_connectors(tenant_id)}


@router.post("/admin/connectors", status_code=201)
async def create_connector(
    body: ConnectorIn, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    tenant_id = _own_tenant(current_user)
    _validate_connector_payload(body.auth_type)
    data = body.model_dump()
    data["egress_allow"] = [h.strip().lower() for h in data["egress_allow"] if h.strip()]
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
    for t in conn["tools"]:
        t["bindings"] = await dao.list_bindings(tenant_id, t["id"])
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
    if not await dao.update_connector(tenant_id, connector_id, data):
        raise HTTPException(status_code=404, detail="Conector no encontrado")
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
    _audit(request, current_user, "connector_secret_set", connector_id)
    return {"ok": True, "has_secret": True}


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
        trusted = settings.trusted_internal_hosts_set
        pending = []
        for host in conn["egress_allow"]:
            if host in trusted:
                continue
            if not await dao.is_host_approved(host):
                pending.append(host)
        if pending:
            raise HTTPException(
                status_code=403,
                detail=f"Hosts pendientes de aprobación por el super-admin: {', '.join(pending)}. "
                       f"El conector queda configurado; podés probarlo, pero no activarlo aún.",
            )
        if not conn["egress_allow"]:
            raise HTTPException(status_code=422, detail="El conector no tiene hosts en egress_allow")

    await dao.set_connector_active(tenant_id, connector_id, body.is_active)
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


# ── Bindings intención → tool ─────────────────────────────────────────────────

@router.put("/admin/connectors/tools/{tool_id}/bindings")
async def upsert_binding(
    tool_id: str, body: BindingIn, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Vincula una intención a la tool. Si viene intent_label y no existe, crea la
    intención. Si vienen examples, los siembra en PG + Qdrant para que el
    clasificador dispare la tool (sin esto el binding existe pero nunca matchea)."""
    from sqlalchemy import text
    from core.database import get_pg_session

    tenant_id = _own_tenant(current_user)

    intencion_id = body.intencion_id
    label = body.intent_label
    if not intencion_id and not label:
        raise HTTPException(status_code=422, detail="Falta intencion_id o intent_label")

    async with get_pg_session(tenant_id) as session:
        if not intencion_id:
            intencion_id = (await session.execute(text("""
                INSERT INTO intenciones (label, description, is_active)
                VALUES (:l, :d, TRUE)
                ON CONFLICT (label) DO UPDATE SET is_active = TRUE
                RETURNING id::text
            """), {"l": label, "d": body.intent_description or f"Dispara la tool ({label})"})).scalar()
        else:
            row = (await session.execute(text(
                "SELECT label FROM intenciones WHERE id = CAST(:i AS uuid)"
            ), {"i": intencion_id})).first()
            if row is None:
                raise HTTPException(status_code=404, detail="Intención no encontrada")
            label = row[0]

        if body.examples:
            from services.intent_examples import insert_examples
            await insert_examples(session, intencion_id, body.examples)
        await session.commit()

    if body.examples:
        # Indexar en Qdrant con la misma maquinaria del retrain (embeddings reales).
        import uuid as _uuid
        from services.classifier_trainer import _embed_and_upsert
        examples = [{"question_text": t, "label": label, "intencion_id": intencion_id,
                     "example_id": str(_uuid.uuid4())} for t in body.examples if t.strip()]
        try:
            await _embed_and_upsert(tenant_id, examples, "ui-seed")
        except Exception as exc:
            logger.warning("binding_examples_index_failed tenant=%s error=%s", tenant_id, exc)

    bid = await dao.upsert_binding(tenant_id, tool_id, intencion_id, body.min_confidence, body.is_active)
    _audit(request, current_user, "connector_binding_upserted", f"{tool_id}→{label}",
           {"examples": len(body.examples)})
    return {"id": bid, "intencion_id": intencion_id, "intent_label": label}


@router.delete("/admin/connectors/bindings/{binding_id}")
async def delete_binding(
    binding_id: str, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    tenant_id = _own_tenant(current_user)
    if not await dao.delete_binding(tenant_id, binding_id):
        raise HTTPException(status_code=404, detail="Binding no encontrado")
    _audit(request, current_user, "connector_binding_deleted", binding_id)
    return {"ok": True}


# ── Conexión automática: descubrir + aplicar (wizard con IA) ──────────────────

class DiscoverIn(BaseModel):
    test_identity: str = Field(default="", max_length=40)


class ApplyToolIn(BaseModel):
    slug: str
    display_name: str
    http_method: str = "GET"
    path_template: str
    params_schema: dict = Field(default_factory=dict)
    response_map: dict = Field(default_factory=dict)
    identity_kind: str = "publico"
    is_lookup: bool = False
    intent_label: str | None = None
    intent_description: str | None = None
    examples: list[str] = Field(default_factory=list, max_length=30)


class ApplyIn(BaseModel):
    tools: list[ApplyToolIn]


async def _bind_intent_with_examples(tenant_id: str, tool_id: str, label: str,
                                     description: str | None, examples: list[str]) -> None:
    """Crea/reusa la intención, siembra ejemplos (PG + Qdrant) y bindea la tool."""
    from sqlalchemy import text
    from core.database import get_pg_session

    async with get_pg_session(tenant_id) as session:
        intencion_id = (await session.execute(text("""
            INSERT INTO intenciones (label, description, is_active)
            VALUES (:l, :d, TRUE)
            ON CONFLICT (label) DO UPDATE SET is_active = TRUE
            RETURNING id::text
        """), {"l": label, "d": description or f"Dispara la tool ({label})"})).scalar()
        if examples:
            from services.intent_examples import insert_examples
            await insert_examples(session, intencion_id, examples)
        await session.commit()

    if examples:
        import uuid as _uuid
        from services.classifier_trainer import _embed_and_upsert
        rows = [{"question_text": t, "label": label, "intencion_id": intencion_id,
                 "example_id": str(_uuid.uuid4())} for t in examples if t.strip()]
        try:
            await _embed_and_upsert(tenant_id, rows, "auto-discovery")
        except Exception as exc:
            logger.warning("discovery_examples_index_failed tenant=%s error=%s", tenant_id, exc)

    await dao.upsert_binding(tenant_id, tool_id, intencion_id, 0.70, True)


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


@router.post("/admin/connectors/{connector_id}/apply")
async def apply_proposal(
    connector_id: str, body: ApplyIn, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Crea en bloque las tools confirmadas por el admin (+roles, intenciones,
    ejemplos y bindings). Si hay ruta de perfil (is_lookup), configura el OTP
    propio automáticamente. El conector NO se activa: eso sigue siendo un clic
    explícito del admin."""
    tenant_id = _own_tenant(current_user)
    conn = await dao.get_connector(tenant_id, connector_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="Conector no encontrado")

    created, lookup_path = [], None
    for t in body.tools:
        _validate_tool_payload(t.http_method, t.identity_kind, t.path_template)
        if t.is_lookup:
            lookup_path = t.path_template
            continue  # el perfil no es una tool de chat: solo config del OTP
        data = t.model_dump(exclude={"is_lookup", "intent_label", "intent_description", "examples"})
        data["http_method"] = data["http_method"].upper()
        data["is_read_only"] = True
        try:
            tool_id = await dao.create_tool(tenant_id, connector_id, data)
        except Exception as exc:
            if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
                logger.info("apply_skip_duplicate slug=%s", t.slug)
                continue
            raise
        roles = ["afiliado"] if t.identity_kind != "publico" else ["publico", "afiliado"]
        await dao.set_tool_roles(tenant_id, tool_id, roles)
        await dao.update_tool(tenant_id, tool_id, {"is_active": True})
        if t.intent_label:
            await _bind_intent_with_examples(tenant_id, tool_id, t.intent_label,
                                             t.intent_description, t.examples)
        created.append(t.slug)

    if lookup_path:
        await dao.update_connector(tenant_id, connector_id, {"auth_config": {
            **(conn.get("auth_config") or {}),
            "identity_validation": "platform_otp",
            "identity_lookup_path": lookup_path,
        }})

    _audit(request, current_user, "connector_proposal_applied", connector_id,
           {"tools": created, "lookup": lookup_path})
    return {"created": created, "identity_lookup_path": lookup_path}


# ── Dry-run (el corazón de la pantalla) ───────────────────────────────────────

def _suggest_response_map(raw) -> dict:
    """Heurística sobre la respuesta real: si hay UNA lista → items_path; si hay
    un booleano tipo found/encontrado → not_found_field. La UI la ofrece con un clic."""
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


@router.post("/admin/connectors/{connector_id}/tools/{tool_id}/test")
async def test_tool(
    connector_id: str, tool_id: str, body: TestIn, request: Request,
    current_user: CurrentUser = Depends(require_admin_or_super),
):
    """Dry-run real: arma la URL final, valida egress, llama al tercero y muestra
    crudo + mapeado + sugerencia de response_map. Funciona con el conector
    INACTIVO a propósito: probar es parte de configurar (D2/D3)."""
    from services.connector_executor import _apply_response_map, _build_path

    tenant_id = _own_tenant(current_user)
    conn = await dao.get_connector(tenant_id, connector_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="Conector no encontrado")
    tool = next((t for t in await dao.list_tools(tenant_id, connector_id) if t["id"] == tool_id), None)
    if tool is None:
        raise HTTPException(status_code=404, detail="Tool no encontrada")

    path, query = _build_path(tool["path_template"], body.identity, dict(body.params))
    url = conn["base_url"].rstrip("/") + "/" + path.lstrip("/")
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

    try:
        secret = open_secret(await dao.get_connector_secret_enc(tenant_id, connector_id))
        auth_kwargs = build_auth(conn["auth_type"], conn.get("auth_config") or {}, secret)
    except ValueError as exc:
        result.update(ok=False, error="auth_config_invalid", detail=str(exc))
        return result

    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=conn["timeout_ms"] / 1000) as client:
            resp = await client.request(
                tool["http_method"].upper(), url, params=query or None,
                headers=auth_kwargs["headers"] or None, auth=auth_kwargs["auth"],
            )
        latency = int((time.monotonic() - start) * 1000)
        raw = resp.json() if "json" in (resp.headers.get("content-type") or "") else resp.text[:2000]
        result.update(ok=resp.status_code < 400, status=resp.status_code, latency_ms=latency, raw=raw)
        if resp.status_code < 400 and not isinstance(raw, str):
            mapped = _apply_response_map(raw, tool["response_map"])
            result["mapped"] = {"outcome": mapped.outcome, "data": mapped.data}
            result["suggested_response_map"] = _suggest_response_map(raw)
    except httpx.HTTPError as exc:
        result.update(ok=False, error="upstream", detail=str(exc)[:300],
                      latency_ms=int((time.monotonic() - start) * 1000))

    _audit(request, current_user, "connector_tool_tested", f"{connector_id}/{tool['slug']}",
           {"ok": result.get("ok"), "status": result.get("status")})
    return result
