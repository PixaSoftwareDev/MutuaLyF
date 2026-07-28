"use client";

// Kit visual del superadmin — las TRES piezas con las que se arma cualquier
// sección: Panel (tarjeta con encabezado), KVRow (fila clave-valor) y
// MeterRow (fila con barra de progreso para porcentajes). Un solo lenguaje:
// lo que está mal se tiñe (amarillo/rojo), lo sano es texto tranquilo.

import { cn } from "@/lib/utils";

export function Panel({ title, sub, action, children, className }: {
  title: string;
  sub?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("overflow-hidden rounded-xl border bg-card", className)}>
      <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-4 py-3">
        <h2 className="min-w-0 truncate text-sm font-semibold">
          {title}
          {sub && <span className="ml-2 text-xs font-normal text-muted-foreground">{sub}</span>}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export type RowTone = "warn" | "down" | undefined;

const VALUE_TONE: Record<string, string> = {
  down: "text-destructive",
  warn: "text-warning",
};

export function KVRow({ label, value, hint, tone }: {
  label: string; value: React.ReactNode; hint?: string; tone?: RowTone;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="min-w-0 truncate text-[13px] text-muted-foreground">
        {label}{hint && <span className="text-muted-foreground/60"> · {hint}</span>}
      </span>
      <span className={cn(
        "shrink-0 text-right text-sm font-semibold tabular-nums",
        tone ? VALUE_TONE[tone] : "text-foreground",
      )}>{value}</span>
    </div>
  );
}

/** Fila con barra de progreso — para todo lo que es un porcentaje (memoria,
 *  disco, cuotas, hit rates). La barra se tiñe según el umbral. */
export function MeterRow({ label, pct, valueLabel, tone, hint }: {
  label: string;
  pct: number | null;          // 0-100; null = sin datos
  valueLabel: string;          // "42% de 8 GB", "1.2K / 5K"
  tone?: RowTone;
  hint?: string;
}) {
  const bar =
    tone === "down" ? "bg-destructive" :
    tone === "warn" ? "bg-warning" :
    "bg-success";
  return (
    <div className="px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between gap-4">
        <span className="min-w-0 truncate text-[13px] text-muted-foreground">
          {label}{hint && <span className="text-muted-foreground/60"> · {hint}</span>}
        </span>
        <span className={cn(
          "shrink-0 text-right text-sm font-semibold tabular-nums",
          tone ? VALUE_TONE[tone] : "text-foreground",
        )}>{valueLabel}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {pct != null && (
          <div className={cn("h-full rounded-full transition-all", bar)} style={{ width: `${Math.min(Math.max(pct, 1.5), 100)}%` }} />
        )}
      </div>
    </div>
  );
}

/** Fila de servicio: punto de estado + nombre + estado en palabras. */
export function ServiceRow({ label, state, detail }: {
  label: string;
  state: "ok" | "down" | "unknown";
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className={cn(
        "h-2.5 w-2.5 shrink-0 rounded-full",
        state === "down" ? "bg-destructive animate-pulse motion-reduce:animate-none" :
        state === "unknown" ? "bg-muted-foreground/40" : "bg-success",
      )} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{label}</span>
      <span className={cn(
        "shrink-0 text-xs",
        state === "down" ? "font-semibold text-destructive" : "text-muted-foreground",
      )}>{detail ?? (state === "down" ? "Caído" : state === "unknown" ? "Sin datos" : "Operativo")}</span>
    </div>
  );
}
