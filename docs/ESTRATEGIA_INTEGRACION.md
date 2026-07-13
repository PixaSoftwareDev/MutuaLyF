# Estrategia de integración — enlazar la base de datos del cliente con el mínimo esfuerzo

> Objetivo de producto: vender a cualquier empresa. El cliente hace lo MÍNIMO posible;
> la plataforma automatiza el resto y controla las fallas.

## El problema

El conector (Fase 1) asume que el cliente tiene una API REST. El mercado real
(mutuales, clínicas, pymes): ~10% tiene API documentada, ~20% API sin docs,
~50% SOLO una base de datos administrada por su proveedor de software, ~20% nada.
Pedir "exponé una API con auth" mata la venta en el 70% de los casos.

## Menú de integración por niveles (el cliente elige el más barato para él)

| Nivel | Qué hace el cliente | Qué hacemos nosotros | Estado |
|---|---|---|---|
| 1. **Agente puente** | Corre 1 contenedor Docker en su red + crea 1 usuario de DB **solo-lectura** | Túnel saliente (mTLS) hacia la plataforma; las operaciones son consultas SQL parametrizadas pre-aprobadas (mismo modelo que las tools HTTP: el LLM jamás escribe SQL) | 📋 A construir (proyecto grande) |
| 2. **Plantillas de proveedor de software** | Pide credenciales a su proveedor de sistemas | Integramos con cada proveedor UNA vez → cada cliente nuevo del mismo proveedor = plantilla + credenciales (2 clics) | 📋 Fase 3 del plan de pantalla |
| 3. **API propia** | Expone su API (o la de su proveedor) | Pantalla /admin/connectors: alta, prueba en vivo, activación | ✅ Hecho (Fase 1) |
| 4. **Solo documentos** | Sube PDFs/docs | RAG actual — sin datos personales | ✅ Hecho |

## Validación de identidad: también la hace la plataforma (OTP propio) ✅ HECHO

Antes pedíamos al proveedor "un endpoint que valide DNI+código" — la mayoría no lo
tiene. Se invirtió la responsabilidad:

1. La plataforma lee el **contacto del afiliado desde la base del cliente** (vía el
   conector: `identity_lookup_path`, ej. `GET /afiliados/{identity}`).
2. La plataforma **genera y envía** el código (email vía SMTP; SMS/WhatsApp futuro;
   dev sin SMTP → log).
3. La plataforma **valida** el código (hash SHA-256 en Redis, TTL 5 min, un solo uso,
   atado a tenant+conversación+identity).

Lo único que necesita el cliente: que su base tenga email/celular del afiliado.
Configurable por conector en la pantalla: "Validación de identidad" →
`provider` (endpoint del proveedor) | `platform_otp` (OTP propio).
Config en `tenant_connectors.auth_config`:
`{"identity_validation":"platform_otp","identity_lookup_path":"/afiliados/{identity}",
  "contact_email_field":"email","name_field":"nombre","found_field":"encontrado"}`

Implementación: `services/otp.py` + rama en `connector_router` (_handle_id_input /
_handle_code_input) + `connector_executor.lookup_identity`.

## Invariantes de control de fallas (valen para TODOS los niveles)

1. **Solo lectura, siempre** — usuario de DB read-only + `is_read_only` en tools.
2. **El LLM nunca construye la consulta** (ni SQL ni URL): solo dispara operaciones
   pre-aprobadas con params validados por schema.
3. **Identidad server-side** — `{identity}` sale de la sesión cifrada, nunca del texto.
4. **Fail-closed** — proveedor caído = no autenticar, no inventar; bot degrada a info general.
5. **Anti-enumeración** — DNI inexistente recibe mensaje neutro y consume intentos.
6. **Throttle** — 5 intentos de código → bloqueo 15 min; máx 3 envíos de OTP / 10 min.
7. **Probar antes de activar** + gate super-admin para hosts nuevos (D2).
8. **Auditoría inmutable** de cada invocación, incluso denegadas.

## Pitch de venta (Nivel 1, cuando exista el agente)

"Para que el bot responda con los datos de tus afiliados, tu técnico corre un
contenedor y crea un usuario de solo-lectura. 30 minutos. Nada de tu sistema se
expone a internet y el bot solo puede leer lo que vos apruebes, consulta por consulta."
