"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, ChevronRight, Coins } from "lucide-react";
import { api } from "@/lib/api";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtNum, relAge, HeaderKpi, Section, ErrorRow } from "@/components/superadmin/shared";
import { cn } from "@/lib/utils";

/**
 * Inicio del super-admin: el centro de operaciones. Responde "¿está todo bien
 * AHORA?" con el patrón de status page: una fila por chequeo, resumen en una
 * línea, y el detalle aparece SOLO cuando algo está mal. Sin cards vacías.
 */

type Tone = "ok" | "warn" | "down";

const DOT: Record<Tone, string> = {
  ok:   "bg-success",
  warn: "bg-warning",
  down: "bg-destructive animate-pulse motion-reduce:animate-none",
};

/** Fila de chequeo estilo status page: punto, nombre, resumen, link. */
function StatusRow({ tone, label, summary, href, children }: {
  tone: Tone;
  label: string;
  summary: React.ReactNode;
  href?: string;
  children?: React.ReactNode;   // detalle inline — solo cuando hay problema
}) {
  const row = (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className={cn("h-2 w-2 rounded-full shrink-0", DOT[tone])} />
      <span className="text-sm font-medium w-28 sm:w-40 shrink-0">{label}</span>
      <span className={cn(
        "text-sm flex-1 min-w-0 truncate",
        tone === "ok" ? "text-muted-foreground" : tone === "warn" ? "text-warning font-medium" : "text-destructive font-medium",
      )}>
        {summary}
      </span>
      {href && <ChevronRight className="h-4 w-4 text-muted-foreground/60 shrink-0" />}
    </div>
  );
  return (
    <div>
      {href ? (
        <Link href={href} className="block hover:bg-muted/40 transition-colors">{row}</Link>
      ) : row}
      {children && <div className="px-4 pb-3.5 pl-9">{children}</div>}
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
  const { data: ops } = useQuery({
    queryKey: ["platform-ops"], queryFn: api.tenants.platformOps,
    refetchInterval: 20_000, staleTime: 10_000,
  });
  const { data: traffic } = useQuery({
    queryKey: ["platform-traffic"], queryFn: api.tenants.platformTraffic,
    staleTime: 5 * 60_000,
  });

  const loading = !system || !alertsData || !errorsData || !ops;

  const alerts = alertsData?.alerts ?? [];
  const recentErrors = (errorsData?.errors ?? []).filter(e => e.level === "ERROR");
  const queues = ops?.queues ?? [];
  const worstWait = Math.max(0, ...queues.map(q => q.oldest_wait_min));
  const totalWaiting = queues.reduce((s, q) => s + q.waiting, 0);
  const totalAttending = queues.reduce((s, q) => s + q.attending, 0);

  // ── Chequeo 1: servicios ──
  const services = system ? [
    { label: "PostgreSQL", up: system.postgres.up },
    { label: "Redis",      up: system.redis.up },
    { label: "Backend",    up: system.backend.up },
    { label: "Groq",       up: system.groq.total_calls === 0 ? true : (system.groq.by_model ?? []).every((m: any) => m.errors === 0 || m.errors < m.total) },
  ] : [];
  const downServices = services.filter(s => !s.up);
  const svcTone: Tone = downServices.length > 0 ? "down" : "ok";

  // ── Chequeo 2: alertas ──
  const alertTone: Tone =
    alerts.some(a => a.severity === "critical") ? "down" :
    alerts.length > 0 ? "warn" : "ok";

  // ── Chequeo 3: errores backend ──
  const errTone: Tone = recentErrors.length > 0 ? "warn" : "ok";

  // ── Chequeo 4: backups + disco ──
  const daily  = system?.backups?.daily;
  const weekly = system?.backups?.weekly;
  const diskPct = system?.storage?.used_pct ?? null;
  const backupTone: Tone =
    (daily && !daily.healthy) || (diskPct != null && diskPct >= 85) ? "down" :
    (weekly && !weekly.healthy) || (diskPct != null && diskPct >= 70) || system?.backups == null ? "warn" :
    "ok";
  const backupSummary = system?.backups == null
    ? "Sin acceso al repositorio de backups"
    : [
        daily  ? `diario ${relAge(daily.age_hours)}${daily.healthy ? "" : " (vencido)"}` : "sin backup diario",
        weekly ? `semanal ${relAge(weekly.age_hours)}` : "sin semanal",
        diskPct != null ? `disco ${diskPct.toFixed(0)}% usado` : null,
      ].filter(Boolean).join(" · ");

  // ── Chequeo 5: atención en vivo ──
  const opsTone: Tone = worstWait > 5 ? "down" : totalWaiting > 0 ? "warn" : "ok";
  const opsSummary = totalWaiting === 0 && totalAttending === 0
    ? "Sin afiliados esperando ni en atención"
    : `${totalWaiting} esperando · ${totalAttending} en atención${worstWait > 0 ? ` · la espera más antigua: ${worstWait < 1 ? "<1" : Math.round(worstWait)} min` : ""}`;

  // ── Veredicto global = el peor de los chequeos ──
  const tones = [svcTone, alertTone, errTone, backupTone, opsTone];
  const globalStatus: { tone: Tone; label: string } =
    tones.includes("down")
      ? { tone: "down",
          label: svcTone === "down" ? "Servicio caído" :
                 alertTone === "down" ? "Alerta crítica activa" :
                 backupTone === "down" ? "Backup o disco en riesgo" :
                 "Afiliados esperando hace rato" }
      : tones.includes("warn")
      ? { tone: "warn", label: "Requiere atención" }
      : { tone: "ok", label: "Todo en orden" };

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
            <span className={cn("h-1.5 w-1.5 rounded-full", DOT[globalStatus.tone])} />
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
          loading={!health}
        />
      </div>

      {/* ── Salud de la plataforma — una fila por chequeo, detalle solo si hay problema ── */}
      <Section icon={Activity} label="Salud de la plataforma" sublabel="se actualiza solo cada 30 segundos">
        {loading ? (
          <div className="space-y-2">{[1,2,3,4,5].map(i => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
        ) : (
          <div className="-m-4 divide-y">

            <StatusRow
              tone={svcTone}
              label="Servicios"
              summary={svcTone === "ok"
                ? "PostgreSQL, Redis, Backend y Groq operativos"
                : `Caído: ${downServices.map(s => s.label).join(", ")}`}
              href="/superadmin/monitoring"
            />

            <StatusRow
              tone={alertTone}
              label="Alertas"
              summary={!alertsData?.available
                ? "No se pudo consultar Alertmanager"
                : alerts.length === 0
                ? "Sin alertas activas"
                : `${alerts.length} ${alerts.length === 1 ? "alerta activa" : "alertas activas"}`}
              href="/superadmin/monitoring"
            >
              {alerts.length > 0 && (
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
                </div>
              )}
            </StatusRow>

            <StatusRow
              tone={errTone}
              label="Errores backend"
              summary={recentErrors.length === 0
                ? "Sin errores recientes"
                : `${recentErrors.length} ${recentErrors.length === 1 ? "error distinto" : "errores distintos"} en el buffer`}
              href="/superadmin/monitoring"
            >
              {recentErrors.length > 0 && (
                <div className="rounded-lg border divide-y">
                  {recentErrors.slice(0, 3).map((e, i) => <ErrorRow key={i} e={e} />)}
                </div>
              )}
            </StatusRow>

            <StatusRow
              tone={backupTone}
              label="Backups y disco"
              summary={backupSummary}
              href="/superadmin/monitoring"
            />

            <StatusRow
              tone={opsTone}
              label="Atención en vivo"
              summary={opsSummary}
            >
              {queues.length > 0 && (
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
            </StatusRow>

          </div>
        )}
      </Section>

      {/* ── Consumo LLM 30 días por organización (base de facturación) ── */}
      <Section icon={Coins} label="Consumo LLM — 30 días" sublabel="tokens por organización — base para facturación">
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
