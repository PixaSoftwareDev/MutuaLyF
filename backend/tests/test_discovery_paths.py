"""Tests de derivación de rutas del discovery: normalización de params y
vínculo lista↔detalle (incluye rutas anidadas /X/{id}/Y, cuyo id es de X)."""

from services.connector_discovery import (
    _build_tool_fields,
    _effective_identity_param,
    _list_sibling,
    _normalize_path_params,
)


def test_normaliza_estilo_express():
    assert _normalize_path_params("/api/projects/:id") == "/api/projects/{id}"
    assert _normalize_path_params("/api/contacts/:id/people") == "/api/contacts/{id}/people"
    assert _normalize_path_params("/api/projects/{id}") == "/api/projects/{id}"  # ya normalizada


def test_sibling_detalle_simple():
    cls = {"/api/projects": {"slug": "lista_proyectos", "include": True}}
    sib = _list_sibling("/api/projects/{id}", cls)
    assert sib and sib["slug"] == "lista_proyectos"


def test_sibling_ruta_anidada_apunta_a_la_coleccion_del_id():
    """/contacts/{id}/opportunities: el id es del CONTACTO → hermana = /contacts,
    no /contacts/opportunities (bug real: contact_opportunities fallaba al probar)."""
    cls = {"/api/contacts": {"slug": "contacts", "include": True}}
    sib = _list_sibling("/api/contacts/{id}/opportunities", cls)
    assert sib and sib["slug"] == "contacts"


def test_sibling_inexistente_devuelve_none():
    assert _list_sibling("/api/projects/{id}", {}) is None
    assert _list_sibling("/api/projects", {"/api": {"slug": "x", "include": True}}) is None


def test_build_tool_fields_ruta_anidada():
    """El {id} de una ruta anidada queda como parámetro x-resource-id requerido,
    con la lista dueña referenciada en la descripción."""
    route = {"path": "/api/contacts/:id/opportunities", "params": []}
    cls = {"identity_param": None}
    classified = {"/api/contacts": {"slug": "contacts", "include": True}}
    template, schema = _build_tool_fields(route, cls, classified)
    assert template == "/api/contacts/{id}/opportunities"
    prop = schema["properties"]["id"]
    assert prop["x-resource-id"] is True
    assert "contacts" in prop["description"]
    assert "id" in schema["required"]


def test_build_tool_fields_identity_no_es_resource():
    """El param de identidad de PERSONA sigue yendo a {identity}, nunca al schema."""
    route = {"path": "/api/afiliados/{dni}/ordenes", "params": [
        {"name": "dni", "in": "path", "required": True, "type": "string"},
    ]}
    cls = {"identity_param": "dni"}
    template, schema = _build_tool_fields(route, cls, {})
    assert template == "/api/afiliados/{identity}/ordenes"
    assert "dni" not in (schema.get("properties") or {})


def test_identity_param_pisado_si_hay_lista_duena():
    """Bug real (CRM Pixs): el proveedor llama '{identity}' a sus ids de recurso
    y el LLM los marcó como identidad de la persona. Con /documents presente,
    /documents/{identity} es un detalle → identity_param se anula."""
    classified = {"/api/documents": {"path": "/api/documents", "include": True}}
    cls = {"path": "/api/documents/{identity}", "identity_param": "identity"}
    assert _effective_identity_param(cls, classified) is None


def test_identity_param_respetado_si_nombre_es_de_persona():
    """Aunque exista una lista dueña, un nombre inequívoco de persona (dni,
    legajo...) se respeta: la protección de datos personales manda."""
    classified = {"/api/afiliados": {"path": "/api/afiliados", "include": True}}
    cls = {"path": "/api/afiliados/{dni}", "identity_param": "dni"}
    assert _effective_identity_param(cls, classified) == "dni"


def test_identity_param_respetado_sin_lista_duena():
    cls = {"path": "/api/perfil/{identity}", "identity_param": "identity"}
    assert _effective_identity_param(cls, {}) == "identity"


def test_identity_param_respetado_en_ruta_lookup():
    """La ruta de perfil (is_lookup) resuelve a la persona por SU identidad:
    la salvaguarda estructural no aplica aunque exista la lista."""
    classified = {"/api/contacts": {"path": "/api/contacts", "include": True}}
    cls = {"path": "/api/contacts/{identity}", "identity_param": "identity", "is_lookup": True}
    assert _effective_identity_param(cls, classified) == "identity"


def test_identity_param_query_no_aplica():
    """Identidad que viaja por query param (no path): la salvaguarda es solo
    para params de path — se respeta al LLM."""
    classified = {"/api/ordenes": {"path": "/api/ordenes", "include": True}}
    cls = {"path": "/api/ordenes", "identity_param": "nro"}
    assert _effective_identity_param(cls, classified) == "nro"
