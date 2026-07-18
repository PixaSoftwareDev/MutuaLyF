"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Modal de formulario estándar de la app: centrado, con cabecera de tile de
 * icono + título + descripción, cuerpo scrolleable y footer de acciones. Un
 * único ancho por defecto (max-w-lg) para que TODOS los modales se sientan
 * iguales. Reemplaza el boilerplate repetido de <Dialog> en cada pantalla.
 */
export function FormDialog({
  open, onOpenChange, icon: Icon, title, description, children, footer, className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon?: React.ElementType;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Override del ancho por defecto (max-w-lg). */
  className?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("max-w-lg", className)}>
        <DialogHeader>
          <div className="flex items-start gap-3 text-left">
            {Icon && (
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <Icon className="h-5 w-5" />
              </span>
            )}
            <div className="min-w-0 space-y-1 pt-0.5">
              <DialogTitle>{title}</DialogTitle>
              {description && <DialogDescription>{description}</DialogDescription>}
            </div>
          </div>
        </DialogHeader>

        {/* px simétrico: el overflow no recorta el focus-ring de los inputs de
            los bordes; scrollbar-slim = scroll moderno como el resto de la app. */}
        <div className="-mx-1 max-h-[min(60vh,32rem)] space-y-4 overflow-y-auto scrollbar-slim px-1">
          {children}
        </div>

        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
