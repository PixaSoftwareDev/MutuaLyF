"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SuperShell } from "@/components/superadmin/shell";
import { Skeleton } from "@/components/ui/skeleton";
import { StatePill, type StatePillTone } from "@/components/ui/state-pill";
import { fmtNum, fmtBytes } from "@/components/superadmin/shared";
import { Panel, KVRow, MeterRow } from "@/components/superadmin/panel";

/**
 * Monitoreo → Métricas. Los números técnicos, un panel por servicio.
 * Porcentajes con barra, contadores como filas — lo que está mal se tiñe.
 */

function iaStatusTone(status: string): StatePillTone {
  if (status === "success") return "success";
  if (status === "error") return "destructive";
  if (status === "timeout" || status === "rate_limit") return "warning";
  return "muted";
}

export default function MonitoringMetricsPage() {
  const { data: system, isLoading } = useQuery({
    queryKey: ["platform-system"], queryFn: api.tenants.platformSystem,
    refetchInterval: 30_000, staleTime: 15_000,
  });

  return (
    <SuperShell
      title="Métricas"
      badge={<span className="hidden text-xs text-muted-foreground sm:inline">números técnicos por servicio</span>}
    >
        {isLoading && !system ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-52 rounded-xl" />)}
          </div>
        ) : !system ? null : (
          <div className="space-y-4 pb-6">

            <div className="grid items-start gap-4 lg:grid-cols-2">

              <Panel title="Aplicación" sub="acumulado desde el inicio">
                <div className="divide-y divide-border/50">
                  <KVRow label="Organizaciones activas" value={String(system.app.active_tenants)} />
                  <KVRow label="Consultas totales" value={fmtNum(system.app.total_queries)} />
                  <KVRow label="Respuestas desde cache" value={fmtNum(system.app.total_cache_hits)} />
                  <KVRow label="Ingestas totales" value={fmtNum(system.app.total_ingests)} />
                </div>
              </Panel>

              <Panel title="Backend API" sub="últimos 10 minutos">
                <div className="divide-y divide-border/50">
                  <KVRow
                    label="Latencia p95"
                    value={system.backend.latency_p95_ms != null ? `${system.backend.latency_p95_ms.toFixed(0)} ms` : "—"}
                    tone={
                      system.backend.latency_p95_ms == null ? undefined :
                      system.backend.latency_p95_ms > 2000 ? "down" :
                      system.backend.latency_p95_ms > 1000 ? "warn" : undefined
                    }
                  />
                  <KVRow
                    label="Tasa de errores 5xx"
                    value={system.backend.error_rate_5m > 0 ? `${(system.backend.error_rate_5m * 100).toFixed(2)}%` : "0%"}
                    tone={system.backend.error_rate_5m > 0.01 ? "down" : undefined}
                  />
                  <KVRow label="Requests HTTP" value={fmtNum(system.backend.total_requests)} hint="acumulado" />
                </div>
              </Panel>

              <Panel title="PostgreSQL" sub={fmtBytes(system.postgres.db_size_bytes)}>
                <div className="divide-y divide-border/50">
                  <KVRow label="Conexiones activas" value={String(system.postgres.connections)} />
                  <MeterRow
                    label="Cache hit rate"
                    hint="buffer pool"
                    pct={system.postgres.cache_hit_rate != null ? system.postgres.cache_hit_rate * 100 : null}
                    valueLabel={system.postgres.cache_hit_rate != null ? `${(system.postgres.cache_hit_rate * 100).toFixed(1)}%` : "Sin datos"}
                    tone={system.postgres.cache_hit_rate != null && system.postgres.cache_hit_rate < 0.9 ? "warn" : undefined}
                  />
                  <KVRow
                    label="Deadlocks"
                    value={String(system.postgres.deadlocks_total)}
                    tone={system.postgres.deadlocks_total > 0 ? "down" : undefined}
                    hint="acumulados"
                  />
                </div>
              </Panel>

              <Panel title="Redis" sub="broker · cache · rate-limit">
                <div className="divide-y divide-border/50">
                  <MeterRow
                    label="Memoria"
                    pct={system.redis.memory_max_bytes > 0
                      ? (system.redis.memory_used_bytes / system.redis.memory_max_bytes) * 100
                      : null}
                    valueLabel={`${fmtBytes(system.redis.memory_used_bytes)}${system.redis.memory_max_bytes > 0 ? ` de ${fmtBytes(system.redis.memory_max_bytes)}` : ""}`}
                    tone={system.redis.memory_max_bytes > 0 && system.redis.memory_used_bytes / system.redis.memory_max_bytes > 0.85 ? "warn" : undefined}
                  />
                  <MeterRow
                    label="Hit rate del keyspace"
                    pct={system.redis.keyspace_hit_rate != null ? system.redis.keyspace_hit_rate * 100 : null}
                    valueLabel={system.redis.keyspace_hit_rate != null ? `${(system.redis.keyspace_hit_rate * 100).toFixed(1)}%` : "Sin datos"}
                    tone={system.redis.keyspace_hit_rate != null && system.redis.keyspace_hit_rate < 0.3 ? "warn" : undefined}
                  />
                  <KVRow label="Clientes conectados" value={String(system.redis.connected_clients)} />
                  <KVRow label="Jobs en cola" value={String(system.redis.keys_by_db?.db0 ?? 0)} hint="broker DB0" />
                  <KVRow label="Entradas de cache" value={String(system.redis.keys_by_db?.db1 ?? 0)} hint="DB1" />
                  <KVRow
                    label="Evictions"
                    value={String(system.redis.evicted_keys)}
                    tone={system.redis.evicted_keys > 0 ? "down" : undefined}
                    hint={system.redis.evicted_keys > 0 ? "memoria insuficiente" : undefined}
                  />
                  <KVRow
                    label="Fragmentación"
                    value={`${system.redis.fragmentation_ratio.toFixed(2)}x`}
                    tone={system.redis.fragmentation_ratio > 1.5 || system.redis.fragmentation_ratio < 0.7 ? "warn" : undefined}
                    hint={system.redis.slowlog_length > 0 ? `slowlog: ${system.redis.slowlog_length}` : undefined}
                  />
                </div>
              </Panel>

            </div>

            <Panel title="Servicio de IA" sub="llamadas al LLM desde el inicio del proceso">
              {system.groq.total_calls === 0 ? (
                <p className="px-4 py-4 text-sm text-muted-foreground">
                  Sin llamadas registradas aún — los contadores se resetean al reiniciar el backend.
                </p>
              ) : (
                <div className="divide-y divide-border/50">
                  {system.groq.by_model.map((m: any) => (
                    <div key={m.model} className="px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <code className="font-mono text-xs text-foreground">{m.model}</code>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span className="tabular-nums">{fmtNum(m.total)} llamadas</span>
                          {m.errors > 0 && <span className="font-medium text-destructive">{m.errors} errores</span>}
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {Object.entries(m.calls as Record<string, number>).map(([status, count]) => (
                          <StatePill key={status} tone={iaStatusTone(status)}>{status}: {count}</StatePill>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

          </div>
        )}
    </SuperShell>
  );
}
