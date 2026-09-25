# Chat en el celular: auditoría y correcciones (2026-09-25)

Alcance: la pantalla del chat (`frontend/components/chat/chat-screen.tsx`),
que usan el canal "Chat por link" (`/chat/{tenant}`) y "Probar chat"
(`/chat?tenant=&test=1`). El widget embebido (`public/widget/widget.js`) es
otro código y NO está cubierto acá.

## Hallazgos (14) y corrección aplicada

| # | Problema | Corrección |
|---|---|---|
| 1 | Zoom automático al tocar el campo (iOS, letra < 16 px) | Campos a 16 px (`text-base`) en la barra y en el formulario de identificación. No se bloquea el zoom del usuario. |
| 2 | El teclado tapa la barra de escritura (Android superpone; iOS desplaza la página) | `interactive-widget=resizes-content` en el viewport de `/chat` + alto raíz medido con `visualViewport` y raíz `fixed`; la página vuelve a scroll 0 al enfocar. |
| 3 | `100vh` más alto que lo visible (barras del navegador) | Fallback `100dvh` + alto medido por JS. |
| 4 | Sin áreas seguras (notch, indicador de inicio) | `viewport-fit=cover` + `safe-area-inset` arriba (tarjeta del bot) y abajo (barra). |
| 5 | Foco automático al cargar levanta el teclado | Foco automático solo con mouse (`hover: hover` + `pointer: fine`). |
| 6 | Rebote de página y "tirar para recargar" | `overscroll-behavior: none` en html/body mientras vive la pantalla; la lista usa `overscroll-contain`. |
| 7 | Flash gris al tocar | `-webkit-tap-highlight-color: transparent` (clase `chat-app`). |
| 8 | Retardo / doble toque hace zoom | `touch-action: manipulation` en botones y campos. |
| 9 | Campo de una sola línea | `textarea` que crece hasta ~5 líneas y vuelve a una al enviar. |
| 10 | Tecla Enter genérica | `enterKeyHint="send"` (y `next`/`done` en identificación). |
| 11 | Botones de 36 px | Enviar y adjuntar a 44 px. |
| 12 | Barra del navegador sin color | `theme-color` con el color primario del tenant al cargar el branding. |
| 13 | No instalable como app | Manifest dinámico por tenant (`/chat/{tenant}/manifest.webmanifest`, nombre/color/ícono del branding) + metadatos Apple + `apple-touch-icon`. Solo en el link público. |
| 14 | El último mensaje queda tapado al abrir el teclado | Scroll al final cada vez que cambia el alto medido. Extra: al volver a la app (visibilitychange) se refresca la conversación. |

## Cómo probar (celular real, staging)

`https://dev.intellix.com.ar/chat/mutualyf` en iPhone (Safari) y Android
(Chrome): abrir, tocar el campo (sin zoom, barra pegada al teclado, último
mensaje visible), escribir 6 líneas (crece y luego scrollea), enviar con la
tecla del teclado, girar el teléfono, arrastrar la lista hacia abajo (no
recarga), bloquear y desbloquear (refresca), "Agregar a inicio" (abre sin
barras, con nombre e ícono de la organización).
