import type { Metadata, Viewport } from "next";

// Viewport de la pantalla del chat (link público y tester), pensado para el
// celular:
//  - interactiveWidget "resizes-content": Chrome/Android achica la página al
//    abrir el teclado en vez de superponerlo (si no, el teclado tapa el input).
//  - viewportFit "cover": la página llega hasta los bordes del iPhone y usamos
//    safe-area-inset para no chocar con el notch ni el indicador de inicio.
//  - Sin bloquear el zoom del usuario (accesibilidad): el zoom automático al
//    tocar un campo se evita con letra de 16 px, no con maximum-scale.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

// "Agregar a la pantalla de inicio" en iOS: abre a pantalla completa, sin las
// barras de Safari. El nombre e ícono reales del tenant los pone la página al
// cargar el branding (manifest dinámico + apple-touch-icon).
export const metadata: Metadata = {
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Chat" },
  formatDetection: { telephone: false },
};

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return children;
}
