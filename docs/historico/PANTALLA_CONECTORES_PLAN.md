# Plan — Pantalla de Conectores (autogestión de APIs de terceros)

> Estado (2026-07-27): **CONSTRUIDA** — `/admin/connectors` operativa con alta,
> detección de operaciones, prueba en vivo, estados y flywheel de ejemplos.
> Visible en dev/staging; **oculta en prod por flag** (`NEXT_PUBLIC_CONNECTORS_UI`
> + `CONNECTORS_ENABLED`, ver CLAUDE.md) hasta validar la feature.
> Este doc queda como registro de diseño de lo implementado.
> Convierte lo que hoy es un script SQL (`scripts/seed_mock_nexa.py`) en una pantalla
> `/admin/connectors` donde un admin da de alta un conector, sus operaciones, quién las
> usa y qué intención las dispara — y lo **prueba en vivo** antes de activarlo.

## Punto de partida (lo que ya existe)

- **Tablas** (migración 031): `tenant_connectors`, `connector_tools`, `connector_roles`,
  `connector_intent_bindings`, `tool_call_audit`. El modelo de datos ya está.
- **Ejecutor**: `services/connector_executor.py` interpreta la config y llama al tercero
  (egress guard anti-SSRF, circuit breaker, `response_map`).
- **DAO**: `services/connectors_dao.py` **solo lee** (`get_tool_for_intent`) → falta el CRUD.
- **Reusable**: `require_admin` (RBAC), `core.crypto` (`encrypt_secret`/`decrypt_secret`,
  Fernet), patrón de páginas admin (React Query + `lib/api.ts`), sidebar declarativo.

## Los 3 huecos a cerrar

1. **CRUD** de las 4 tablas (backend + frontend) — no existe.
2. **Auth real**: hoy `_invoke_http` no adjunta credenciales (solo `none`/`stub`).
3. **Usabilidad de `params_schema`/`response_map`**: JSON técnico → sin "Probar" y validación
   un no-dev no lo completa bien.

---

## Decisiones fijadas (2026-07-13)

### D1 — Secretos: **Fernet cifrado en DB**, detrás de `resolve_connector_secret()`
Consistente con las sesiones de conectores (ya usan `core.crypto`); cero infra nueva;
proporcional a <500 tenants. Encapsulado tras una función para poder migrar a un
secrets-manager externo sin tocar schema ni UI.
**Invariante:** la clave Fernet vive FUERA de la DB (secrets del deploy); ya validado en
prod por `config._assert_production_secrets_safe`.

### D2 — Gobierno: **híbrido, admin configura / super-admin gatea hosts externos**
- El **admin del tenant** crea, edita y prueba conectores mientras están **inactivos**.
- **Activar** un conector hacia un **host nuevo** exige que el host esté en una allowlist
  aprobada por super-admin. Aprobado una vez, el admin prende/apaga sin fricción.
Racional: el riesgo no está en configurar (borrador inofensivo) sino en salir a producción
contra un host externo (SSRF/exfiltración/credenciales). Ese límite ya lo defiende
`egress_allow`; el super-admin solo controla la superficie de riesgo (qué hosts), no el resto.

### D3 — `params_schema`/`response_map`: **editor JSON validado en MVP**, builder en Fase 2
La palanca de usabilidad es el botón **"Probar"** (dry-run real), no el builder. Se agrega
auto-sugerencia del `response_map` a partir de la respuesta de prueba. El builder guiado se
construye en Fase 2, cuando el uso real muestre qué patrones dominan.

---

## Fase 1 — MVP funcional (cubre la mayoría de APIs REST) · ~5–8 días

### Backend
- **Migración 032**: en `tenant_connectors` agregar `auth_config JSONB` (header name,
  token_url/scopes OAuth…), `auth_secret_enc TEXT` (Fernet), `auth_validate_path TEXT`
  (endpoint de validación de identidad, hoy hardcodeado como convención).
  - Allowlist global de hosts aprobados (D2): tabla global `approved_connector_hosts`
    (host, approved_by, created_at) o columna en `public.tenants`. → definir en implementación.
