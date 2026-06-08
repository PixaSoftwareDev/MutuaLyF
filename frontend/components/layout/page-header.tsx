import { cn } from "@/lib/utils";

type Props = {
  /** Kicker de sección en color de marca (ej. "Equipo", "Conocimiento"). Da estructura editorial. */
  eyebrow?: string;
  title: string;
  /** Chip al lado del título — típicamente un conteo ("8 activos"). Integra la métrica sin bloque suelto. */
  badge?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
};

/**
 * Header de página estándar del back-office. Identidad Intellix: eyebrow de
 * marca + título fuerte + chip de conteo integrado + descripción. El slot de
 * actions es solo para CTAs primarios. Mismo ritmo visual en todas las pantallas.
 */
export function PageHeader({ eyebrow, title, badge, description, actions, className }: Props) {
  return (
    <div className={cn("flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h1 className="text-[26px] sm:text-[30px] font-bold tracking-tight text-foreground leading-none">
            {title}
          </h1>
          {badge}
        </div>
        {description && (
          <p className="text-[15px] text-muted-foreground mt-2.5 max-w-2xl leading-relaxed">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2 shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * Chip de conteo para el slot `badge` del PageHeader. Sobrio, tabular,
 * con un punto de acento gradient. Reemplaza los resúmenes sueltos.
 */
export function CountChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-[12px] font-semibold text-foreground/80">
      <span className="h-1.5 w-1.5 rounded-full bg-action-gradient" />
      {children}
    </span>
  );
}
