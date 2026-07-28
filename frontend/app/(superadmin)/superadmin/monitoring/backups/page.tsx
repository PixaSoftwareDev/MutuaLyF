"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, XCircle, HardDrive } from "lucide-react";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { StatePill } from "@/components/ui/state-pill";
import { fmtBytes } from "@/components/superadmin/shared";
import { Panel, MeterRow } from "@/components/superadmin/panel";
import { cn } from "@/lib/utils";
import { SuperShell } from "@/components/superadmin/shell";

/**
 * Monitoreo → Backups. "¿Si hoy pierdo el servidor, tengo desde dónde
 * restaurar?" Diario y semanal como tarjetas de veredicto, el disco con
 * barra, y la semana completa de dumps para ver que ninguno falló.
 */

function relAgeH(hours: number): string {
  if (hours < 1) return "hace menos de 1 h";
  if (hours < 48) return `hace ${Math.round(hours)} h`;
  return `hace ${Math.round(hours / 24)} días`;
}

function BackupCard({ label, b }: {
  label: string;
  b: { age_hours: number; size_bytes: number; healthy: boolean; count: number } | null | undefined;
}) {
  const ok = b?.healthy === true;
  const Icon = b == null ? AlertTriangle : ok ? CheckCircle2 : XCircle;
  const color = b == null ? "text-warning" : ok ? "text-success" : "text-destructive";
  return (
    <div className="rounded-xl border bg-card px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className={cn("h-4 w-4 shrink-0", color)} />
      </div>
      <p className={cn("mt-1.5 text-2xl font-semibold leading-none tracking-tight", color)}>
        {b == null ? "Sin dumps" : ok ? "Al día" : "Vencido"}
      </p>
      {b != null && (
        <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
          {relAgeH(b.age_hours)} · {fmtBytes(b.size_bytes)} · {b.count} guardados
        </p>
      )}
    </div>
  );
}

export default function MonitoringBackupsPage() {
  const { data: system, isLoading } = useQuery({
    queryKey: ["platform-system"], queryFn: api.tenants.platformSystem,
    refetchInterval: 60_000, staleTime: 30_000,
  });

  const b = system?.backups;
  const st = system?.storage;
  const history = b?.daily_history ?? [];
  const sizes = [...history.map(h => h.size_bytes)].sort((x, y) => x - y);
  const median = sizes[Math.floor(sizes.length / 2)] || 0;

  return (
    <SuperShell
      title="Backups"
      badge={<span className="hidden text-xs text-muted-foreground sm:inline">diario 03:00 UTC · semanal los domingos · retención 7d/4sem</span>}
    >
        {isLoading && !system ? (
          <div className="grid gap-3 sm:grid-cols-3">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-28 rounded-xl" />)}
          </div>
        ) : (
          <div className="space-y-4 pb-6">

            {b == null && (
              <p className="flex items-center gap-2 text-sm text-warning">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Sin acceso al repositorio de backups — verificá que el volumen esté montado en el backend.
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <BackupCard label="Backup diario" b={b?.daily} />
              <BackupCard label="Backup semanal" b={b?.weekly} />
              <div className="rounded-xl border bg-card px-4 py-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Disco del servidor</span>
                  <HardDrive className={cn(
                    "h-4 w-4 shrink-0",
                    st?.used_pct != null && st.used_pct >= 85 ? "text-destructive" :
                    st?.used_pct != null && st.used_pct >= 70 ? "text-warning" : "text-success",
                  )} />
                </div>
                <p className="mt-1.5 text-2xl font-semibold leading-none tracking-tight tabular-nums">
                  {st?.used_pct != null ? `${st.used_pct.toFixed(0)}%` : "—"}
                </p>
                <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  {st?.used_pct != null && (
                    <div
                      className={cn(
                        "h-full rounded-full",
                        st.used_pct >= 85 ? "bg-destructive" : st.used_pct >= 70 ? "bg-warning" : "bg-success",
                      )}
                      style={{ width: `${Math.min(st.used_pct, 100)}%` }}
                    />
                  )}
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
                  {st?.free_bytes != null ? `libres ${fmtBytes(st.free_bytes)}` : "sin datos"}
                  {st?.total_bytes != null ? ` de ${fmtBytes(st.total_bytes)}` : ""}
                </p>
              </div>
            </div>

            {history.length > 0 && (
              <Panel title="Últimos diarios" sub="un dump mucho más chico que el resto es sospechoso">
                <div className="divide-y divide-border/50">
                  {history.map(h => {
                    const suspicious = median > 0 && h.size_bytes < median * 0.5;
                    return (
                      <div key={h.filename} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                        <span className="tabular-nums text-foreground">
                          {new Date(h.completed_at * 1000).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                        </span>
                        <span className={cn("tabular-nums", suspicious ? "font-medium text-warning" : "text-muted-foreground")}>
                          {fmtBytes(h.size_bytes)}
                        </span>
                        {suspicious && <StatePill tone="warning">más chico de lo normal</StatePill>}
                        <span className="ml-auto hidden truncate font-mono text-muted-foreground/60 sm:inline">{h.filename}</span>
                      </div>
                    );
                  })}
                </div>
              </Panel>
            )}

          </div>
        )}
    </SuperShell>
  );
}
