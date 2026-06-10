import { cn } from "@/lib/utils";

type Width = "default" | "wide" | "narrow";

// Sistema de anchos del back-office. Una sola fuente de verdad para que TODAS
// las páginas salgan del mismo molde y no inventen su propio max-width.
//   narrow  → formularios / lectura de una columna (cuenta, branding…)
//   default → listas, grids, dashboards — la mayoría de las pantallas
//   wide    → inbox y tablas muy anchas
const WIDTHS: Record<Width, string> = {
  narrow: "max-w-3xl",
  default: "max-w-[1400px]",
  wide: "max-w-[1600px]",
};

type Props = {
  children: React.ReactNode;
  className?: string;
  width?: Width;
};

/**
 * Standard page container. Single source of truth for outer padding and
 * max-width across the back-office. Use it as the outermost wrapper of
 * every admin/superadmin page so the content rail stays consistent.
 */
export function PageShell({ children, className, width = "default" }: Props) {
  return (
    <div className={cn("w-full mx-auto p-4 sm:p-6 space-y-4 sm:space-y-6 animate-fade-in", WIDTHS[width], className)}>
      {children}
    </div>
  );
}
