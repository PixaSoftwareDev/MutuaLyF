import { cn } from "@/lib/utils";

/**
 * Columna de formulario. Va DENTRO de <PageShell> (que mantiene el riel exterior
 * a max-w-7xl, igual en todas las pantallas). Restringe solo el ancho de lectura
 * del formulario (~640px) alineado a la izquierda, como Airbnb/Linear: el header
 * y el contenido comparten el mismo borde izquierdo, pero los campos no se estiran
 * a todo el ancho. Reemplaza los `<PageShell className="max-w-2xl mx-auto">` ad-hoc
 * que rompían la consistencia de ancho entre pantallas.
 */
export function FormColumn({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("max-w-2xl space-y-4 sm:space-y-6", className)}>
      {children}
    </div>
  );
}
