"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";

/**
 * Marco de una pantalla de detalle (documento, conector, etc.): mismo header
 * `h-12` con borde que las listas (Documentos/Operadores) + contenido
 * scrolleable full-height. Reutilizable para que entrar desde una lista a su
 * detalle NO cambie el "marco" (mismo header, mismo ancho) y no se sienta otro
 * lugar. Para master-detalle in-page usar `ListDetailShell`; esto es para
 * detalles que ocupan toda la columna.
 */
export function DetailShell({ leading, title, actions, children }: {
  /** Nodo antes del título (típicamente `<BackLink />`). */
  leading?: React.ReactNode;
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          {leading}
          <h1 className="truncate text-[15px] font-semibold tracking-tight text-foreground">{title}</h1>
        </div>
        {actions}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim p-4 sm:p-6">{children}</div>
    </div>
  );
}

/** Botón "volver" para el `leading` del DetailShell. */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className="-ml-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ChevronLeft className="h-4 w-4" />
    </Link>
  );
}
