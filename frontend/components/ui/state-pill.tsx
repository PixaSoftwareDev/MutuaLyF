import { cn } from "@/lib/utils";

/**
 * Pastilla de estado unificada (punto + texto), tone-based. Mismo lenguaje que
 * sectores/operadores/canales. Reutilizable en admin y super-admin para que
 * "activo/inactivo/pendiente/error" se vean igual en todo el panel.
 *
 *   <StatePill tone="success">Activo</StatePill>
 *   <StatePill tone={ok ? "success" : "muted"}>{ok ? "Activo" : "Inactivo"}</StatePill>
 */
const TONES = {
  success:     { pill: "border-success/30 bg-success/[0.08] text-success",             dot: "bg-success" },
  warning:     { pill: "border-warning/30 bg-warning/[0.08] text-warning",             dot: "bg-warning" },
  destructive: { pill: "border-destructive/30 bg-destructive/[0.08] text-destructive", dot: "bg-destructive" },
  info:        { pill: "border-info/30 bg-info/[0.08] text-info",                       dot: "bg-info" },
  muted:       { pill: "border-border bg-muted/50 text-muted-foreground",              dot: "bg-muted-foreground/40" },
} as const;

export type StatePillTone = keyof typeof TONES;

export function StatePill({ tone = "muted", children, className }: {
  tone?: StatePillTone;
  children: React.ReactNode;
  className?: string;
}) {
  const t = TONES[tone];
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
      t.pill, className,
    )}>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", t.dot)} />
      {children}
    </span>
  );
}
