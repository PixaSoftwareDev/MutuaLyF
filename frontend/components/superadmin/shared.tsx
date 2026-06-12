"use client";

/**
 * Piezas compartidas del panel de plataforma (super-admin): formatos y
 * componentes de métricas que usan Inicio, Organizaciones y Monitoreo.
 */

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// ── Formatos ──────────────────────────────────────────────────────────────────

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

export function fmtBytes(b: number): string {
  if (b >= 1_073_741_824) return (b / 1_073_741_824).toFixed(1) + " GB";
  if (b >= 1_048_576)     return (b / 1_048_576).toFixed(1) + " MB";
  if (b >= 1_024)         return (b / 1_024).toFixed(1) + " KB";
  return b + " B";
}

export function relAge(hours: number): string {
  if (hours < 1)  return `hace ${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `hace ${Math.round(hours)}h`;
  return `hace ${Math.round(hours / 24)}d`;
}

// ── KPI de cabecera (acento lateral, número 2xl) ─────────────────────────────

export function HeaderKpi({ label, value, tone = "neutral", loading }: {
  label: string;
  value: string | number;
  tone?: "neutral" | "success" | "warn" | "danger";
  loading?: boolean;
}) {
  const accent =
    tone === "danger"  ? "before:bg-destructive" :
    tone === "warn"    ? "before:bg-warning" :
    tone === "success" ? "before:bg-success" :
                         "before:bg-primary";
  const numColor =
    tone === "danger"  ? "text-destructive" :
    tone === "warn"    ? "text-warning" :
    tone === "success" ? "text-success" :
                         "text-foreground";
  return (
    <div
      className={cn(
        "relative bg-card border border-border rounded-xl pl-4 pr-4 py-3 shadow-sm overflow-hidden before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1",
        accent
      )}
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </div>
      {loading ? (
        <Skeleton className="h-7 w-16 mt-1.5" />
      ) : (
        <div className={cn("mt-1 text-2xl font-semibold tabular-nums leading-none", numColor)}>
          {typeof value === "number" ? value.toLocaleString("es-AR") : value}
        </div>
      )}
    </div>
  );
}

// ── Sección con cabecera de icono en gradient ────────────────────────────────

export function Section({ icon: Icon, label, sublabel, children }: {
  icon: any; label: string; sublabel?: string; children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border bg-card shadow overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b bg-muted/30">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-action-gradient-soft shrink-0">
          <Icon className="h-4 w-4 text-action" />
        </span>
        <span className="text-sm font-semibold">{label}</span>
        {sublabel && <span className="text-xs text-muted-foreground">{sublabel}</span>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

export function SysKPI({ label, value, color, sublabel }: { label: string; value: string; color: string; sublabel?: string }) {
  return (
    <div className="rounded-lg border bg-background px-3 py-2.5">
      <p className={cn("text-lg font-bold tabular-nums leading-none", color)}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1.5 leading-tight">{label}</p>
      {sublabel && <p className="text-[11px] text-muted-foreground/70 mt-0.5">{sublabel}</p>}
    </div>
  );
}

// ── Backups y disco ───────────────────────────────────────────────────────────

export function BackupStat({ label, b }: {
  label: string;
  b?: { filename: string; size_bytes: number; age_hours: number; healthy: boolean; count: number } | null;
}) {
  return (
    <div className="rounded-lg border bg-background px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      {!b ? (
        <p className="mt-1 text-sm font-semibold text-muted-foreground">Sin datos</p>
      ) : (
        <>
          <p className={cn("mt-1 text-sm font-bold flex items-center gap-1.5", b.healthy ? "text-success" : "text-destructive")}>
            <span className={cn("h-1.5 w-1.5 rounded-full", b.healthy ? "bg-success" : "bg-destructive")} />
            {b.healthy ? "OK" : "Vencido"}
            <span className="font-medium text-muted-foreground">· {relAge(b.age_hours)}</span>
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5 tabular-nums">
            {fmtBytes(b.size_bytes)} · {b.count} guardados
          </p>
        </>
      )}
    </div>
  );
}

export function DiskStat({ storage }: {
  storage?: { total_bytes: number | null; used_bytes: number | null; free_bytes: number | null; used_pct: number | null };
}) {
  const pct = storage?.used_pct ?? null;
  const tone =
    pct === null ? "bg-muted-foreground/40" :
    pct >= 85    ? "bg-destructive" :
    pct >= 70    ? "bg-warning" :
                   "bg-success";
  return (
    <div className="rounded-lg border bg-background px-3 py-2.5">
      <p className="text-xs text-muted-foreground">Disco del servidor</p>
      {pct === null || !storage?.total_bytes ? (
        <p className="mt-1 text-sm font-semibold text-muted-foreground">Sin datos</p>
      ) : (
        <>
          <p className="mt-1 text-sm font-bold tabular-nums">
            {pct.toFixed(0)}% usado
            <span className="font-medium text-muted-foreground"> · {fmtBytes(storage.free_bytes ?? 0)} libres</span>
          </p>
          <div className="mt-1.5 h-1.5 rounded-full bg-muted overflow-hidden">
            <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
          <p className="text-[11px] text-muted-foreground mt-1 tabular-nums">
            {fmtBytes(storage.used_bytes ?? 0)} de {fmtBytes(storage.total_bytes)}
          </p>
        </>
      )}
    </div>
  );
}
