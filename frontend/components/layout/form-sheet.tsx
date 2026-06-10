"use client";

import type { LucideIcon } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  /** Acciones del pie (Cancelar / Guardar). Siempre visibles, no scrollean. */
  footer: React.ReactNode;
  children: React.ReactNode;
  className?: string;
};

/**
 * Panel lateral estándar para crear/editar entidades del back-office
 * (sectores, operadores…). Reemplaza a los Dialog centrados: header con tile
 * de marca, cuerpo scrolleable y footer fijo. Los Dialog quedan reservados
 * para confirmaciones destructivas.
 */
export function FormSheet({
  open, onOpenChange, icon: Icon, title, description, footer, children, className,
}: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className={cn("w-full sm:max-w-md p-0 gap-0", className)}>
        <SheetHeader className="px-6 pt-6 pb-5 border-b border-border/70">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-action-gradient-soft">
              <Icon className="h-5 w-5 text-action" />
            </div>
            <div className="min-w-0 space-y-0.5">
              <SheetTitle>{title}</SheetTitle>
              {description && <SheetDescription>{description}</SheetDescription>}
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-6">{children}</div>

        <SheetFooter className="gap-2 border-t border-border/70 bg-muted/30 px-6 py-4">
          {footer}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
