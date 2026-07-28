"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Building2, MessageSquare, Coins, Upload, ArrowRight } from "lucide-react";
import { api } from "@/lib/api";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { StatePill } from "@/components/ui/state-pill";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { fmtNum, Kpi } from "@/components/superadmin/shared";
import { cn } from "@/lib/utils";

/**
 * Inicio del super-admin — panel convencional y simple: fila de stats del
 * período, la tabla de organizaciones como pieza principal y una tarjeta de
 * estado del sistema al costado (cada servicio con su punto, sin veredictos
 * crípticos). El detalle técnico vive en Monitoreo.
 */

// "unknown" = sin monitoreo (Prometheus no está en este entorno): neutro,
// nunca alarma. Solo up=false explícito cuenta como caído.
type Tone = "ok" | "warn" | "down" | "unknown";

const DOT: Record<Tone, string> = {
  ok:      "bg-success",
  warn:    "bg-warning",
  down:    "bg-destructive animate-pulse motion-reduce:animate-none",
  unknown: "bg-muted-foreground/40",
};

const TONE_TEXT: Record<Tone, string> = {
  ok:      "Operativo",
  warn:    "Atención",
  down:    "Caído",
  unknown: "Sin datos",
};

function StatusRow({ label, tone, detail, loading }: { label: string; tone: Tone; detail?: string; loading?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", loading ? "bg-muted-foreground/30" : DOT[tone])} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{label}</span>
      {loading
        ? <Skeleton className="h-3.5 w-14" />
        : <span className={cn(
            "shrink-0 text-xs tabular-nums",
            tone === "down" ? "font-medium text-destructive" :
            tone === "warn" ? "font-medium text-warning" :
            "text-muted-foreground",
          )}>{detail ?? TONE_TEXT[tone]}</span>}
    </div>
  );
}

