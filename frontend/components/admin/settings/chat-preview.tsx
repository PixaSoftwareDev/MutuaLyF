"use client";

import { Bot, SendHorizontal, Eye } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { pickReadableTextColor } from "@/lib/use-tenant-branding";

// Defaults que el chat público usa cuando el tenant no configuró propios.
// Deben matchear los defaults en `frontend/app/chat/page.tsx`.
export const DEFAULT_BOT_NAME = "Asistente";
export const DEFAULT_GREETING = "¡Hola! 👋 Soy tu asistente virtual. ¿En qué área puedo ayudarte?";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

/** Los logos del backend pueden venir relativos (/static/...). */
export function fullLogoUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `${API_URL}${url}`;
}

export type PreviewBubble = {
  from: "bot" | "user";
  /** Vacío → se muestra "Mensaje por defecto del sistema" en itálica. */
  text: string;
  /** Etiqueta chica sobre la burbuja (ej. "Oferta del bot"). */
  note?: string;
};

/**
 * Riel estándar de la pantalla Configuración: contenido a la izquierda,
 * vista previa sticky a la derecha. Única fuente de verdad del ancho para
 * que TODOS los tabs salgan idénticos entre sí y llenen el riel de PageShell.
 */
export function SettingsRail({ children, aside }: { children: React.ReactNode; aside: React.ReactNode }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr),340px] items-start">
      <div className="space-y-6 min-w-0">{children}</div>
      <aside className="lg:sticky lg:top-6 min-w-0">{aside}</aside>
    </div>
  );
}

/**
 * Modal centrado de vista previa. Se abre a demanda desde el botón
 * "Vista previa" de cada card — el formulario queda limpio de paneles
 * laterales y el mock aparece como cualquier componente, en el centro.
 * Renderiza el estado actual del form (aunque no esté guardado).
 */
export function PreviewDialog({
  open, onOpenChange, hint, children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Eye className="h-4 w-4 text-muted-foreground" />
            Vista previa
          </DialogTitle>
          {hint && <DialogDescription>{hint}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Mock estático del chat con los colores reales del tenant. No envía nada:
 * existe para que el admin vea el efecto de lo que edita sin salir de la
 * pantalla. La conversación es configurable por tab.
 */
export function ChatPreview({
  botName, primaryColor, logoUrl, conversation, typing = false, textColor,
}: {
  botName: string;
  primaryColor: string;
  logoUrl: string | null;
  conversation: PreviewBubble[];
  typing?: boolean;
  /** Color de la letra sobre el primary. Por defecto, legible automático. */
  textColor?: string;
}) {
  const headerText = textColor || pickReadableTextColor(primaryColor);
  const resolvedLogo = fullLogoUrl(logoUrl);

  return (
    <div className="rounded-2xl border bg-card shadow-md overflow-hidden">
      {/* Header del chat con el branding del tenant */}
      <div className="flex items-center gap-2.5 px-4 py-3" style={{ backgroundColor: primaryColor, color: headerText }}>
        {resolvedLogo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={resolvedLogo} alt="" className="h-7 w-7 rounded-full object-cover bg-white/20 shrink-0" />
        ) : (
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 shrink-0">
            <Bot className="h-4 w-4" />
          </span>
        )}
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate leading-tight">{botName}</p>
          <p className="text-[10px] leading-tight" style={{ color: headerText, opacity: 0.75 }}>
            ● En línea
          </p>
        </div>
      </div>

      {/* Conversación de muestra */}
      <div className="bg-muted/30 px-3.5 py-4 space-y-3">
        {conversation.map((b, i) =>
          b.from === "bot" ? (
            <div key={i} className="max-w-[85%]">
              {b.note && (
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70 mb-1 ml-1">
                  {b.note}
                </p>
              )}
              <div className="rounded-2xl rounded-tl-md border bg-card px-3.5 py-2.5 text-[13px] leading-relaxed shadow-xs">
                {b.text || <span className="italic text-muted-foreground">Mensaje por defecto del sistema</span>}
              </div>
            </div>
          ) : (
            <div
              key={i}
              className="ml-auto max-w-[75%] w-fit rounded-2xl rounded-tr-md px-3.5 py-2.5 text-[13px] leading-relaxed shadow-xs"
              style={{ backgroundColor: primaryColor, color: headerText }}
            >
              {b.text}
            </div>
          ),
        )}

        {/* Indicador de "escribiendo" para dar vida al mock */}
        {typing && (
          <div className="w-fit rounded-2xl rounded-tl-md border bg-card px-3.5 py-3 shadow-xs flex items-center gap-1">
            {[0, 1, 2].map(i => (
              <span
                key={i}
                className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-pulse"
                style={{ animationDelay: `${i * 200}ms` }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Input fake */}
      <div className="border-t bg-card px-3.5 py-3">
        <div className="flex items-center gap-2 rounded-full border bg-muted/40 px-4 py-2">
          <span className="flex-1 text-[13px] text-muted-foreground/60 truncate">Hacé tu consulta…</span>
          <SendHorizontal className="h-4 w-4 shrink-0" style={{ color: primaryColor }} />
        </div>
      </div>
    </div>
  );
}
