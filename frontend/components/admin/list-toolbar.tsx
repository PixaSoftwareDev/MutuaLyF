"use client";

import { Search, List, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ViewMode } from "@/lib/use-view-mode";

// Ícono de "tarjetas": 2×2 de cuadrados rellenos (más sólido que el outline
// LayoutGrid — lee mejor como bloques/tarjetas).
function CardsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden="true">
      <rect x="1"  y="1"  width="6" height="6" rx="1.5" />
      <rect x="9"  y="1"  width="6" height="6" rx="1.5" />
      <rect x="1"  y="9"  width="6" height="6" rx="1.5" />
      <rect x="9"  y="9"  width="6" height="6" rx="1.5" />
    </svg>
  );
}

// Toolbar compartido de las listas del back-office: buscador en vivo + toggle
// Tarjetas/Lista. Mismo componente en Sectores y Operadores para que las dos
// pantallas se sientan del mismo sistema. El botón "Nuevo…" sigue viviendo en
// el PageHeader (CTA primario), esto es la barra de trabajo debajo.
export function ListToolbar({
  search,
  onSearch,
  placeholder,
  view,
  onView,
  action,
  controls = true,
}: {
  search: string;
  onSearch: (v: string) => void;
  placeholder?: string;
  // Toggle Tarjetas/Lista OPCIONAL: solo aparece si se pasan ambos. Las listas
  // que son solo tabla (ej. Sectores) no los pasan y no muestran toggle.
  view?: ViewMode;
  onView?: (v: ViewMode) => void;
  // CTA primario (botón "Nuevo…"). Vive acá, no en el PageHeader.
  action?: React.ReactNode;
  // Cuando la lista está vacía, ocultamos buscador y toggle y dejamos solo el
  // CTA a la derecha (para que crear el primer registro siga siendo accesible).
  controls?: boolean;
}) {
  if (!controls) {
    return <div className="flex items-center justify-end">{action}</div>;
  }
  return (
    <div className="flex items-center gap-2.5 justify-between">
      <div className="relative w-full min-w-0 max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60 pointer-events-none" />
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={placeholder}
          className="pl-9 pr-9 h-10"
          aria-label={placeholder ?? "Buscar"}
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearch("")}
            aria-label="Limpiar búsqueda"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground transition-colors p-0.5"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2.5 shrink-0">
        {view && onView && <ViewToggle view={view} onView={onView} />}
        {action}
      </div>
    </div>
  );
}

export function ViewToggle({ view, onView }: { view: ViewMode; onView: (v: ViewMode) => void }) {
  return (
    <div
      role="group"
      aria-label="Modo de vista"
      className="inline-flex shrink-0 items-center rounded-lg border bg-muted/40 p-0.5"
    >
      <ToggleBtn active={view === "cards"} onClick={() => onView("cards")} label="Tarjetas">
        <CardsIcon className="h-4 w-4" />
      </ToggleBtn>
      <ToggleBtn active={view === "list"} onClick={() => onView("list")} label="Lista">
        <List className="h-4 w-4" />
      </ToggleBtn>
    </div>
  );
}

function ToggleBtn({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 h-9 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
