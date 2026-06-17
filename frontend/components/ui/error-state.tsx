import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Estado de error unificado: ícono + título + descripción + "Reintentar".
 * Gemelo de EmptyState — reemplaza los textos rojos sueltos que dejaban al
 * usuario sin salida ante un fallo de carga.
 */
export function ErrorState({
  title = "No se pudo cargar",
  description = "Hubo un problema al traer los datos. Probá de nuevo.",
  onRetry,
  className,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="h-6 w-6 text-destructive" />
      </div>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          <RotateCw className="mr-1.5 h-3.5 w-3.5" />
          Reintentar
        </Button>
      )}
    </div>
  );
}
