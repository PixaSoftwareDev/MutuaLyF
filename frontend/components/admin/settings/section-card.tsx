import { Card, CardContent } from "@/components/ui/card";

/**
 * Sección de configuración — ÚNICO primitivo de sección para las pestañas de
 * Configuración: card blanca redondeada con cabecera de tile neutro + título +
 * descripción, y el control debajo a una columna. No inventar variantes.
 */
export function SectionCard({
  icon: Icon, title, description, children,
}: {
  icon: React.ElementType;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            {description && (
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
            )}
          </div>
        </div>
        <div className="mt-4">{children}</div>
      </CardContent>
    </Card>
  );
}
