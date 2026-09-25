# Chat: auditoría integral y plan (2026-09-25)

Fuentes: tres revisiones en paralelo (pantalla React `components/chat/chat-screen.tsx`,
widget `public/widget/widget.js`, backend `api/v1/widget_conversation.py` +
`services/handoff.py`). Todo con referencia a línea en los informes originales;
acá va lo consolidado. Alcance: los TRES canales de chat (link, tester, widget).

## Diagnóstico del bug reportado (sector "Consultas Generales")

- La píldora "Consulta dirigida al área X" es solo de interfaz: se dibuja FUERA
  de la línea de mensajes, siempre debajo (React `:1176-1182`); cada mensaje
  nuevo la empuja. Además no anima al elegir (mismo nodo, solo cambia la clase).
- El backend NO guarda el sector al elegirlo: solo en `start` (que ya corrió con
  `sector_id: null`) y en `confirm-handoff`. Consecuencias: con F5 vuelve a
  preguntar, y disponibilidad de operadores y Regla 5 se evalúan con el sector
  por defecto, no con el elegido.
- El widget no tiene el problema de orden (píldora sincrónica), pero comparte
  la no-persistencia y su LISTA de sectores puede aparecer tarde (`_loadSectors`).

## Bloques de trabajo

### A. Sector elegido = dato real (raíz del bug) — backend + 2 clientes
1. `PATCH /widget/conversation/{id}/sector` (misma validación que `start`),
   inserta mensaje `system` con flag `is_sector_note` y devuelve `sector_id`.
2. El poll devuelve `sector_id` en el snapshot.
3. React y widget: la píldora pasa a ser un mensaje más de la cronología (queda
   anclada donde se eligió, sobrevive a F5); `selectedSector` sale del snapshot.

### B. Protocolo de conversación sano — backend (migración 057)
1. `mensajes.seq BIGSERIAL` + `ORDER BY created_at, seq`; el poll expone `seq` y
   el ancla pasa a `last_seq` (hoy dos mensajes con el mismo `created_at`
   pueden salir desordenados y el ancla por id pierde reordenes).
2. Long-poll: suscribirse a Redis ANTES de leer el snapshot (hoy una respuesta
   del bot publicada entre ambos se pierde y el poll cuelga hasta 25 s).
3. `?force=1` en el poll (o sin ancla) para el "volver a la app".
4. Señal `bot_typing` (Redis TTL corto, campo en el poll) publicada antes de
   `handle_query`; base para "operador escribiendo" después.
5. `conversation_id` no-UUID → 404 en vez de 500 (message/poll/feedback/attachment).
6. `handoff.py`: `await` sobre función síncrona (`get_redis_cache`) rompe la
   supresión de 1 h de la Regla 5; `KeyError` posible en `transition_messages["handoff_offer"]`.
7. `send_message` en `HANDOFF_REQUESTED` no publica evento tras insertar "en cola".

### C. Pantalla del chat (link + tester) — React
Bugs: mensajes locales (errores, "solicitud enviada") se borran en el próximo
poll (mantener `localMessages` aparte y mergear); envío con 429/5xx falla en
silencio y deja `status=undefined`; auto-scroll "yanquea" al leer arriba
(scroll solo si estás cerca del fondo o el último es tuyo, y comparar último id
antes de setear); burbuja propia parpadea (id optimista ≠ real: reconciliar);
no se puede enviar mientras el bot piensa (encolar); `visibilitychange` abre un
long-poll paralelo (usar `force`); adjuntos sin renovación de token; estado no
reseteado al renovar conversación (410).
UX móvil: layout en tres bloques apilados (cabecera 56 px, lista, barra) en vez
de flotantes; barra pegada al teclado, enviar visible solo con texto; texto de
burbujas 15-16 px y `max-w-[85%]`; indicador "escribiendo" con la misma forma
que la burbuja del bot; sectores como chips sin scroll anidado y con `active:`;
limitar `scrollTo(0,0)` al evento `resize`; agrupar burbujas consecutivas;
teclado se guarda al scrollear la lista.

### D. Widget embebido — vanilla JS
Bugs: doble `start` + doble poll si escribís antes de que responda; oferta de
handoff perdida al reanudar; 410 con `resumed` descarta el mensaje pendiente;
conversación cerrada sin salida (botón "Nueva conversación"); `start` y
`message` no chequean `r.ok` (401 silencioso, mensaje perdido); poll sin
backoff ni pausa con pestaña oculta; upload con error no-JSON; sin guard de
doble carga; `createObjectURL` sin revocar; mensajes del bot de otra pestaña
ignorados.
Móvil: el teclado se cierra en cada envío (`disabled` sobre el textarea → usar
flag); `select` de sector en 14 px (zoom iOS); sin tap-highlight ni `@media
(hover:hover)`; targets de 30-34 px; `overscroll-behavior:none` en `html` del
host mientras está abierto; `enterkeyhint`; lista de sectores insertada
después del saludo, no al final.

### E. Estructura compartida (paridad de los tres canales)
Extraer `frontend/lib/chat-protocol.ts` sin React: token/renovación, start,
poll con dedup y backoff y versión, message, attachment, confirm-handoff,
feedback, mensajes locales, reglas 401/410, render Markdown seguro. Lo consume
un hook `useWidgetConversation` (pantalla React) y el widget compilado a IIFE.
Componentes: `MessageList` (auto-scroll condicional), `Composer`, `IdentityCard`,
`SectorChoice`, `HandoffOfferBubble`, `FeedbackCard`, `useMobileAppHeight`.
Paridad pendiente: saludo (una sola fuente: `/start`), feedback (widget no lo
tiene), adjuntos (misma técnica), token (widget no detecta 401).

## Estado (2026-09-25, noche)

- A y B: HECHOS (backend, migración 057; en staging).
- C y E: HECHOS (`lib/chat-protocol.ts` + `components/chat/chat-screen.tsx`; en staging).
- D: HECHO — el widget se compila desde `frontend/widget-src/widget.js` con esbuild
  (`pnpm build:widget`, corre en `pnpm build`) sobre el mismo protocolo. El
  artefacto `public/widget/widget.js` se versiona. Pendiente: prueba real en
  celular de los tres canales y el punto de paridad "feedback en el widget".
- Extra encontrado: nginx fija X-Tenant-ID por host (prod → "mutual"); el token
  público ahora toma el tenant por query (fix `fix(chat)`).

## Orden propuesto
1. A + B (backend, migración 057; sin cambios visibles hasta que los clientes lo usen).
2. C con E: al reescribir la pantalla, la lógica sale a `chat-protocol.ts`.
3. D: el widget pasa a usar `chat-protocol.ts` + correcciones móviles propias.
4. Staging: pruebas en celular real de los tres canales (checklist de
   `PLAN_CHAT_MOVIL.md` + sector, derivación, reapertura, dos pestañas).
