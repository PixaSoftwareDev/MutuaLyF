import { cn } from "@/lib/utils";

/**
 * Encabezado de card de configuración: ícono en recuadro con el gradient suave
 * de marca + título + descripción. Mismo lenguaje visual en Derivación,
 * Asistente y Canales para que las pestañas se sientan parte del mismo sistema.
 */
export function SectionHeader({ icon: Icon, title, description, className }: {
  icon: React.ElementType;
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-action-gradient-soft">
        <Icon className="h-5 w-5 text-action" />
      </div>
      <div className="min-w-0">
        <h2 className="font-semibold text-base tracking-tight">{title}</h2>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
        )}
      </div>
    </div>
  );
}
