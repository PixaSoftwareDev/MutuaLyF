"""Data flywheel — normalización de consultas para dedup de candidatos.

El ciclo completo (capture → aprobar → examples → dismiss) es SQL directo y se
verifica en vivo contra la DB; acá se cubre la lógica pura de normalización y,
en test_connector_loop.py, que el loop capture con el binding inicial en su
primer OK (el bug del return temprano que se corrigió)."""

from services import connectors_dao as dao


def test_norm_query_dedup():
    # Distinto caso y puntuación de borde → misma forma normalizada (dedup real).
    assert dao._norm_query("¿Cuánto nos DEBE?") == dao._norm_query("cuánto nos debe")
    assert dao._norm_query("  hola   MUNDO  ") == "hola mundo"
    assert dao._norm_query("¿cómo venimos con la guita?") == "cómo venimos con la guita"
    # Conservadora: NO quita acentos internos (formas con/sin tilde no se funden).
    assert dao._norm_query("cuánto") != dao._norm_query("cuanto")


def test_norm_query_corta_se_ignora():
    # La captura descarta consultas de menos de 8 chars normalizados.
    assert len(dao._norm_query("hola")) < 8
    assert len(dao._norm_query("¿qué?")) < 8
    assert len(dao._norm_query("mostrame las tareas")) >= 8
