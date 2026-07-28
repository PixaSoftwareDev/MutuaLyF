# Diseño — OAuth2 con refresh automático en conectores

> Estado: propuesta de diseño (2026-07-27). No implementado.
> Contexto: hoy los conectores solo soportan credenciales estáticas (`none`,
> `api_key` header/query, `bearer`, `basic`). Si el proveedor emite tokens que
> vencen, el conector queda en 401 hasta que un admin pegue un token nuevo a mano.
> Es la brecha nº 1 de cobertura de proveedores (Google, Microsoft, SAP, la
> mayoría de APIs corporativas serias usan OAuth2).

## 1. Problema

El modelo actual asume que el secreto del conector **es** la credencial que viaja
en cada request. Con OAuth2 eso es falso: lo que se guarda es una credencial de
**emisión** (client_id + client_secret) y lo que viaja es un **access_token
derivado, con vencimiento** (típico: 5 min a 24 h).

Necesitamos que el sistema obtenga, cachee, renueve y reintente tokens **solo**,
sin intervención del admin y sin que ninguna capa superior (router, loop
agéntico, panel de prueba) se entere de que la credencial es dinámica.

**Alcance de esta fase: grant `client_credentials`** (máquina-a-máquina, una
credencial de servicio por conector — igual que nuestro modelo actual de
identidad). Quedan explícitamente fuera:
- `authorization_code` delegado por usuario final (cada usuario autoriza su
  cuenta): otro modelo de identidad, otra fase.
- `password` grant: deprecado por la spec, solo si un cliente concreto lo exige.

## 2. Solución en una imagen

```
request a tool ──► resolve_auth(connector)
                        │
                        ├─ auth_type estático (api_key/bearer/basic) ─► build_auth (sync, como hoy)
                        │
                        └─ auth_type = oauth2:
                              token cacheado y vigente en Redis? ──sí──► úsalo
                              │ no
                              ▼
                              POST token_url (client_id + client_secret, single-flight)
                              ▼
                              cachear cifrado (TTL = expires_in − margen) ─► úsalo
                        
llamada al proveedor ──► 401 → invalidar cache → refresh → reintentar UNA vez
```

Una sola pieza nueva (`services/connector_oauth.py`) y un solo punto de
integración por call-site: donde hoy se llama `build_auth(...)` pasa a llamarse
`await resolve_auth(...)`, que delega en `build_auth` para los tipos estáticos.

## 3. Modelo de datos — sin migración

Se reutiliza el patrón de `basic` (usuario en config, contraseña en secreto):

- `auth_type = 'oauth2'` (nuevo valor en `SUPPORTED_AUTH_TYPES`).
- `auth_config` (jsonb existente):
  ```json
  {
    "token_url": "https://auth.proveedor.com/oauth/token",
    "client_id": "abc123",             // no es secreto (como username de basic)
    "scopes": "read:ordenes read:facturas",   // opcional
    "audience": "https://api.proveedor.com",  // opcional (Auth0 y similares)
    "token_auth_style": "body"         // "body" (default) | "basic_header"
  }
  ```
- `auth_secret_enc` (columna existente, Fernet): el **client_secret**.
- El **access_token NO se persiste en Postgres**: es efímero y derivado. Vive en
  Redis cache (DB 1) **cifrado con Fernet**:
  - clave: `{tenant_id}:connector_oauth:{connector_id}`
  - valor: `encrypt_secret(access_token)`
  - TTL: `max(expires_in − 60s, 30s)` — margen para que nunca viajemos con un
    token al borde del vencimiento. Sin `expires_in` en la respuesta → TTL 300s.
  - Redis se reinicia → se pide un token nuevo. Pérdida aceptable por diseño
    (misma política que el resto de la DB 1).

## 4. Componentes

### 4.1 `services/connector_oauth.py` (nuevo)

```
async def get_access_token(tenant_id, connector: dict, secret_enc) -> str
async def invalidate(tenant_id, connector_id) -> None
```

- **Cache-first**: lee Redis; si hay token vigente lo devuelve descifrado.
- **Single-flight por proceso**: un `asyncio.Lock` por `(tenant, connector)` para
  que 10 requests concurrentes no disparen 10 POST al token endpoint (patrón del
  breaker per-key del executor). Carrera entre workers distintos: inocua, ambos
  obtienen tokens válidos y el último pisa el cache.
- **POST al token endpoint** con `grant_type=client_credentials` + scopes +
  audience; credenciales según `token_auth_style`:
  - `body`: `client_id`/`client_secret` en el form (lo más común).
  - `basic_header`: `Authorization: Basic base64(id:secret)` (spec estricta).
- **Egress**: `assert_egress_allowed(token_url, ...)` — el token endpoint suele
  vivir en OTRO host que la API (`auth.proveedor.com` vs `api.proveedor.com`).
  Al guardar `token_url`, la UI agrega su host a `egress_allow` (mismo flujo de
  aprobación de hosts que ya existe en prod).
- **Errores con mensaje**: la respuesta de error OAuth es estándar
  (`{"error": "invalid_client", "error_description": ...}`) — se pasa por
  `_upstream_message` (ya la entiende) y llega al admin como
  "No pude obtener el token: invalid_client — …".

### 4.2 `resolve_auth` — el único punto que conoce la diferencia

En `connector_secrets.py`:

```
async def resolve_auth(tenant_id, connector: dict, secret_enc) -> dict
    # oauth2 → {"headers": {"Authorization": f"Bearer {await get_access_token(...)}"},
    #           "auth": None, "params": {}}
    # resto  → build_auth(...)  (sync, intacto)
```

