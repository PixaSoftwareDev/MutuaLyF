"""Tests unitarios del executor: validación de params y response_map."""

import pytest

from services.connector_executor import (
    EMPTY, FORBIDDEN, OK, ParamValidationError,
    _apply_response_map, _build_path, validate_params,
)


# ── validate_params ────────────────────────────────────────────────────────────
def test_params_requerido_faltante():
    schema = {"type": "object", "properties": {"fecha": {"type": "string"}}, "required": ["fecha"]}
    with pytest.raises(ParamValidationError):
        validate_params({}, schema)


def test_params_descarta_claves_no_declaradas():
    schema = {"type": "object", "properties": {"fecha": {"type": "string"}}}
    out = validate_params({"fecha": "2026-07-12", "identity": "999", "hackeo": 1}, schema)
    assert out == {"fecha": "2026-07-12"}  # identity y hackeo NO pasan


def test_params_tipo_invalido():
    schema = {"type": "object", "properties": {"n": {"type": "integer"}}}
    with pytest.raises(ParamValidationError):
        validate_params({"n": "no soy número"}, schema)


def test_params_bool_no_cuenta_como_integer():
    schema = {"type": "object", "properties": {"n": {"type": "integer"}}}
    with pytest.raises(ParamValidationError):
        validate_params({"n": True}, schema)


def test_params_schema_vacio_no_pasa_nada():
    assert validate_params({"x": 1}, {}) == {}


# ── _build_path (identity server-side + placeholders) ──────────────────────────
def test_build_path_sustituye_identity_y_deja_resto_en_query():
    path, query = _build_path("/afiliados/{identity}/ordenes", "30111222", {"pagina": 2})
    assert path == "/afiliados/30111222/ordenes"
    assert query == {"pagina": 2}


def test_build_path_placeholder_de_param_en_path():
    path, query = _build_path("/prof/{identity}/agenda/{fecha}", "20304050607", {"fecha": "2026-07-12"})
    assert path == "/prof/20304050607/agenda/2026-07-12"
    assert query == {}  # fecha se consumió en el path


# ── _apply_response_map (contrato canónico) ────────────────────────────────────
def test_response_map_ok_con_items():
    rm = {"items_path": "ordenes", "empty_when_empty": True}
    res = _apply_response_map({"ordenes": [{"id": 1}]}, rm)
    assert res.outcome == OK and res.data == [{"id": 1}]


def test_response_map_empty_lista_vacia():
    rm = {"items_path": "ordenes", "empty_when_empty": True}
    res = _apply_response_map({"ordenes": []}, rm)
    assert res.outcome == EMPTY


def test_response_map_forbidden_por_not_found():
    rm = {"not_found_field": "encontrado", "not_found_value": False}
    res = _apply_response_map({"encontrado": False, "ordenes": []}, rm)
    assert res.outcome == FORBIDDEN


# ── detección de página parcial ────────────────────────────────────────────────
def test_parcial_por_total_heuristico():
    rm = {"items_path": "items"}
    res = _apply_response_map({"items": [{"id": 1}], "total": 40}, rm)
    assert res.detail == {"parcial": True, "traidos": 1, "total_declarado": 40}


def test_parcial_por_totalresults_estilo_newsapi():
    rm = {"items_path": "articles"}
    res = _apply_response_map({"articles": [{"t": "a"}, {"t": "b"}], "totalResults": 120}, rm)
    assert res.detail == {"parcial": True, "traidos": 2, "total_declarado": 120}


def test_parcial_por_has_more_sin_total():
    rm = {"items_path": "items"}
    res = _apply_response_map({"items": [{"id": 1}], "has_more": True}, rm)
    assert res.detail == {"parcial": True, "traidos": 1}
    assert "total_declarado" not in res.detail


def test_completo_sin_marcadores():
    res = _apply_response_map({"items": [{"id": 1}], "total": 1}, {"items_path": "items"})
    assert res.outcome == OK and res.detail == {}


def test_total_path_configurado_parcial():
    rm = {"items_path": "data.rows", "total_path": "meta.paging.grand_total"}
    raw = {"data": {"rows": [{"id": 1}]}, "meta": {"paging": {"grand_total": 99}}}
    res = _apply_response_map(raw, rm)
    assert res.detail == {"parcial": True, "traidos": 1, "total_declarado": 99}


def test_total_path_gana_sobre_heuristica():
    # total_path dice completo (1 == 1) aunque un campo 'total' heurístico
    # diga otra cosa: la config explícita es autoritativa.
    rm = {"items_path": "rows", "total_path": "verdadero_total"}
    raw = {"rows": [{"id": 1}], "verdadero_total": 1, "total": 500}
    res = _apply_response_map(raw, rm)
    assert res.outcome == OK and res.detail == {}


def test_total_path_no_resuelve_cae_a_heuristica():
    rm = {"items_path": "rows", "total_path": "meta.no.existe"}
    raw = {"rows": [{"id": 1}], "total": 7}
    res = _apply_response_map(raw, rm)
    assert res.detail == {"parcial": True, "traidos": 1, "total_declarado": 7}


def test_total_path_bool_no_cuenta_como_total():
    # True es int en Python: un total_path que apunta a un booleano no debe
    # decidir nada — cae a la heurística.
    rm = {"items_path": "rows", "total_path": "ok"}
    raw = {"rows": [{"id": 1}], "ok": True, "total": 9}
    res = _apply_response_map(raw, rm)
    assert res.detail == {"parcial": True, "traidos": 1, "total_declarado": 9}
