"use client";

import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Piezas compartidas de "chat de mentira" para las pantallas de Configuración
 * (hero de Asistente, preview de Derivación, configurador del widget).
 * ÚNICA forma de dibujar al asistente en mocks — antes cada pestaña tenía su
 * propio avatar y sus propias burbujas, y el bot se veía distinto según dónde.
 */

/** Avatar del bot. Por defecto usa el gradient de marca (mocks decorativos);
 *  el configurador del widget pasa `background`/`dotBorderColor` con los
 *  colores del tenant, porque su trabajo es previsualizar ESA identidad. */
export function BotAvatar({ size = 24, online = true, background, dotBorderColor, className }: {
  size?: number;
  online?: boolean;
  /** CSS background (gradient del tenant). Sin esto: gradient de marca. */
  background?: string;
  /** Color del borde del punto "en línea" (el fondo donde flota el avatar). */
  dotBorderColor?: string;
  className?: string;
}) {
  const dot = Math.max(8, Math.round(size * 0.3));
  return (
    <span className={cn("relative shrink-0", className)} style={{ width: size, height: size }}>
      <span
        className={cn(
          "flex h-full w-full items-center justify-center rounded-full text-white",
          !background && "bg-gradient-to-br from-brand-light to-brand-dark text-brand-foreground",
        )}
        style={background ? { background } : undefined}
      >
        <Bot style={{ width: size * 0.55, height: size * 0.55 }} />
      </span>
      {online && (
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 rounded-full border-2 bg-emerald-500",
            !dotBorderColor && "border-white dark:border-[#15181b]",
          )}
          style={{ width: dot, height: dot, ...(dotBorderColor ? { borderColor: dotBorderColor } : {}) }}
        />
      )}
    </span>
  );
}

/** Burbuja decorativa de conversación para heros y previews estáticos. */
export function MockBubble({ from, children, className }: {
  from: "bot" | "user";
  children: React.ReactNode;
  className?: string;
}) {
  if (from === "user") {
    return (
      <div className={cn(
        "ml-auto max-w-[80%] rounded-2xl rounded-br-sm bg-gradient-to-br from-brand to-brand-dark px-3 py-2 text-xs leading-relaxed text-brand-foreground shadow-sm",
        className,
      )}>
        {children}
      </div>
    );
  }
  return (
    <div className={cn(
      "max-w-[80%] rounded-2xl rounded-bl-sm bg-white px-3 py-2 text-xs leading-relaxed text-slate-600 shadow-sm dark:bg-white/10 dark:text-slate-200",
      className,
    )}>
      {children}
    </div>
  );
}