- **`services/connectors_dao.py`**: CRUD completo (list/get/create/update/delete de conector,
  tool, role, binding), tenant-scoped vía `search_path`.
- **`services/connector_secrets.py`**: `resolve_connector_secret(connector)` +
  `store_connector_secret(...)` sobre `core.crypto`.
- **`api/v1/connectors.py`** (router nuevo, todo `Depends(require_admin)`):
  - CRUD de los 4 objetos.
  - `POST /connectors/{id}/test` — **dry-run**: valida egress, arma la ruta con identidad/params
    de prueba, llama al tercero, devuelve *URL final + respuesta cruda + resultado mapeado + sugerencia de response_map*.
  - `PATCH /connectors/{id}` para `is_active` (fail-closed; verifica host aprobado — D2).
  - `PUT /connectors/{id}/secret` — **write-only**: cifra con `encrypt_secret`, nunca devuelve.
  - Registrar en `main.py`: `app.include_router(connectors.router, prefix="/api/v1", ...)`.
- **`connector_executor._invoke_http`**: inyección de auth por `auth_type`: `none`, `api_key`
  (header configurable), `bearer`, `basic`. Resolver secreto con `resolve_connector_secret`.
  *(OAuth2 → Fase 2.)*

### Frontend
- **Sidebar** (`components/layout/sidebar.tsx`): ítem
  `{ href:"/admin/connectors", label:"Conectores", icon: Plug, adminOnly:true }`.
- **`lib/api.ts`**: namespace `connectors: { list, get, create, update, delete, test, setSecret, tools, bindings }`.
- **`/admin/connectors`** (lista): estado activo/inactivo + última llamada OK/error (de `tool_call_audit`).
- **`/admin/connectors/[id]`** (editor), 4 bloques:
  1. Conector: nombre, URL base, hosts, tipo de auth + credencial (write-only).
  2. Operaciones (tools): método, `path_template`, `identity_kind`, editores JSON validados
     para `params_schema`/`response_map`.
  3. Roles: qué rol invoca cada tool.
  4. Disparadores: bindear intención (selector) + `min_confidence` + frases de ejemplo que
     siembran el clasificador (reusa `insert_examples` + retrain).
- **Botón "Probar"** por tool → `/test`, muestra ruta final + respuesta + sugerencia de map.

### Seguridad (no negociable)
- RBAC admin-only + aislamiento por tenant (search_path).
- Secreto cifrado en reposo (Fernet), nunca devuelto al cliente.
- Egress allowlist + bloqueo de IPs internas validado en el server (la UI no lo saltea).
- `params_schema`/`response_map` validados como JSON Schema antes de guardar.
- Activación gateada por host aprobado (D2). Toda alta/cambio auditada.

## Fase 2 — Robustez y UX · ~4–6 días
- OAuth2 client_credentials (fetch + cache de token) en el executor.
- Constructores guiados para `params_schema`/`response_map`.
- Validación de identidad configurable (`auth_validate_path`) sin tocar código.
- Asistente de ejemplos de intención (generados con LLM al bindear).

## Fase 3 — Escala · ~3–5 días
- Plantillas de conector prellenadas (alta en 2 clics).
- Panel de salud por conector (latencia, % error, forbidden/auth_required) sobre `tool_call_audit`.
- Rate limiting y cuotas por conector.

---

## Orden de construcción (Fase 1)
1. Migración 032 + allowlist de hosts. ← **primer paso**
2. `connector_secrets.py` + CRUD en `connectors_dao.py`.
3. `api/v1/connectors.py` (CRUD + test + secret + activate) + registro en `main.py` + tests.
4. Auth real en `_invoke_http` (none/api_key/bearer/basic) + tests.
5. Frontend: `lib/api.ts` + sidebar + lista + editor + "Probar".
6. `test_connectors_admin.py` + `test_cross_tenant` (un tenant no ve conectores de otro).
