# Plan: canal "Chat por link" y saneamiento de tokens del chat

> Acordado el 2026-09-24. Desarrollo en `dev-local`; staging y prod solo con
> acuerdo explícito del equipo. Estado vivo de cada punto al final.

## Por qué

- El cliente quiere compartir un link que abra el bot en una ventana, sin
  embeber nada (WhatsApp, mail, redes).
- Al revisar la página `/chat` se encontró que **"Probar chat" regenera el
  token del widget del tenant** en cada clic (mismo endpoint que "Regenerar"
  en Canales): el código instalado en la web del cliente queda inválido.
- El link del tester lleva un token de 90 días en la URL.

## Decisiones

| Tema | Decisión |
|---|---|
| Nombre del canal | "Chat por link", valor interno `link` en `conversaciones.channel` |
| Interruptor | Propio: `public.tenants.chat_link_enabled` (migración 056) |
| URL | Corta `/c/{tenant}` (rewrite de Next) + `/chat?tenant=` por compatibilidad |
| Token del link | Efímero de 2 h (scope `chat`), pedido por la página, renovado solo ante 401 |
| Token del tester | Efímero de 2 h con claim `test: true` firmado; se pide con sesión de admin; nunca más se rota el token del widget desde el tester |
| Token del widget embebido | Se mantiene (clave semipública + hash revocable + rate limit por IP). Allowlist de dominios = opcional al final |

## Puntos

| # | Punto | Cómo | Archivos |
|---|---|---|---|
| P1 | Tester no rota el token del widget | Endpoint `POST /admin/chat-tester-token` (sesión admin) emite token `chat` con `test=true`; la puerta de `is_test` en la creación de conversación mira el claim, no el scope widget | `core/security.py`, `api/v1/operator_panel.py`, `api/v1/widget_conversation.py`, `components/layout/sidebar.tsx` |
| P2 | Token fuera de la URL del tester | URL `/chat?tenant=X&test=1`; la página pide el token con la sesión del panel | `app/chat/page.tsx` |
| P3 | Canal `link` distinguible | La página manda `channel` al crear; backend valida `widget|link`; ícono/etiqueta/filtro en bandeja, contexto, feedback e informes. Sin migración (columna VARCHAR sin CHECK) | `widget_conversation.py`, `conversations-panel.tsx`, `conversation-context-panel.tsx`, … |
| P4 | Tarjeta en Canales + flag + URL corta | Migración 056 (`chat_link_enabled`), `channels.py`, endpoint público respeta flag por canal, tarjeta con URL/copiar/interruptor, rewrite `/c/:tenant` | `db/migrations/versions/056_*.py`, `api/v1/channels.py`, `channels-settings.tsx`, `next.config.js` |
| P5 | Renovación del token público | Ante 401 con token público, pedir uno nuevo y reintentar una vez con el mismo `widget_session_id` | `app/chat/page.tsx` |
| P6 | Rate limit al endpoint público de tokens | Mismo limitador por IP que los mensajes del widget | `api/v1/operator_panel.py` |
| P7 | Allowlist de dominios del widget (opcional) | Lista por tenant en Canales; vacía = comportamiento actual | `main.py`, `channels.py` |
| P8 | Métricas por canal | Verificar que dashboard e informes cuentan `link` aparte | — |

## Riesgo principal: cadena de migraciones

Cabeza en `dev-local` = 054; en `dev`/`main` = 055. La 056 se escribe con
`down_revision = "054"` en dev-local y al cherry-pickear se cambia esa única
línea a `"055"`. Antes de cada deploy: `alembic heads` en el contenedor debe
devolver UNA cabeza. Alternativa sin migración: el link comparte
`widget_enabled` (descartada salvo que el riesgo lo justifique).

## Orden y ambientes

1. dev-local: P1+P2 → P3+P4 → P5+P6, un commit por bloque, con
   `tsc --noEmit` + pytest en contenedor (incluye `test_cross_tenant.py`).
2. Pruebas de Alejo en dev-local.
3. Staging (`dev`): verificar `down_revision`, rebuild frontend, probar con
   tenant `mutualyf` de staging desde celular, tester, widget embebido en
   página de prueba, canales apagados.
4. Prod (`main`): solo con OK de ambos.

## Verificación pendiente en prod (lectura)

Comparar el token del widget instalado en la web del cliente contra
`widget_token_hash`. Si no coinciden, el widget ya está roto por P1 y hay
que avisarles que reinstalen el código después del deploy.

## Lo que NO se toca

Contenido/config del tenant del cliente; el token del widget actual (no se
regenera en ningún ambiente); el endpoint público de token existente sigue
respondiendo igual.

## Estado

- [x] P1  - [x] P2  - [x] P3  - [x] P4  - [x] P5 (renovación ante 401, misma sesión)  - [x] P6  - [ ] P7 (opcional, no arrancado)  - [x] P8 (métricas cuentan `link` aparte)

Hecho en dev-local el 2026-09-24 (commits `fix(chat)` y `feat(canales)`). Pendiente: pruebas de Alejo en dev-local → staging → prod.
