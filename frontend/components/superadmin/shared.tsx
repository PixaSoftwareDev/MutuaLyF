"use client";

/**
 * Piezas compartidas del panel de plataforma (super-admin): formatos y
 * componentes de métricas que usan Inicio, Organizaciones y Monitoreo.
 */

import { type LucideIcon } from "lucide-react";
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

export function fmtTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString("es-AR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

// ── Fila de error del buffer (misma vista en Inicio y Monitoreo) ─────────────

export type PlatformError = {
  ts: number; level: string; logger: string; message: string;
  detail?: string; count?: number;
};

export function ErrorRow({ e }: { e: PlatformError }) {
  const isError = e.level === "ERROR";
  return (
    <div className="px-3.5 py-2.5 flex items-start gap-2.5">
      <span className={cn(
        "shrink-0 mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold",
        isError ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning"
      )}>
        {isError ? "ERROR" : "WARN"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium leading-snug break-words">
          {e.message}
          {(e.count ?? 1) > 1 && (
            <span className="ml-2 inline-flex items-center rounded-full bg-muted px-1.5 py-px text-[10px] font-semibold text-muted-foreground tabular-nums align-middle">
              ×{e.count}
            </span>
          )}
        </p>
        {e.detail && (
          <p className="font-mono text-[11px] text-muted-foreground break-all leading-relaxed mt-0.5 line-clamp-2">
            {e.detail}
          </p>
        )}
        <p className="text-[10px] text-muted-foreground/80 mt-0.5 tabular-nums">
          {fmtTs(e.ts)} · {e.logger}
        </p>
      </div>
    </div>
  );
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

// ── KPI unificado (ícono opcional + acento; mismo lenguaje en Inicio y
//    Organizaciones). El color aparece SOLO cuando expresa estado (tone) o
//    cuando es una métrica de marca (accentBrand). ────────────────────────────

export function Kpi({ icon: Icon, label, value, tone = "neutral", accentBrand, sublabel, loading }: {
  icon?: LucideIcon;
  label: string;
  value: string | number;
  tone?: "neutral" | "success" | "warn" | "danger";
  accentBrand?: boolean;
  sublabel?: string;
  loading?: boolean;
}) {
  const accent =
    accentBrand        ? "before:bg-action-gradient" :
    tone === "success" ? "before:bg-success" :
    tone === "warn"    ? "before:bg-warning" :
    tone === "danger"  ? "before:bg-destructive" :
                         "before:bg-border";
  const numColor =
    tone === "success" ? "text-success" :
    tone === "warn"    ? "text-warning" :
    tone === "danger"  ? "text-destructive" :
                         "text-foreground";
  const iconColor =
    accentBrand        ? "text-action/70" :
    tone === "success" ? "text-success/70" :
    tone === "warn"    ? "text-warning/70" :
    tone === "danger"  ? "text-destructive/70" :
                         "text-muted-foreground/50";
  return (
    <div className={cn(
      "relative overflow-hidden rounded-xl border bg-card px-4 py-3.5 shadow-sm",
      "before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:content-['']",
      accent,
    )}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</span>
        {Icon && <Icon className={cn("h-4 w-4 shrink-0", iconColor)} />}
      </div>
      {loading
        ? <Skeleton className="mt-2 h-8 w-16" />
        : <div className={cn("mt-1.5 text-3xl font-semibold tabular-nums leading-none", numColor)}>
            {typeof value === "number" ? value.toLocaleString("es-AR") : value}
          </div>}
      {sublabel && !loading && (
        <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">{sublabel}</p>
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

// ── Tile de métrica (mismo lenguaje que HeaderKpi: label arriba, valor abajo;
//    color SOLO cuando expresa estado — los números normales van neutros) ─────

const TILE_TONE: Record<string, string> = {
  neutral: "text-foreground",
  success: "text-success",
  warn:    "text-warning",
  danger:  "text-destructive",
};

export function StatTile({ label, value, tone = "neutral", sublabel }: {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "warn" | "danger";
  sublabel?: string;
}) {
  const accent =
    tone === "success" ? "before:bg-success" :
    tone === "warn"    ? "before:bg-warning" :
    tone === "danger"  ? "before:bg-destructive" :
                         "before:bg-border";
  return (
    <div className={cn(
      "relative overflow-hidden rounded-xl border bg-card px-3.5 py-3 shadow-sm",
      "before:absolute before:left-0 before:top-0 before:bottom-0 before:w-0.5 before:content-['']",
      accent,
    )}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground leading-tight">
        {label}
      </p>
      <p className={cn("mt-1 text-xl font-semibold tabular-nums leading-none", TILE_TONE[tone])}>{value}</p>
      {sublabel && <p className="text-[11px] text-muted-foreground/70 mt-1">{sublabel}</p>}
    </div>
  );
}

// ── Backups y disco ───────────────────────────────────────────────────────────

export function BackupStat({ label, b }: {
  label: string;
  b?: { filename: string; size_bytes: number; age_hours: number; healthy: boolean; count: number } | null;
}) {
  return (
    <div className="rounded-lg bg-muted/50 px-3.5 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground leading-tight">{label}</p>
      {!b ? (
        <p className="mt-1 text-lg font-semibold text-muted-foreground leading-none">—</p>
      ) : (
        <>
          <p className={cn("mt-1 text-lg font-semibold flex items-center gap-1.5 leading-none", b.healthy ? "text-success" : "text-destructive")}>
            <span className={cn("h-1.5 w-1.5 rounded-full", b.healthy ? "bg-success" : "bg-destructive")} />
            {b.healthy ? "OK" : "Vencido"}
            <span className="text-sm font-medium text-muted-foreground">· {relAge(b.age_hours)}</span>
          </p>
          <p className="text-[11px] text-muted-foreground/80 mt-1 tabular-nums">
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
    <div className="rounded-lg bg-muted/50 px-3.5 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground leading-tight">Disco del servidor</p>
      {pct === null || !storage?.total_bytes ? (
        <p className="mt-1 text-lg font-semibold text-muted-foreground leading-none">—</p>
      ) : (
        <>
          <p className="mt-1 text-lg font-semibold tabular-nums leading-none">
            {pct.toFixed(0)}%
            <span className="text-sm font-medium text-muted-foreground"> usado · {fmtBytes(storage.free_bytes ?? 0)} libres</span>
          </p>
          <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
            <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
          <p className="text-[11px] text-muted-foreground/80 mt-1 tabular-nums">
            {fmtBytes(storage.used_bytes ?? 0)} de {fmtBytes(storage.total_bytes)}
          </p>
        </>
      )}
    </div>
  );
}