export default function PlatformHomePage() {
  const router = useRouter();

  const { data: health } = useQuery({
    queryKey: ["platform-health"], queryFn: api.tenants.platformHealth,
    refetchInterval: 60_000, staleTime: 30_000,
  });
  const { data: system } = useQuery({
    queryKey: ["platform-system"], queryFn: api.tenants.platformSystem,
    refetchInterval: 30_000, staleTime: 15_000,
  });
  const { data: alertsData } = useQuery({
    queryKey: ["platform-alerts"], queryFn: api.tenants.platformAlerts,
    refetchInterval: 30_000, staleTime: 15_000,
  });
  const { data: errorsData } = useQuery({
    queryKey: ["platform-errors-mini"], queryFn: () => api.tenants.platformErrors(8),
    refetchInterval: 30_000, staleTime: 15_000,
  });
  const { data: traffic } = useQuery({
    queryKey: ["platform-traffic"], queryFn: api.tenants.platformTraffic,
    staleTime: 5 * 60_000,
  });
  const { data: costs } = useQuery({
    queryKey: ["platform-costs"], queryFn: api.tenants.platformCosts,
    staleTime: 10 * 60_000, refetchInterval: 15 * 60_000,
  });

  const healthLoading = !system || !alertsData || !errorsData;
  const monitoringAvailable: boolean = system ? (system.monitoring_available ?? true) : true;

  const alerts = alertsData?.alerts ?? [];
  const recentErrors = (errorsData?.errors ?? []).filter(e => e.level === "ERROR");

  // ── Estado por servicio (el detalle vive en Monitoreo) ──
  const upTone = (up: boolean | null | undefined): Tone =>
    up === false ? "down" : up === true ? "ok" : "unknown";

  const iaOk = system
    ? system.groq.total_calls === 0 ? true : (system.groq.by_model ?? []).every((m: any) => m.errors === 0 || m.errors < m.total)
    : null;

  const daily   = system?.backups?.daily;
  const weekly  = system?.backups?.weekly;
  const diskPct = system?.storage?.used_pct ?? null;
  const backupTone: Tone =
    !monitoringAvailable && system?.backups == null ? "unknown" :
    (daily && !daily.healthy) || (diskPct != null && diskPct >= 85) ? "down" :
    (weekly && !weekly.healthy) || (diskPct != null && diskPct >= 70) || system?.backups == null ? "warn" :
    "ok";
  const backupDetail =
    backupTone === "unknown" ? undefined :
    daily && !daily.healthy ? "Diario vencido" :
    diskPct != null && diskPct >= 70 ? `Disco ${diskPct.toFixed(0)}%` :
    weekly && !weekly.healthy ? "Semanal pendiente" :
    undefined;

  const alertTone: Tone =
    alerts.some(a => a.severity === "critical") ? "down" :
    alerts.length > 0 ? "warn" : "ok";
  const errTone: Tone = recentErrors.length > 0 ? "warn" : "ok";

  const statusRows: Array<{ label: string; tone: Tone; detail?: string }> = [
    { label: "PostgreSQL", tone: upTone(system?.postgres.up) },
    { label: "Redis",      tone: upTone(system?.redis.up) },
    { label: "Backend",    tone: upTone(system?.backend.up) },
    { label: "Servicio de IA", tone: iaOk == null ? "unknown" : iaOk ? "ok" : "down" },
    { label: "Backups y disco", tone: backupTone, detail: backupDetail },
    { label: "Alertas", tone: alertTone, detail: alerts.length > 0 ? `${alerts.length} activa${alerts.length === 1 ? "" : "s"}` : "Ninguna" },
    { label: "Errores recientes", tone: errTone, detail: recentErrors.length > 0 ? String(recentErrors.length) : "Ninguno" },
  ];
  const allOk = !healthLoading && statusRows.every(r => r.tone === "ok" || r.tone === "unknown");

  // ── Negocio (30 días) ──
  const orgs = (traffic?.per_tenant ?? []).slice().sort((a, b) => b.tokens_30d - a.tokens_30d);
  const totalQueries = orgs.reduce((s, o) => s + o.queries_30d, 0);
  const totalIngests = orgs.reduce((s, o) => s + o.ingests_30d, 0);

  return (
    <PageShell>
      <PageHeader
        title="Inicio"
        badge={<span className="text-xs text-muted-foreground">Últimos 30 días</span>}
      />

      {/* ── Stats del período ── */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <Kpi icon={Building2}     label="Organizaciones activas" value={(health?.active_tenants ?? 0).toLocaleString("es-AR")} loading={!health} />
        <Kpi icon={MessageSquare} label="Consultas"              value={fmtNum(totalQueries)} loading={!traffic} />
        <Kpi
          icon={Coins}
          label="Gasto en IA"
          value={costs?.available
            ? `US$ ${costs.total_usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : "—"}
          accentBrand
          loading={costs === undefined}
        />
        <Kpi icon={Upload}        label="Ingestas"               value={fmtNum(totalIngests)} loading={!traffic} />
      </div>

      {/* ── Organizaciones (principal) + Estado del sistema (lateral) ── */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-sm font-semibold">Organizaciones</h2>
              <Link href="/superadmin/orgs" className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                Gestionar <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>

            {!traffic ? (
              <div className="space-y-2 p-4">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-11 rounded-lg" />)}
              </div>
            ) : orgs.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                Todavía no hay organizaciones con actividad registrada.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Organización</TableHead>
                      <TableHead className="hidden sm:table-cell">Plan</TableHead>
                      <TableHead className="text-right">Consultas</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Tokens</TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orgs.map(o => {
                      const idle = o.tokens_30d === 0 && o.queries_30d === 0;
                      return (
                        <TableRow
                          key={o.id}
                          className="cursor-pointer"
                          onClick={() => router.push(`/superadmin/tenants/${o.id}`)}
                          onMouseEnter={() => router.prefetch(`/superadmin/tenants/${o.id}`)}
                        >
                          <TableCell>
                            <span className="flex items-center gap-2">
                              <span className="font-medium">{o.name}</span>
                              {idle && <StatePill tone="muted">sin uso</StatePill>}
                            </span>
                          </TableCell>
                          <TableCell className="hidden text-muted-foreground sm:table-cell">{o.plan || "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtNum(o.queries_30d)}</TableCell>
                          <TableCell className="hidden text-right tabular-nums text-muted-foreground sm:table-cell">{fmtNum(o.tokens_30d)}</TableCell>
                          <TableCell><ChevronRight className="h-4 w-4 text-muted-foreground/50" /></TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-sm font-semibold">Estado del sistema</h2>
              {!healthLoading && (
                <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", allOk ? "text-success" : "text-muted-foreground")}>
                  <span className={cn("h-1.5 w-1.5 rounded-full", allOk ? "bg-success" : "bg-warning")} />
                  {allOk ? "Todo en orden" : "Revisar"}
                </span>
              )}
            </div>
            <div className="divide-y divide-border/50">
              {statusRows.map(r => (
                <StatusRow key={r.label} label={r.label} tone={r.tone} detail={r.detail} loading={healthLoading} />
              ))}
            </div>
            <Link
              href="/superadmin/monitoring"
              className="flex items-center justify-center gap-1 border-t px-4 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              Ver monitoreo <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          {!monitoringAvailable && !healthLoading && (
            <p className="mt-2 px-1 text-[11px] leading-snug text-muted-foreground/70">
              El monitoreo detallado (Prometheus) no está activo en este entorno — los servicios sin datos se muestran en gris.
            </p>
          )}
        </div>
      </div>
    </PageShell>
  );
}
