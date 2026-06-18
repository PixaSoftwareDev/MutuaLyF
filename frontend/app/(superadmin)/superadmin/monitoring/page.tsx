"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw, Database, Server, Zap, Bot, BarChart3, HardDrive,
  AlertTriangle, BellRing, Bug, CheckCircle2, ChevronDown,
} from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader, CountChip } from "@/components/layout/page-header";
import {
  fmtNum, fmtBytes, Section, StatTile, BackupStat, DiskStat, ErrorRow,
} from "@/components/superadmin/shared";
import { cn } from "@/lib/utils";

/** Historial de backups diarios: la semana entera de un vistazo. Un dump
 *  notablemente más chico que la mediana se marca en ámbar (sospechoso). */
function BackupHistory({ history }: {
  history?: Array<{ filename: string; completed_at: number; size_bytes: number }>;
}) {
  if (!history || history.length === 0) return null;
  const sizes = [...history.map(h => h.size_bytes)].sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] || 0;
  return (
    <div className="mt-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-1.5">
        Últimos diarios
      </p>
      <div className="rounded-lg border divide-y">
        {history.map(h => {
          const suspicious = median > 0 && h.size_bytes < median * 0.5;
          return (
            <div key={h.filename} className="flex items-center gap-2.5 px-3.5 py-2 text-xs">
              <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", suspicious ? "bg-warning" : "bg-success")} />
              <span className="tabular-nums text-foreground">
                {new Date(h.completed_at * 1000).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </span>
              <span className={cn("tabular-nums", suspicious ? "text-warning font-medium" : "text-muted-foreground")}>
                {fmtBytes(h.size_bytes)}{suspicious ? " — más chico de lo normal" : ""}
              </span>
              <span className="text-muted-foreground/60 font-mono truncate ml-auto hidden sm:inline">{h.filename}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Panel desplegable para un grupo de "Métricas detalladas". Cerrado por
 *  defecto: la salud crítica está arriba, el detalle técnico se expande. */
function CollapsibleMetric({ icon: Icon, label, sublabel, defaultOpen = false, children }: {
  icon: any; label: string; sublabel?: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-muted/30"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-action-gradient-soft shrink-0">
          <Icon className="h-3.5 w-3.5 text-action" />
        </span>
        <span className="text-sm font-semibold">{label}</span>
        {sublabel && <span className="text-xs text-muted-foreground truncate hidden sm:inline">{sublabel}</span>}
        <ChevronDown className={cn("ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="border-t p-4 animate-fade-in">{children}</div>}
    </div>
  );
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

        {/* ── Veredicto de salud del sistema ── */}
        {(() => {
          const down = services.filter(s => !s.up);
          const crit = alerts.filter(a => a.severity === "critical").length;
          const tone: "ok" | "warn" | "down" = down.length > 0 || crit > 0 ? "down" : alerts.length > 0 ? "warn" : "ok";
          const Icon = tone === "ok" ? CheckCircle2 : AlertTriangle;
          const cls = tone === "ok"
            ? "border-success/25 from-success/[0.10] text-success"
            : tone === "down"
            ? "border-destructive/30 from-destructive/[0.12] text-destructive"
            : "border-warning/30 from-warning/[0.12] text-warning";
          const title = tone === "ok" ? "Todo operativo" : tone === "down" ? "Requiere atención" : "Con avisos";
          const parts: string[] = [];
          if (down.length) parts.push(`${down.length} ${down.length === 1 ? "servicio caído" : "servicios caídos"}`);
          if (alerts.length) parts.push(`${alerts.length} ${alerts.length === 1 ? "alerta activa" : "alertas activas"}`);
          const summary = tone === "ok" ? "Servicios operativos y sin alertas activas." : parts.join(" · ");
          return (
            <div className={cn("rounded-2xl border bg-gradient-to-br to-transparent p-5", cls)}>
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-background/60">
                  <Icon className="h-6 w-6" />
                </div>
                <div className="min-w-0">
                  <p className="text-lg font-semibold tracking-tight text-foreground">{title}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{summary}</p>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Servicios — neutro cuando está bien, rojo solo cuando falla ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          {services.map(s => (
            <div
              key={s.label}
              className={cn(
                "flex items-center gap-3 rounded-xl border px-4 py-3.5 shadow-sm",
                s.up ? "bg-card" : "bg-destructive/10 border-destructive/20"
              )}
            >
              <span className={cn(
                "flex items-center justify-center h-9 w-9 rounded-lg shrink-0",
                s.up ? "bg-muted text-muted-foreground" : "bg-destructive/15 text-destructive"
              )}>
                <s.icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">{s.label}</p>
                <p className={cn("text-xs font-medium flex items-center gap-1.5", s.up ? "text-success" : "text-destructive")}>
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
              Repeticiones agrupadas — ×N indica cuántas veces ocurrió.
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
              {errors.map((e, i) => <ErrorRow key={i} e={e} />)}
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
          <BackupHistory history={system.backups?.daily_history} />
          {system.backups == null && (
            <p className="mt-2.5 text-xs text-warning flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Sin acceso al repositorio de backups — verificá que el volumen esté montado en el backend.
            </p>
          )}
        </Section>

        {/* ── Métricas detalladas — paneles desplegables ── */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-1 pt-1">
            <BarChart3 className="h-4 w-4 text-muted-foreground shrink-0" />
            <h2 className="text-sm font-semibold">Métricas detalladas</h2>
            <span className="text-xs text-muted-foreground">aplicación, API, bases y LLM · tocá para expandir</span>
          </div>

          <CollapsibleMetric icon={BarChart3} label="Aplicación" sublabel="acumulado desde inicio" defaultOpen>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
              <StatTile label="Tenants activos"   value={String(system.app.active_tenants)} />
              <StatTile label="Consultas totales" value={fmtNum(system.app.total_queries)} />
              <StatTile label="Cache hits"        value={fmtNum(system.app.total_cache_hits)} />
              <StatTile label="Ingestas totales"  value={fmtNum(system.app.total_ingests)} />
              <StatTile label="HTTP requests"     value={fmtNum(system.backend.total_requests)} />
            </div>
          </CollapsibleMetric>

          <CollapsibleMetric icon={Server} label="Backend API" sublabel="últimos 10 min">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              <StatTile
                label="Latencia p95"
                value={system.backend.latency_p95_ms != null ? system.backend.latency_p95_ms.toFixed(0) + "ms" : "—"}
                tone={
                  system.backend.latency_p95_ms == null ? "neutral" :
                  system.backend.latency_p95_ms > 2000 ? "danger" :
                  system.backend.latency_p95_ms > 1000 ? "warn" : "success"
                }
              />
              <StatTile
                label="Error rate 5m"
                value={system.backend.error_rate_5m > 0 ? (system.backend.error_rate_5m * 100).toFixed(2) + "%" : "0%"}
                tone={system.backend.error_rate_5m > 0.01 ? "danger" : "success"}
              />
              <StatTile label="HTTP requests" value={fmtNum(system.backend.total_requests)} sublabel="acumulado" />
            </div>
          </CollapsibleMetric>

          <CollapsibleMetric icon={Database} label="PostgreSQL" sublabel={`${fmtBytes(system.postgres.db_size_bytes)} · plataforma`}>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              <StatTile label="Conexiones activas" value={String(system.postgres.connections)} />
              <StatTile
                label="Cache hit rate"
                value={system.postgres.cache_hit_rate != null ? (system.postgres.cache_hit_rate * 100).toFixed(1) + "%" : "—"}
                tone={
                  system.postgres.cache_hit_rate == null ? "neutral" :
                  system.postgres.cache_hit_rate < 0.9 ? "warn" : "success"
                }
                sublabel="buffer pool"
              />
              <StatTile
                label="Deadlocks"
                value={String(system.postgres.deadlocks_total)}
                tone={system.postgres.deadlocks_total > 0 ? "danger" : "success"}
                sublabel="acumulados"
              />
            </div>
          </CollapsibleMetric>

          <CollapsibleMetric icon={Zap} label="Redis" sublabel="broker DB0 · cache DB1 · rate-limit DB2">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
              <StatTile
                label="Memoria usada"
                value={fmtBytes(system.redis.memory_used_bytes)}
                sublabel={system.redis.memory_max_bytes > 0 ? `de ${fmtBytes(system.redis.memory_max_bytes)}` : "sin límite"}
              />
              <StatTile
                label="Hit rate keyspace"
                value={system.redis.keyspace_hit_rate != null ? (system.redis.keyspace_hit_rate * 100).toFixed(1) + "%" : "—"}
                tone={
                  system.redis.keyspace_hit_rate == null ? "neutral" :
                  system.redis.keyspace_hit_rate < 0.3 ? "warn" : "success"
                }
              />
              <StatTile label="Clientes conectados" value={String(system.redis.connected_clients)} />
              <StatTile label="Claves broker (DB0)" value={String(system.redis.keys_by_db?.db0 ?? 0)} sublabel="jobs pendientes" />
              <StatTile label="Cache entries (DB1)" value={String(system.redis.keys_by_db?.db1 ?? 0)} />
              <StatTile
                label="Evictions"
                value={String(system.redis.evicted_keys)}
                tone={system.redis.evicted_keys > 0 ? "danger" : "success"}
                sublabel={system.redis.evicted_keys > 0 ? "memoria insuficiente" : "OK"}
              />
              <StatTile
                label="Fragmentación"
                value={system.redis.fragmentation_ratio.toFixed(2) + "x"}
                tone={
                  system.redis.fragmentation_ratio > 1.5 ? "warn" :
                  system.redis.fragmentation_ratio < 0.7 ? "warn" : "success"
                }
                sublabel={system.redis.slowlog_length > 0 ? `slowlog: ${system.redis.slowlog_length}` : undefined}
              />
            </div>
          </CollapsibleMetric>

          <CollapsibleMetric icon={Bot} label="Groq API" sublabel="llamadas acumuladas desde inicio del proceso">
            {system.groq.total_calls === 0 ? (
              <p className="text-sm text-muted-foreground">Sin llamadas registradas aún. Los contadores se resetean al reiniciar el backend.</p>
            ) : (
              <div className="space-y-2">
                {system.groq.by_model.map((m: any) => (
                  <div key={m.model} className="rounded-lg bg-muted/50 px-4 py-3">
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
          </CollapsibleMetric>

        </div>

      </div>
      )}
    </PageShell>
  );
}
