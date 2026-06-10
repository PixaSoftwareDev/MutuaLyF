import { cn } from "@/lib/utils";

/**
 * Sección de configuración en dos columnas (patrón Stripe/GitHub/Vercel settings):
 * a la izquierda el contexto (título + descripción + acción opcional), a la
 * derecha los controles. Aprovecha el ancho en monitor sin dejar el contenido
 * encajonado a un lado. Las secciones se separan con un divisor (divide-y en el
 * contenedor padre).
 */
export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className="grid gap-x-12 gap-y-4 py-7 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
      {/* Contexto (izquierda) */}
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{description}</p>
        )}
        {action && <div className="mt-3">{action}</div>}
      </div>
      {/* Controles (derecha) */}
      <div className={cn("min-w-0", className)}>{children}</div>
    </section>
  );
}
