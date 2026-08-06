"""Regresión del INSERT de auto-asignación de personalidades (bug de galo, 2026-08-03).

El bug no era de lógica: la sentencia reusaba el mismo placeholder con dos tipos
deducidos distintos (varchar en el VALUES, text en el "=" del NOT EXISTS) y
asyncpg fallaba al PREPARARLA con AmbiguousParameterError. `provision_tenant` ya
había terminado, así que el tenant quedaba creado, activo y sin ninguna
personalidad — el panel mostraba "Sin personalidades disponibles".

Ningún mock detecta esto: el error ocurre en Postgres, al preparar. Por eso el
test hace PREPARE de verdad. No inserta ni modifica nada, y se saltea si no hay
Postgres a mano (fuera del contenedor).
"""

import re

import pytest
from sqlalchemy import text

from api.v1.system_prompts import AUTO_ASSIGN_SQL


def _a_placeholders_posicionales(sql: str) -> str:
    """:tid/:tmpl → $1/$2, que es lo que PREPARE entiende."""
    return sql.replace(":tid", "$1").replace(":tmpl", "$2")


def test_sin_placeholders_sin_castear():
    """Guard barato: todo :tid del SQL va dentro de un CAST explícito.

    Corre siempre (no necesita Postgres). Si alguien saca un CAST, esto salta
    antes que el PREPARE de abajo, que puede estar saltado por falta de DB.
    """
    sin_cast = re.sub(r"CAST\(:tid AS \w+\)", "", AUTO_ASSIGN_SQL)
    assert ":tid" not in sin_cast, "cada :tid debe ir casteado — ver AmbiguousParameterError"


@pytest.mark.asyncio
async def test_postgres_prepara_la_sentencia():
    """PREPARE real: reproduce el fallo exacto si vuelve la ambigüedad de tipos."""
    from core.database import get_pg_session

    sql = _a_placeholders_posicionales(AUTO_ASSIGN_SQL)
    try:
        async with get_pg_session(None) as session:
            await session.execute(text(f"PREPARE _test_auto_assign AS {sql}"))
            tipos = (await session.execute(text(
                "SELECT parameter_types::text FROM pg_prepared_statements WHERE name = '_test_auto_assign'"
            ))).scalar()
            await session.execute(text("DEALLOCATE _test_auto_assign"))
    except Exception as exc:
        if "AmbiguousParameter" in type(exc).__name__ or "inconsistent types deduced" in str(exc):
            pytest.fail(f"la sentencia volvió a ser ambigua para Postgres: {exc}")
        pytest.skip(f"sin Postgres disponible: {exc}")

    # $1 = tenant_id (varchar), $2 = template_id (uuid)
    assert "character varying" in tipos and "uuid" in tipos, tipos
