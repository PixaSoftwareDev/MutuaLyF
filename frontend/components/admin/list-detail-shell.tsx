"use client";

import { PanelLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Layout master-detalle full-height (modelo bandeja de entrada): columna
 * principal con header propio + contenido scrolleable, y un panel de detalle
 * como COLUMNA de alto completo a la derecha. Cerrado no desaparece: queda un
 * riel comprimido con la línea y un botón para expandir. En mobile el panel baja
 * como card. Reutilizable por Sectores, Operadores y cualquier lista con detalle.
 *
 * El contenido del `panel` trae su propio header (label + botón contraer) y
 * cablea su `onCollapse` desde la página; el shell solo maneja el riel/expandir.
 */
export function ListDetailShell({
  title, leading, actions, children, panelTitle = "detalle", panel, open, hasSelection, onExpand,
}: {
  title: string;
  /** Nodo opcional antes del título (ej. botón volver). */
  leading?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  panelTitle?: string;
  /** Contenido del panel; null cuando no hay selección. */
  panel: React.ReactNode | null;
  /** Panel expandido (vs riel comprimido). */
  open: boolean;
  hasSelection: boolean;
  onExpand: () => void;
}) {
  const expanded = open && !!panel;
  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      {/* Columna principal */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            {leading}
            <h1 className="truncate text-[15px] font-semibold tracking-tight text-foreground">{title}</h1>
          </div>
          {actions}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim p-4 sm:p-6">
          {children}
          {/* Mobile: el panel va como card debajo (solo expandido) */}
          {expanded && <div className="mt-4 overflow-hidden rounded-2xl border bg-card lg:hidden">{panel}</div>}
        </div>
      </div>

      {/* Panel de detalle: columna de alto completo. Comprimido = riel w-12. */}
      <aside
        className={cn(
          "hidden shrink-0 overflow-hidden border-l lg:block",
          "transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          expanded ? "w-[336px]" : "w-12",
        )}
      >
        {expanded ? (
          <div className="h-full w-[336px] overflow-y-auto scrollbar-slim">{panel}</div>
        ) : (
          <div className="flex w-12 flex-col items-center">
            <div className="flex h-12 shrink-0 items-center justify-center border-b">
              <button
                onClick={onExpand}
                disabled={!hasSelection}
                aria-label={`Mostrar panel de ${panelTitle}`}
                title={hasSelection ? "Mostrar panel" : "Elegí una fila para ver el detalle"}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

/**
 * Barra de header del panel de detalle (label "Sector"/"Operador" + botones a
 * la derecha, típicamente lápiz de editar + contraer). Alinea con el header de
 * la columna principal (h-12). Reutilizable por cualquier panel de detalle.
 */
export function DetailPanelHeader({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b pl-4 pr-2">
      <span className="text-[13px] font-semibold text-foreground">{label}</span>
      {children && <div className="flex items-center gap-0.5">{children}</div>}
    </div>
  );
}

/** Botón de icono para el header del panel (editar, contraer, etc.). */
export function PanelIconButton({ onClick, label, children }: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}