Call-sites que migran de `build_auth` a `await resolve_auth` (los 6 ya
inventariados en la sesión del api-key por query): `connector_executor.py`
(execute_tool, validate_second_factor, lookup_identity),
`connector_discovery.py` (fetch_spec, dry_run) y `api/v1/connectors.py`
(_dry_run_tool). `build_auth` queda como está — los tests actuales no se tocan.

### 4.3 Retry-once ante 401 (revocación anticipada)

Los proveedores revocan tokens antes del vencimiento (rotación de claves, logout
administrativo). Regla en los call-sites de ejecución (executor + dry-run):

```
resp = llamada con token
si resp.status == 401 y auth_type == 'oauth2' y no reintentado aún:
    invalidate(tenant, connector)      # borra el cache
    token nuevo + repetir la llamada UNA vez
```

- Máximo **un** reintento (sin loops: si el 401 persiste, el problema es de
  permisos/credencial, no de frescura — se reporta con el mensaje del proveedor).
- El breaker por conector existente cuenta el fallo igual que hoy (sin cambios).

### 4.4 UI — editor de credencial (pantalla de conectores)

Con `auth_type = oauth2`, el editor de credencial pide (valores pelados, jamás
JSON — regla de la casa):

| Campo | Dónde va | Nota |
|---|---|---|
| URL del token | `auth_config.token_url` | con auto-alta del host en egress |
| Client ID | `auth_config.client_id` | visible (no es secreto) |
| Client Secret | `auth_secret_enc` | write-only, cifrado, como hoy |
| Scopes | `auth_config.scopes` | opcional, texto |
| Estilo de credencial | `auth_config.token_auth_style` | select: "En el body (común)" / "Header Basic" |

Botón **"Probar conexión"**: pide un token real y muestra verde o el error OAuth
humanizado. No toca las tools — valida solo la credencial. (Endpoint nuevo
`POST /admin/connectors/{id}/test-auth`, también útil para bearer/api_key.)

### 4.5 Salud y observabilidad

- `tool_call_audit` ya registra outcomes por tool — se agrega el evento
  `oauth_token_refreshed` (info) y `oauth_token_failed` (warning) con
  `latency_ms` del token endpoint, **sin** el token en ningún log.
- La pantalla de salud del conector (hecha el 22/07 sobre tool_call_audit) suma
  la fila "token OAuth: último refresh hace X min / fallando desde Y".

## 5. Seguridad

- `client_secret` cifrado en reposo (Fernet, columna existente) y write-only en
  la UI — idéntico al resto de secretos.
- `access_token` cifrado también en Redis; nunca en Postgres, logs, auditoría ni
  mensajes de error (mismo principio que la api-key por query: jamás en la URL).
- El token endpoint pasa por el egress guard como cualquier upstream (anti-SSRF:
  un admin no puede apuntar `token_url` a un host interno no aprobado).
- Scopes mínimos: el placeholder de la UI sugiere pedir solo lectura.
- Fail-closed se mantiene: sin client_secret configurado → `ValueError` antes de
  llamar al proveedor (patrón actual de `build_auth`).

## 6. Casos borde definidos (no improvisar)

| Caso | Comportamiento |
|---|---|
| Respuesta sin `expires_in` | TTL fijo 300s |
| `expires_in` < 90s | TTL = `max(expires_in − 60, 30)` — nunca negativo |
| Token endpoint caído | outcome `upstream_error`; el breaker del conector abre como hoy; mensaje del proveedor al admin |
| `invalid_client` | NO reintentar (no es transitorio); mensaje claro en la prueba y en salud |
| 401 tras refresh | reportar, no loopear |
| Dos workers refrescan a la vez | permitido; ambos tokens válidos, el último gana el cache |
| Cambio de client_secret en la UI | `invalidate()` inmediato del token cacheado |
| Proveedor devuelve `refresh_token` | se ignora en esta fase (client_credentials re-emite con las mismas credenciales; anotar en log debug para dimensionar la fase 2) |

## 7. Tests (junto con el módulo, como siempre)

Mock del token endpoint con `respx`/httpx-mock (sin red):
1. Emisión + cache: dos llamadas seguidas → un solo POST al token endpoint.
2. Vencimiento: TTL agotado → re-emisión automática.
3. Retry-once: upstream devuelve 401 → refresh → 200; segundo 401 → error reportado.
4. `invalid_client` → sin retry + mensaje humanizado.
5. Single-flight: N llamadas concurrentes → un POST.
6. Egress: `token_url` fuera de la allowlist → bloqueado.
7. El token nunca aparece en `result["url"]`, logs ni `last_test_detail`.

## 8. Estimación y orden

| Paso | Tamaño |
|---|---|
| `connector_oauth.py` + `resolve_auth` + migrar 6 call-sites | ~1 día |
| Retry-once en executor y dry-run | ~medio día |
| UI credencial oauth2 + test-auth endpoint | ~1 día |
| Salud/auditoría + casos borde + tests | ~1 día |

Total: **~3,5 días** de trabajo enfocado. Sin migración de base de datos, sin
tocar el contrato de las tools ni el router: para todo lo que está por encima de
`resolve_auth`, un conector OAuth2 es indistinguible de uno con bearer estático.

## 9. Fase 2 (explícitamente fuera de este diseño)

- `authorization_code` + `refresh_token` delegado por usuario final (Google
  Workspace del empleado, etc.): requiere modelo de identidad por usuario,
  pantalla de consentimiento y almacenamiento de refresh_tokens por persona.
  Se diseña aparte cuando haya un caso real.
