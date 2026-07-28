"use client";

// Salud técnica del cliente: lo diagnóstico en un solo panel — latencias,
// cache, conocimiento, almacenamiento y errores del backend de este tenant.

import { Skeleton } from "@/components/ui/skeleton";
import { Panel, KVRow } from "@/components/superadmin/panel";
import { ErrorRow, type PlatformError } from "@/components/superadmin/shared";
import { latencyTone, rowTone } from "@/components/superadmin/status";

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1)     + "K";
  return String(n);
}

function fmtBytes(b: number): string {
  if (b >= 1_073_741_824) return (b / 1_073_741_824).toFixed(1) + " GB";
  if (b >= 1_048_576)     return (b / 1_048_576).toFixed(1)     + " MB";
  if (b >= 1_024)         return (b / 1_024).toFixed(1)         + " KB";
  return b + " B";
}

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
  return ms + "ms";
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return "ahora";
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}

export function HealthPanel({ m, health, loading }: {
  m: {
    docs: { total: number; ready: number; failed: number; processing: number; storage_bytes: number };
    performance: { latency_p50: number | null; latency_p95: number | null; cache_hit_rate: number | null };
    quality: { passed: number; pending: number; skipped: number };
  };
  health?: {
    activity: { last_query_at: string | null; last_ingest_at: string | null };
    errors: PlatformError[];
    storage: { schema_bytes: number; minio_bytes: number | null; minio_objects: number | null };
  };
  loading: boolean;
}) {
  return (
    <Panel title="Salud técnica" sub="rendimiento, conocimiento y errores de este cliente">
      <div className="grid lg:grid-cols-2 lg:divide-x lg:divide-border/50">
        <div className="divide-y divide-border/50">
          <KVRow label="Latencia p50" value={fmtMs(m.performance.latency_p50)} tone={rowTone(latencyTone(m.performance.latency_p50))} />
          <KVRow label="Latencia p95" value={fmtMs(m.performance.latency_p95)} tone={rowTone(latencyTone(m.performance.latency_p95))} />
          <KVRow label="Respuestas desde cache" value={m.performance.cache_hit_rate != null ? `${Math.round(m.performance.cache_hit_rate * 100)}%` : "—"} />
          <KVRow
            label="Última consulta"
            value={loading ? "…" : health?.activity.last_query_at ? relTime(health.activity.last_query_at) : "Nunca"}
            tone={!loading && !health?.activity.last_query_at ? "warn" : undefined}
          />
          <KVRow
            label="Última ingesta"
            value={loading ? "…" : health?.activity.last_ingest_at ? relTime(health.activity.last_ingest_at) : "Nunca"}
          />
        </div>
        <div className="divide-y divide-border/50 border-t lg:border-t-0">
          <KVRow label="Documentos" value={`${fmtNum(m.docs.total)} · ${fmtBytes(m.docs.storage_bytes)}`} />
          <KVRow label="Listos" value={fmtNum(m.docs.ready)} />
          {m.docs.processing > 0 && <KVRow label="Procesando" value={fmtNum(m.docs.processing)} tone="warn" />}
          {m.docs.failed > 0 && <KVRow label="Fallidos" value={fmtNum(m.docs.failed)} tone="down" />}
          <KVRow
            label="Validación de calidad"
            value={`${fmtNum(m.quality.passed)} ok${m.quality.pending > 0 ? ` · ${fmtNum(m.quality.pending)} pendientes` : ""}${m.quality.skipped > 0 ? ` · ${fmtNum(m.quality.skipped)} descartados` : ""}`}
            tone={m.quality.skipped > 0 ? "warn" : undefined}
          />
          <KVRow
            label="Archivos adjuntos"
            value={loading ? "…" : health?.storage.minio_bytes != null
              ? `${fmtBytes(health.storage.minio_bytes)}${health.storage.minio_objects != null ? ` · ${fmtNum(health.storage.minio_objects)}` : ""}`
              : "—"}
          />
          <KVRow label="Datos en PostgreSQL" value={loading ? "…" : health ? fmtBytes(health.storage.schema_bytes) : "—"} />
        </div>
      </div>

      {/* Errores del backend de ESTE tenant */}
      <div className="border-t">
        {loading || !health ? (
          <div className="p-4"><Skeleton className="h-8 rounded-lg" /></div>
        ) : health.errors.length === 0 ? (
          <p className="flex items-center gap-2.5 px-4 py-3 text-sm text-muted-foreground">
            <span className="h-2 w-2 shrink-0 rounded-full bg-success" /> Sin errores del backend en los últimos 7 días.
          </p>
        ) : (
          <div className="max-h-[300px] divide-y overflow-y-auto scrollbar-slim">
            {health.errors.map((e, i) => <ErrorRow key={i} e={e} />)}
          </div>
        )}
      </div>
    </Panel>
  );
}
