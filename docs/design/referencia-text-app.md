# Referencia de diseño — Text App (chatbot.com / LiveChat)

> Relevamiento hecho el 2026-07-17 navegando la app real (trial). Es la referencia
> para el rediseño integral del panel. No es para clonar 1:1 — es la receta de
> por qué se ve moderno y simple, aplicada a nuestro producto.

## Fundamentos

- **Fondo blanco puro en toda la app.** Superficies secundarias en gris casi
  imperceptible (#F7F7F8 aprox). Nada de fondos tintados ni gradientes en el chrome.
- **Un solo color de acción: negro.** Botones primarios negros con texto blanco.
  Azul solo para links e info banners. El color vivo queda reservado a:
  ilustraciones, estados (verde/rojo/ámbar), chips y el **violeta de IA**.
- **IA siempre señalizada en violeta** + ícono sparkle: burbujas del AI Agent con
  tinte violeta suave, labels "AI Agent", banners de features IA. Es SU código de
  color más distintivo.
- **Tipografía única**, títulos de página chicos (16–18px semibold) — sin headers
  gigantes. La jerarquía la dan el peso y el gris, no el tamaño.
- **Bordes 1px gris muy claro en todo; sombras casi nulas.** La elevación se logra
  con borde + fondo, no con sombra. Radio grande: 12–16px cards, 8–10px controles.
- Densidad alta pero aireada: paddings 16–24px, filas compactas, mucho blanco.

## Patrones de layout

- **Rail de navegación de íconos (~48px)** a la izquierda + **panel secundario
  contextual** por sección: listas agrupadas con título de grupo, ícono chico,
  contador alineado a la derecha; ítem activo = fondo gris claro (sin color).
- **Topbar global**: búsqueda centrada tipo pill con atajo `Ctrl K`, chips de
  estado a la izquierda (leads, setup), avatares del equipo a la derecha.
- **Inbox 4 columnas**: rail / nav-lista / lista de chats / conversación /
  panel contextual del cliente (secciones colapsables con chevron).

## Componentes clave

- **KPI card (Reports)**: label chico gris → número enorme → chip de delta
  (verde ↑ / gris –) → "vs período anterior" → mini gráfico → breakdown con
  cuadraditos de color y valores a la derecha.
- **Selector de rango**: texto plano "7 days / 30 days / 90 days / 365 days" +
  ícono calendario. Sin pills pesadas.
- **Card de catálogo (Channels/Skills)**: ícono chico arriba, título, descripción
  de 2 líneas en gris, CTA outline ("Connect"), badge de estado (OFF / SOON /
  Coming soon). El ítem principal va como **hero card** con ilustración a la derecha.
- **Chat (inbox)**: burbuja del cliente gris claro SIN borde; burbuja del AI Agent
  con tinte violeta y label arriba + avatar chico a la derecha; timestamps
  minúsculos dentro de la burbuja; composer = caja blanca grande redondeada con
  toolbar de íconos abajo y "Send" deshabilitado en gris.
- **Onboarding/home**: checklist vertical con conectores (timeline), un solo CTA
  negro por paso, ilustración a la derecha; abajo cards de ayuda con avatares.

## Widget (configurador aparte, preview sobre mockup de página)

- **Blanco-primero**: sin banda de color en el header. El color primario aparece
  SOLO en la burbuja del usuario y botones/acentos.
- Tarjeta de presentación flotante del agente (avatar + nombre + rol) en lugar
  de header; acciones (expandir, ···, ×) como íconos grises sueltos.
- Mensajes del bot sin burbuja: texto plano + mini-avatar redondo de ~20px.
- Input pill blanca: `+` a la izquierda, emoji + enviar circular a la derecha.
- Configurador: Theme como 2 cards visuales (Light/Dark), color primario como
  10 swatches redondos planos + gotero, acordeón "More color customization" con
  hex por pieza (bubble / icon / user bubble / user message).
- Preview montado sobre un mockup gris de página web + "Preview on <url>".

## Tensiones con nuestro sistema actual (decidir antes de implementar)

1. **Color de acción**: hoy usamos el gradient Intellix (cyan→índigo→violeta) como
   acción en todo el panel. Text usa negro y reserva el color. Opciones:
   a) negro como acción y el gradient solo para logo/momentos de marca;
   b) mantener gradient solo en CTAs primarios y desaturar todo lo demás.
2. **Widget**: hoy es color-primero (header degradado de marca). Text es
   blanco-primero. Decisión de producto: cuánto branding del tenant se resigna.
3. **Sombras**: nuestro sistema actual usa elevación por sombra (shadow-sm +
   ring). Text usa borde + fondo. Cambiarlo toca todas las cards.
