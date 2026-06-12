"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw, Database, Server, Zap, Bot, BarChart3, HardDrive,
  AlertTriangle, BellRing, Bug, CheckCircle2,
} from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader, CountChip } from "@/components/layout/page-header";
import {
  fmtNum, fmtBytes, Section, SysKPI, BackupStat, DiskStat,
} from "@/components/superadmin/shared";
import { cn } from "@/lib/utils";

function fmtTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString("es-AR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export default function MonitoringPage() {
  const qc = useQueryClient();
  const [levelFilter, setLevelFilter] = useState<string>("");

  const { data: system, isLoading } = useQuery({
    queryKey: ["platform-system"], queryFn: api.tenants.platformSystem,
    refetchInterval: 30_000, staleTime: 15_000,
  });
  const { data: alertsData } = useQuery({
    queryKey: ["platform-alerts"], queryFn: api.tenants.platformAlerts,
    refetchInterval: 30_000, staleTime: 15_000,
  });
  const { data: errorsData } = useQuery({
    queryKey: ["platform-errors"], queryFn: () => api.tenants.platformErrors(100),
    refetchInterval: 30_000, staleTime: 15_000,
  });

  const inv = () => {
    qc.invalidateQueries({ queryKey: ["platform-system"] });
    qc.invalidateQueries({ queryKey: ["platform-alerts"] });
    qc.invalidateQueries({ queryKey: ["platform-errors"] });
  };

  const alerts = alertsData?.alerts ?? [];
  const errors = (errorsData?.errors ?? []).filter(e => !levelFilter || e.level === levelFilter);

  const services = system ? [
    { label: "PostgreSQL", up: system.postgres.up,  icon: Database },
    { label: "Redis",      up: system.redis.up,     icon: Zap },
    { label: "Backend",    up: system.backend.up,   icon: Server },
    {
      label: "Groq",
      up: system.groq.total_calls === 0 ? true : (system.groq.by_model ?? []).every((m: any) => m.errors === 0 || m.errors < m.total),
      icon: Bot,
    },
  ] : [];

  return (
    <PageShell>
      <PageHeader
        eyebrow="Plataforma"
        title="Monitoreo"
        badge={alerts.length > 0
          ? <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-[12px] font-semibold text-destructive">
              {alerts.length} {alerts.length === 1 ? "alerta activa" : "alertas activas"}
            </span>
          : <CountChip>Sin alertas activas</CountChip>}
        description="Salud de la infraestructura, alertas, errores recientes y backups — todo en un solo lugar."
        actions={
          <Button variant="ghost" size="icon" onClick={inv} className="h-9 w-9" title="Actualizar">
            <RefreshCw className="h-4 w-4" />
          </Button>
        }
      />

      {isLoading && !system ? (
        <div className="space-y-4">
          {[1,2,3].map(i => <Skeleton key={i} className="h-32 rounded-2xl" />)}
        </div>
      ) : !system ? null : (
      <div className="space-y-5 pb-6 animate-fade-in">

        {/* ── Servicios — primer nivel ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          {services.map(s => (
            <div
              key={s.label}
              className={cn(
                "flex items-center gap-3 rounded-xl border px-4 py-3.5 shadow-sm",
                s.up ? "bg-success/10 border-success/20" : "bg-destructive/10 border-destructive/20"
              )}
            >
              <span className={cn(
                "flex items-center justify-center h-9 w-9 rounded-lg shrink-0",
                s.up ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"
              )}>
                <s.icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">{s.label}</p>
                <p className={cn("text-xs font-medium flex items-center gap-1", s.up ? "text-success" : "text-destructive")}>
                  <span className={cn("h-1.5 w-1.5 rounded-full", s.up ? "bg-success" : "bg-destructive")} />
                  {s.up ? "Operativo" : "Caído"}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* ── Alertas activas (Alertmanager) ── */}
        <Section icon={BellRing} label="Alertas activas" sublabel="las mismas que llegan por email, en vivo">
          {!alertsData?.available ? (
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
              No se pudo consultar Alertmanager.
            </p>
          ) : alerts.length === 0 ? (
            <p className="text-sm text-success flex items-center gap-2 font-medium">
              <CheckCircle2 className="h-4 w-4 shrink-0" /> Sin alertas activas — todo en orden.
            </p>
          ) : (
            <div className="space-y-2">
              {alerts.map((a, i) => (
                <div key={i} className={cn(
                  "rounded-lg border px-3.5 py-2.5 flex items-start gap-2.5",
                  a.severity === "critical"
                    ? "bg-destructive/10 border-destructive/20"
                    : "bg-warning/10 border-warning/20"
                )}>
                  <AlertTriangle className={cn("h-4 w-4 mt-0.5 shrink-0", a.severity === "critical" ? "text-destructive" : "text-warning")} />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{a.name}</p>
                    {a.summary && <p className="text-xs text-muted-foreground mt-0.5">{a.summary}</p>}
                    {a.since && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        desde {new Date(a.since).toLocaleString("es-AR")}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* ── Errores recientes del backend ── */}
        <Section icon={Bug} label="Errores recientes" sublabel="warnings y errores del backend — sin salir del panel">
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-xs text-muted-foreground">
              Últimos {errors.length} registros{levelFilter ? ` de nivel ${levelFilter}` : ""}.
            </p>
            <Select value={levelFilter || "all"} onValueChange={v => setLevelFilter(v === "all" ? "" : v)}>
              <SelectTrigger className="h-8 w-auto min-w-[130px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los niveles</SelectItem>
                <SelectItem value="ERROR">Solo errores</SelectItem>
                <SelectItem value="WARNING">Solo warnings</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {errors.length === 0 ? (
            <p className="text-sm text-success flex items-center gap-2 font-medium">
              <CheckCircle2 className="h-4 w-4 shrink-0" /> Sin registros recientes.
            </p>
          ) : (
            <div className="rounded-lg border divide-y max-h-[420px] overflow-y-auto scrollbar-slim">
              {errors.map((e, i) => (
                <div key={i} className="px-3 py-2 flex items-start gap-2.5 text-xs">
                  <span className={cn(
                    "shrink-0 mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold",
                    e.level === "ERROR" ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning"
                  )}>
                    {e.level === "ERROR" ? "ERROR" : "WARN"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono break-all leading-relaxed">{e.message}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">
                      {fmtTs(e.ts)} · {e.logger}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* ── Backups y disco ── */}
        <Section icon={HardDrive} label="Backups y disco" sublabel="pg_dump diario 03:00 UTC · semanal los domingos · retención 7d/4sem">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <BackupStat label="Backup diario"  b={system.backups?.daily} />
            <BackupStat label="Backup semanal" b={system.backups?.weekly} />
            <DiskStat storage={system.storage} />
          </div>
          {system.backups == null && (
            <p className="mt-2.5 text-xs text-warning flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Sin acceso al repositorio de backups — verificá que el volumen esté montado en el backend.
            </p>
          )}
        </Section>

        {/* ── Detalle granular ── */}
        <div className="flex items-center gap-2 pt-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Métricas detalladas</span>
          <Separator className="flex-1" />
        </div>

        <Section icon={BarChart3} label="Aplicación" sublabel="métricas acumuladas desde inicio">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
            <SysKPI label="Tenants activos"   value={String(system.app.active_tenants)} color="text-primary" />
            <SysKPI label="Consultas totales" value={fmtNum(system.app.total_queries)} color="text-primary" />
            <SysKPI label="Cache hits"        value={fmtNum(system.app.total_cache_hits)} color="text-info" />
            <SysKPI label="Ingestas totales"  value={fmtNum(system.app.total_ingests)} color="text-violet-600" />
            <SysKPI label="HTTP requests"     value={fmtNum(system.backend.total_requests)} color="text-muted-foreground" />
          </div>
        </Section>

        <Section icon={Server} label="Backend API" sublabel="últimos 10 min">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            <SysKPI
              label="Estado"
              value={system.backend.up ? "OK" : "DOWN"}
              color={system.backend.up ? "text-success" : "text-destructive"}
            />
            <SysKPI
              label="Latencia p95"
              value={system.backend.latency_p95_ms != null ? system.backend.latency_p95_ms.toFixed(0) + "ms" : "—"}
              color={
                system.backend.latency_p95_ms == null ? "text-muted-foreground" :
                system.backend.latency_p95_ms > 2000 ? "text-destructive" :
                system.backend.latency_p95_ms > 1000 ? "text-warning" : "text-success"
              }
            />
            <SysKPI
              label="Error rate 5m"
              value={system.backend.error_rate_5m > 0 ? (system.backend.error_rate_5m * 100).toFixed(2) + "%" : "0%"}
              color={system.backend.error_rate_5m > 0.01 ? "text-destructive" : "text-success"}
            />
          </div>
        </Section>

        <Section icon={Database} label="PostgreSQL" sublabel={`${fmtBytes(system.postgres.db_size_bytes)} · plataforma`}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <SysKPI
              label="Estado"
              value={system.postgres.up ? "OK" : "DOWN"}
              color={system.postgres.up ? "text-success" : "text-destructive"}
            />
            <SysKPI label="Conexiones activas" value={String(system.postgres.connections)} color="text-foreground" />
            <SysKPI
              label="Cache hit rate"
              value={system.postgres.cache_hit_rate != null ? (system.postgres.cache_hit_rate * 100).toFixed(1) + "%" : "—"}
              color={
                system.postgres.cache_hit_rate == null ? "text-muted-foreground" :
                system.postgres.cache_hit_rate < 0.9 ? "text-warning" : "text-success"
              }
              sublabel="buffer pool"
            />
            <SysKPI
              label="Deadlocks"
              value={String(system.postgres.deadlocks_total)}
              color={system.postgres.deadlocks_total > 0 ? "text-destructive" : "text-success"}
              sublabel="acumulados"
            />
          </div>
        </Section>

        <Section icon={Zap} label="Redis" sublabel="broker DB0 · cache DB1 · rate-limit DB2">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
            <SysKPI
              label="Estado"
              value={system.redis.up ? "OK" : "DOWN"}
              color={system.redis.up ? "text-success" : "text-destructive"}
            />
            <SysKPI
              label="Memoria usada"
              value={fmtBytes(system.redis.memory_used_bytes)}
              sublabel={system.redis.memory_max_bytes > 0 ? `/ ${fmtBytes(system.redis.memory_max_bytes)}` : "sin límite"}
              color="text-foreground"
            />
            <SysKPI
              label="Hit rate keyspace"
              value={system.redis.keyspace_hit_rate != null ? (system.redis.keyspace_hit_rate * 100).toFixed(1) + "%" : "—"}
              color={
                system.redis.keyspace_hit_rate == null ? "text-muted-foreground" :
                system.redis.keyspace_hit_rate < 0.3 ? "text-warning" : "text-success"
              }
            />
            <SysKPI label="Clientes conectados" value={String(system.redis.connected_clients)} color="text-foreground" />
            <SysKPI
              label="Claves broker (DB0)"
              value={String(system.redis.keys_by_db?.db0 ?? 0)}
              sublabel="jobs pendientes"
              color="text-foreground"
            />
            <SysKPI
              label="Cache entries (DB1)"
              value={String(system.redis.keys_by_db?.db1 ?? 0)}
              color="text-foreground"
            />
            <SysKPI
              label="Evictions"
              value={String(system.redis.evicted_keys)}
              color={system.redis.evicted_keys > 0 ? "text-destructive" : "text-success"}
              sublabel={system.redis.evicted_keys > 0 ? "memoria insuficiente" : "OK"}
            />
            <SysKPI
              label="Fragmentación"
              value={system.redis.fragmentation_ratio.toFixed(2) + "x"}
              color={
                system.redis.fragmentation_ratio > 1.5 ? "text-warning" :
                system.redis.fragmentation_ratio < 0.7 ? "text-warning" : "text-success"
              }
              sublabel={system.redis.slowlog_length > 0 ? `slowlog: ${system.redis.slowlog_length}` : undefined}
            />
          </div>
        </Section>

        <Section icon={Bot} label="Groq API" sublabel="llamadas acumuladas desde inicio del proceso">
          {system.groq.total_calls === 0 ? (
            <p className="text-sm text-muted-foreground py-2">Sin llamadas registradas aún. Los contadores se resetean al reiniciar el backend.</p>
          ) : (
            <div className="space-y-2">
              {system.groq.by_model.map((m: any) => (
                <div key={m.model} className="rounded-lg border bg-muted/30 px-4 py-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <code className="text-xs font-mono text-foreground">{m.model}</code>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="tabular-nums">{fmtNum(m.total)} llamadas</span>
                      {m.errors > 0 && (
                        <span className="text-destructive font-medium">{m.errors} errores</span>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {Object.entries(m.calls as Record<string, number>).map(([status, count]) => (
                      <span key={status} className={cn("text-xs px-2 py-0.5 rounded-full",
                        status === "success"    ? "bg-success/10 text-success" :
                        status === "error"      ? "bg-destructive/10 text-destructive" :
                        status === "timeout"    ? "bg-warning/10 text-warning" :
                        status === "rate_limit" ? "bg-warning/10 text-warning" :
                        "bg-muted text-muted-foreground"
                      )}>
                        {status}: {count}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

      </div>
      )}
    </PageShell>
  );
}
