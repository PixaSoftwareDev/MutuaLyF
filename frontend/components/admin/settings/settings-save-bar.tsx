"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Barra de guardado unificada de Configuración. Una sola pieza para las tres
 * pestañas (Asistente / Apariencia / Derivación) — antes cada una resolvía el
 * "guardar" distinto (botón pegado al textarea, footer en card, botón suelto al
 * final del scroll).
 *
 * Sticky al fondo del área de scroll: en formularios largos el botón queda
 * siempre a mano sin volver a scrollear, y nunca se encima al contenido. El
 * punto + texto avisan si hay cambios pendientes. Full-bleed dentro del
 * PageShell (compensa su padding con -mx) para leerse como barra, no como
 * elemento flotando suelto.
 */
export function SettingsSaveBar({
  dirty,
  pending,
  onSave,
  label = "Guardar cambios",
  className,
}: {
  dirty: boolean;
  pending: boolean;
  onSave: () => void;
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "sticky bottom-0 z-10 -mx-4 sm:-mx-6 mt-2 flex items-center justify-between gap-4 border-t",
        "bg-background/85 px-4 sm:px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/70",
        className,
      )}
    >
      <p className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dirty ? "bg-warning" : "bg-success/60")} />
        <span className="truncate">{dirty ? "Tenés cambios sin guardar." : "Todo guardado."}</span>
      </p>
      <Button onClick={onSave} disabled={!dirty || pending} className="shrink-0">
        {pending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
        {label}
      </Button>
    </div>
  );
}
