"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Building2, Activity, BellRing, Bug, CheckCircle2, AlertTriangle,
  Headset, ChevronRight, Coins, HardDrive, Database, Server, Zap, Bot,
} from "lucide-react";
import { api } from "@/lib/api";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader, CountChip } from "@/components/layout/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtNum, HeaderKpi, Section, BackupStat, DiskStat, ErrorRow } from "@/components/superadmin/shared";
import { cn } from "@/lib/utils";

/**
 * Inicio del super-admin: el centro de operaciones. Una sola pantalla que
 * responde "¿está todo bien AHORA?" — servicios, alertas, errores, colas de
 * atención y consumo — sin ir a Grafana, logs ni el email de alertas.
 */
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
  const { data: ops } = useQuery({
    queryKey: ["platform-ops"], queryFn: api.tenants.platformOps,
    refetchInterval: 20_000, staleTime: 10_000,
  });
  const { data: traffic } = useQuery({
    queryKey: ["platform-traffic"], queryFn: api.tenants.platformTraffic,
    staleTime: 5 * 60_000,
  });

  const alerts = alertsData?.alerts ?? [];
  const recentErrors = (errorsData?.errors ?? []).filter(e => e.level === "ERROR");
  const queues = ops?.queues ?? [];
  const worstWait = Math.max(0, ...queues.map(q => q.oldest_wait_min));
  const totalWaiting = queues.reduce((s, q) => s + q.waiting, 0);

  const servicesUp = system
    ? [system.postgres.up, system.redis.up, system.backend.up].every(Boolean)
    : null;

  // Veredicto global del semáforo: alerta activa > servicio caído > backup
  // vencido > colas críticas > todo bien.
  const globalStatus: { tone: "ok" | "warn" | "down"; label: string } =
    system && !servicesUp                  ? { tone: "down", label: "Servicio caído" } :
    alerts.some(a => a.severity === "critical") ? { tone: "down", label: "Alerta crítica activa" } :
    alerts.length > 0                      ? { tone: "warn", label: "Alertas activas" } :
    system?.backups?.daily && !system.backups.daily.healthy ? { tone: "warn", label: "Backup vencido" } :
    worstWait > 5                          ? { tone: "warn", label: "Afiliados esperando hace rato" } :
    { tone: "ok", label: "Todo en orden" };

  const tokensPerTenant = (traffic?.per_tenant ?? [])
    .filter(t => t.tokens_30d > 0)
    .sort((a, b) => b.tokens_30d - a.tokens_30d);

  return (
    <PageShell>
      <PageHeader
        eyebrow="Plataforma"
        title="Inicio"
        badge={
          <span className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-semibold",
            globalStatus.tone === "ok"   ? "border-success/30 bg-success/10 text-success" :
            globalStatus.tone === "warn" ? "border-warning/30 bg-warning/10 text-warning" :
                                           "border-destructive/30 bg-destructive/10 text-destructive",
          )}>
            <span className={cn(
              "h-1.5 w-1.5 rounded-full",
              globalStatus.tone === "ok" ? "bg-success" : globalStatus.tone === "warn" ? "bg-warning" : "bg-destructive animate-pulse motion-reduce:animate-none",
            )} />
            {globalStatus.label}
          </span>
        }
        description="El estado de la plataforma de un vistazo: servicios, alertas, atención y consumo."
      />

      {/* ── KPIs del día ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <HeaderKpi label="Consultas hoy" value={health?.queries_today ?? 0} loading={!health} />
        <HeaderKpi label="Derivaciones hoy" value={ops?.handoffs_today ?? 0} loading={!ops} />
        <HeaderKpi
          label="Esperando operador"
          value={totalWaiting}
          tone={worstWait > 5 ? "danger" : totalWaiting > 0 ? "warn" : "neutral"}
          loading={!ops}
        />
        <HeaderKpi
          label="Organizaciones activas"
          value={health?.active_tenants ?? 0}
          tone="success"
          loading={!health}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 items-start">

        {/* ── Atención al afiliado — el peor escenario primero ── */}
        <Section icon={Headset} label="Atención en vivo" sublabel="colas de espera por organización">
          {!ops ? (
            <Skeleton className="h-16 rounded-lg" />
          ) : queues.length === 0 ? (
            <p className="text-sm text-success flex items-center gap-2 font-medium py-1">
              <CheckCircle2 className="h-4 w-4 shrink-0" /> Sin conversaciones en espera ni en atención.
            </p>
          ) : (
            <div className="space-y-2">
              {queues.map(q => {
                const critical = q.oldest_wait_min > 5;
                const warn = q.oldest_wait_min > 2;
                return (
                  <button
                    key={q.tenant_id}
                    onClick={() => router.push(`/superadmin/tenants/${q.tenant_id}`)}
                    className={cn(
                      "w-full rounded-lg border px-3.5 py-2.5 flex items-center gap-3 text-left transition-colors",
                      critical ? "bg-destructive/10 border-destructive/20 hover:bg-destructive/15" :
                      warn     ? "bg-warning/10 border-warning/20 hover:bg-warning/15" :
                                 "bg-muted/30 hover:bg-muted/50",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold truncate">{q.tenant_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {q.waiting > 0
                          ? <>{q.waiting} esperando · la más antigua hace <span className={cn("font-semibold", critical ? "text-destructive" : warn ? "text-warning" : "")}>{q.oldest_wait_min < 1 ? "<1" : Math.round(q.oldest_wait_min)} min</span></>
                          : "Sin cola"}
                        {q.attending > 0 && <> · {q.attending} en atención</>}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                );
              })}
            </div>
          )}
        </Section>

        {/* ── Alertas activas ── */}
        <Section icon={BellRing} label="Alertas" sublabel="Alertmanager en vivo">
          {!alertsData ? (
            <Skeleton className="h-16 rounded-lg" />
          ) : !alertsData.available ? (
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning shrink-0" /> No se pudo consultar Alertmanager.
            </p>
          ) : alerts.length === 0 ? (
            <p className="text-sm text-success flex items-center gap-2 font-medium py-1">
              <CheckCircle2 className="h-4 w-4 shrink-0" /> Sin alertas activas.
            </p>
          ) : (
            <div className="space-y-2">
              {alerts.slice(0, 4).map((a, i) => (
                <div key={i} className={cn(
                  "rounded-lg border px-3.5 py-2.5 flex items-start gap-2.5",
                  a.severity === "critical" ? "bg-destructive/10 border-destructive/20" : "bg-warning/10 border-warning/20",
                )}>
                  <AlertTriangle className={cn("h-4 w-4 mt-0.5 shrink-0", a.severity === "critical" ? "text-destructive" : "text-warning")} />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{a.name}</p>
                    {a.summary && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{a.summary}</p>}
                  </div>
                </div>
              ))}
              <Link href="/superadmin/monitoring" className="block text-xs text-action hover:underline pt-1">
                Ver todas en Monitoreo →
              </Link>
            </div>
          )}
        </Section>

        {/* ── Errores recientes (solo ERROR) ── */}
        <Section icon={Bug} label="Errores recientes" sublabel="del backend, en vivo">
          {!errorsData ? (
            <Skeleton className="h-16 rounded-lg" />
          ) : recentErrors.length === 0 ? (
            <p className="text-sm text-success flex items-center gap-2 font-medium py-1">
              <CheckCircle2 className="h-4 w-4 shrink-0" /> Sin errores recientes.
            </p>
          ) : (
            <div className="space-y-1.5">
              <div className="rounded-lg border divide-y">
                {recentErrors.slice(0, 5).map((e, i) => <ErrorRow key={i} e={e} />)}
              </div>
              <Link href="/superadmin/monitoring" className="block text-xs text-action hover:underline pt-1">
                Ver el detalle en Monitoreo →
              </Link>
            </div>
          )}
        </Section>

        {/* ── Salud compacta: servicios + backup + disco ── */}
        <Section icon={Activity} label="Infraestructura" sublabel="resumen — el detalle vive en Monitoreo">
          {!system ? (
            <Skeleton className="h-16 rounded-lg" />
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                {[
                  { label: "PostgreSQL", up: system.postgres.up, icon: Database },
                  { label: "Redis", up: system.redis.up, icon: Zap },
                  { label: "Backend", up: system.backend.up, icon: Server },
                  { label: "Groq", up: system.groq.total_calls === 0 ? true : (system.groq.by_model ?? []).every((m: any) => m.errors === 0 || m.errors < m.total), icon: Bot },
                ].map(s => (
                  <span key={s.label} className={cn("flex items-center gap-1.5 font-medium", s.up ? "text-success" : "text-destructive")}>
                    <s.icon className="h-3.5 w-3.5" /> {s.label} {s.up ? "OK" : "CAÍDO"}
                  </span>
                ))}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <BackupStat label="Backup diario" b={system.backups?.daily} />
                <BackupStat label="Backup semanal" b={system.backups?.weekly} />
                <DiskStat storage={system.storage} />
              </div>
              <Link href="/superadmin/monitoring" className="block text-xs text-action hover:underline">
                Métricas completas en Monitoreo →
              </Link>
            </div>
          )}
        </Section>

      </div>

      {/* ── Consumo LLM 30 días por organización (base de facturación) ── */}
      <Section icon={Coins} label="Consumo LLM — 30 días" sublabel="tokens por organización (usage_events) — base para facturación">
        {!traffic ? (
          <Skeleton className="h-16 rounded-lg" />
        ) : tokensPerTenant.length === 0 ? (
          <p className="text-sm text-muted-foreground py-1">Sin consumo registrado en los últimos 30 días.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {tokensPerTenant.map(t => (
              <button
                key={t.id}
                onClick={() => router.push(`/superadmin/tenants/${t.id}`)}
                className="rounded-lg bg-muted/50 px-3.5 py-3 text-left hover:bg-muted transition-colors"
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground leading-tight truncate">{t.name}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums leading-none">{fmtNum(t.tokens_30d)} <span className="text-sm font-medium text-muted-foreground">tokens</span></p>
                <p className="text-[11px] text-muted-foreground/80 mt-1 tabular-nums">{fmtNum(t.queries_30d)} consultas · {fmtNum(t.ingests_30d)} ingestas</p>
              </button>
            ))}
          </div>
        )}
      </Section>
    </PageShell>
  );
}
