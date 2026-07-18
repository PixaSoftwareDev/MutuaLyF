import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  /** Flecha de volver (páginas de detalle): navega a la lista madre. */
  back?: { href: string; label?: string };
  /** Ya no se renderiza (patrón referencia: solo título). Se acepta por compat. */
  eyebrow?: string;
  title: string;
  /** Chip al lado del título — típicamente un conteo ("8 activos"). */
  badge?: React.ReactNode;
  /** Ya no se renderiza (patrón referencia: sin subtítulos). Se acepta por compat. */
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
};

/**
 * Cabecera de página estándar (patrón de la referencia Text): una BARRA fija de
 * ~48px con SOLO el título chico en semibold a la izquierda, acciones a la
 * derecha y una línea divisoria abajo. Sin eyebrow ni descripción — el contexto
 * lo dan el panel de navegación y el contenido.
 *
 * Los márgenes negativos escapan el padding del PageShell para que la línea
 * divisoria cruce el ancho completo del contenido, como en la referencia.
 */
export function PageHeader({ back, title, badge, actions, className }: Props) {
  return (
    <div className={cn(
      "-mx-4 -mt-4 flex min-h-12 flex-wrap items-center gap-x-2.5 gap-y-2 border-b px-4 py-2 sm:-mx-6 sm:-mt-6 sm:px-6",
      className,
    )}>
      {back && (
        <Link
          href={back.href}
          aria-label={back.label ?? "Volver"}
          title={back.label ?? "Volver"}
          className="-ml-1.5 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
        </Link>
      )}
      <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-foreground">{title}</h1>
      {badge}
      {actions && (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * Chip de conteo para el slot `badge` del PageHeader. Sobrio, tabular.
 */
export function CountChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-semibold text-foreground/80">
      {children}
    </span>
  );
}
