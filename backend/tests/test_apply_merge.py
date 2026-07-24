"""Re-detección segura (apply_proposal): una operación cuya RUTA ya existe se
conserva intacta (no se recrea) — así re-detectar no borra los ejemplos,
descripciones y params que el admin curó a mano. Rutas nuevas sí se crean."""

import pytest

from api.v1.connectors import ApplyIn, ApplyToolIn, apply_proposal
from core.security import Role


class _User:
    user_id = "admin"
    tenant_id = "t1"
    email = "admin@t1.com"
    role = Role.ADMIN


class _Req:
    headers: dict = {}
    client = None


@pytest.fixture
def daomock(monkeypatch):
    """DAO en memoria: una tool ya cargada en /projects (con ejemplos curados)."""
    state = {
        "tools": [{
            "id": "tool-1", "slug": "lista_proyectos", "http_method": "GET",
            "path_template": "/api/projects", "examples": ["¿qué proyectos hay?"],
            "description": "curada a mano", "identity_kind": "publico",
        }],
        "created": [], "roles_set": [], "activated": [],
    }

    async def get_connector(tid, cid):
        return {"id": cid, "display_name": "C", "base_url": "https://x", "auth_config": {}}

    async def list_tools(tid, cid):
        return state["tools"]

    async def create_tool(tid, cid, data):
        new_id = f"tool-{len(state['tools']) + 1}"
        state["tools"].append({**data, "id": new_id})
        state["created"].append(data["slug"])
        return new_id

    async def set_tool_roles(tid, tool_id, roles):
        state["roles_set"].append((tool_id, roles))

    async def update_tool(tid, tool_id, data):
        state["activated"].append((tool_id, data))
        return True

    async def update_connector(tid, cid, data):
        return True

    import api.v1.connectors as mod
    for name, fn in [("get_connector", get_connector), ("list_tools", list_tools),
                     ("create_tool", create_tool), ("set_tool_roles", set_tool_roles),
                     ("update_tool", update_tool), ("update_connector", update_connector)]:
        monkeypatch.setattr(mod.dao, name, fn)
    monkeypatch.setattr(mod, "_audit", lambda *a, **k: None)
    return state


@pytest.mark.asyncio
async def test_reaplicar_conserva_ruta_existente(daomock):
    """La MISMA ruta con OTRO slug (la IA cambia el nombre entre corridas) se
    conserva — no se recrea ni se duplica. Los ejemplos sobreviven."""
    body = ApplyIn(tools=[ApplyToolIn(
        slug="projects",  # slug distinto al existente 'lista_proyectos'
        display_name="Projects", http_method="GET",
        path_template="/api/projects", identity_kind="publico")])
    res = await apply_proposal("c1", body, _Req(), _User())
    assert res["created"] == []
    assert res["kept"] == ["projects"]
    # La tool original sigue una sola, intacta, con sus ejemplos.
    projs = [t for t in daomock["tools"] if t["path_template"] == "/api/projects"]
    assert len(projs) == 1
    assert projs[0]["examples"] == ["¿qué proyectos hay?"]


@pytest.mark.asyncio
async def test_reaplicar_crea_solo_las_rutas_nuevas(daomock):
    """Mezcla: ruta existente se conserva, ruta nueva se crea."""
    body = ApplyIn(tools=[
        ApplyToolIn(slug="projects", display_name="Projects", http_method="GET",
                    path_template="/api/projects", identity_kind="publico"),
        ApplyToolIn(slug="clientes", display_name="Clientes", http_method="GET",
                    path_template="/api/contacts", identity_kind="publico"),
    ])
    res = await apply_proposal("c1", body, _Req(), _User())
    assert res["kept"] == ["projects"]
    assert res["created"] == ["clientes"]
    assert len(daomock["tools"]) == 2  # 1 vieja + 1 nueva


@pytest.mark.asyncio
async def test_distinto_metodo_no_se_confunde(daomock):
    """Misma ruta pero distinto método = operación distinta → se crea."""
    body = ApplyIn(tools=[ApplyToolIn(
        slug="crear_proyecto", display_name="Crear", http_method="POST",
        path_template="/api/projects", identity_kind="publico")])
    res = await apply_proposal("c1", body, _Req(), _User())
    assert res["created"] == ["crear_proyecto"]
    assert res["kept"] == []
