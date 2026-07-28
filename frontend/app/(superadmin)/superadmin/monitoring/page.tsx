"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatePill } from "@/components/ui/state-pill";
import { fmtBytes } from "@/components/superadmin/shared";
import { Panel, MeterRow, ServiceRow } from "@/components/superadmin/panel";
import { cn } from "@/lib/utils";
import { SuperShell } from "@/components/superadmin/shell";
import { svcTone, iaTone, worst, type Tone } from "@/components/superadmin/status";

/**
 * Monitoreo → Estado. "¿Está todo funcionando ahora?" Servicios y servidor
 * lado a lado, alertas debajo. Los errores, backups y métricas tienen su
 * propia entrada en el submenú.
 */

export default function MonitoringStatusPage() {
  const qc = useQueryClient();

  const { data: system, isLoading } = useQuery({
    queryKey: ["platform-system"], queryFn: api.tenants.platformSystem,
    refetchInterval: 30_000, staleTime: 15_000,
  });
  const { data: alertsData } = useQuery({
    queryKey: ["platform-alerts"], queryFn: api.tenants.platformAlerts,
    refetchInterval: 30_000, staleTime: 15_000,
  });

  const inv = () => {
    qc.invalidateQueries({ queryKey: ["platform-system"] });
    qc.invalidateQueries({ queryKey: ["platform-alerts"] });
  };

  const alerts = alertsData?.alerts ?? [];

  const services = system ? [
    { label: "Backend",        state: (system.backend.up ? "ok" : "down") as "ok" | "down" | "unknown" },
    { label: "PostgreSQL",     state: svcTone(system.postgres.up) as "ok" | "down" | "unknown" },
    { label: "Redis",          state: svcTone(system.redis.up) as "ok" | "down" | "unknown" },
    { label: "Servicio de IA", state: iaTone(system.groq) as "ok" | "down" | "unknown" },
  ] : [];

  const monitoringAvailable = system ? (system.monitoring_available ?? true) : true;
  const alertTone: Tone = alerts.some(a => a.severity === "critical") ? "down" : alerts.length > 0 ? "warn" : "ok";
  const globalTone = worst([...services.map(s => s.state as Tone), alertTone]);

  return (
    <SuperShell
      title="Estado"
      badge={!isLoading && system ? (
        <span className={cn(
          "inline-flex items-center gap-1.5 text-xs font-medium",
          globalTone === "down" ? "text-destructive" : globalTone === "warn" ? "text-warning" : "text-success",
        )}>
          <span className={cn(
            "h-1.5 w-1.5 rounded-full",
            globalTone === "down" ? "bg-destructive animate-pulse motion-reduce:animate-none" : globalTone === "warn" ? "bg-warning" : "bg-success",
          )} />
          {globalTone === "down" ? "Hay un problema" : globalTone === "warn" ? "Con avisos" : "Todo operativo"}
        </span>
      ) : undefined}
      actions={
        <Button variant="ghost" size="icon" onClick={inv} className="h-8 w-8" title="Actualizar">
          <RefreshCw className="h-4 w-4" />
        </Button>
      }
    >
      {isLoading && !system ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {[1, 2].map(i => <Skeleton key={i} className="h-56 rounded-xl" />)}
        </div>
      ) : !system ? null : (
      <div className="space-y-4 pb-6 animate-fade-in">

        <div className="grid items-start gap-4 lg:grid-cols-2">

          {/* ── Servicios ── */}
          <Panel title="Servicios" sub={monitoringAvailable ? undefined : "sin monitoreo en este entorno"}>
            <div className="divide-y divide-border/50">
              {services.map(s => <ServiceRow key={s.label} label={s.label} state={s.state} />)}
            </div>
          </Panel>

          {/* ── Servidor — memoria, CPU y disco con barras ── */}
          <Panel title="Servidor" sub="recursos del host">
            {(() => {
              const srv = system.server;
              const st  = system.storage;
              const tone = (pct: number | null, warn: number, down: number) =>
                pct == null ? undefined : pct >= down ? "down" as const : pct >= warn ? "warn" as const : undefined;
              return (
                <div className="divide-y divide-border/50">
                  <MeterRow
                    label="Memoria"
                    pct={srv?.mem_used_pct ?? null}
                    valueLabel={srv?.mem_used_pct != null && srv.mem_total_bytes != null
                      ? `${srv.mem_used_pct.toFixed(0)}% de ${fmtBytes(srv.mem_total_bytes)}`
                      : "Sin datos"}
                    tone={tone(srv?.mem_used_pct ?? null, 80, 92)}
                  />
                  <MeterRow
                    label="CPU"
                    hint={srv?.cpus ? `${srv.cpus} núcleos` : undefined}
                    pct={srv?.load_pct != null ? Math.min(srv.load_pct, 100) : null}
                    valueLabel={srv?.load_pct != null ? `${srv.load_pct.toFixed(0)}% de carga` : "Sin datos"}
                    tone={tone(srv?.load_pct ?? null, 80, 95)}
                  />
                  <MeterRow
                    label="Disco"
                    hint={st?.free_bytes != null ? `libres ${fmtBytes(st.free_bytes)}` : undefined}
                    pct={st?.used_pct ?? null}
                    valueLabel={st?.used_pct != null && st.total_bytes != null
                      ? `${st.used_pct.toFixed(0)}% de ${fmtBytes(st.total_bytes)}`
                      : "Sin datos"}
                    tone={tone(st?.used_pct ?? null, 70, 85)}
                  />
                </div>
              );
            })()}
          </Panel>

        </div>

        {/* ── Alertas activas ── */}
        <Panel
          title="Alertas activas"
          sub="las mismas que llegan por email"
          action={alerts.length > 0
            ? <StatePill tone="destructive">{alerts.length}</StatePill>
            : undefined}
        >
          {!alertsData?.available ? (
            <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
              <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
              No se pudo consultar Alertmanager.
            </p>
          ) : alerts.length === 0 ? (
            <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-success" /> Ninguna — todo en orden.
            </p>
          ) : (
            <div className="divide-y divide-border/50">
              {alerts.map((a, i) => (
                <div key={i} className="flex items-start gap-3 px-4 py-3">
                  <StatePill tone={a.severity === "critical" ? "destructive" : "warning"} className="mt-0.5 shrink-0">
                    {a.severity === "critical" ? "Crítica" : "Aviso"}
                  </StatePill>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{a.name}</p>
                    {a.summary && <p className="mt-0.5 text-xs text-muted-foreground">{a.summary}</p>}
                    {a.since && (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        desde {new Date(a.since).toLocaleString("es-AR")}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {!monitoringAvailable && (
          <p className="px-1 text-[11px] leading-snug text-muted-foreground/70">
            El monitoreo detallado (Prometheus) no está activo en este entorno — los servicios sin datos se muestran en gris.
          </p>
        )}

      </div>
      )}
    </SuperShell>
  );
}
