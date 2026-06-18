"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2, AlertTriangle, XCircle, ChevronRight, ArrowRight,
  Building2, MessageSquare, Coins, Upload, Network,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { PageShell } from "@/components/layout/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtNum, Kpi } from "@/components/superadmin/shared";
import { cn } from "@/lib/utils";

/**
 * Inicio del super-admin — mirada de PLATAFORMA, no operativa. Responde dos
 * cosas: "¿está todo sano?" (hero de estado + lo que requiere acción) y "¿cómo
 * viene el negocio?" (números agregados + pulso de organizaciones). Lo operativo
 * de cada tenant (conversaciones, colas) vive en el panel de ese tenant.
 */

type Tone = "ok" | "warn" | "down";

const DOT: Record<Tone, string> = {
  ok:   "bg-success",
  warn: "bg-warning",
  down: "bg-destructive animate-pulse motion-reduce:animate-none",
};

const HERO: Record<Tone, { Icon: typeof CheckCircle2; ring: string; grad: string; glow: string; iconBg: string }> = {
  ok:   { Icon: CheckCircle2,  ring: "border-success/25",     grad: "from-success/[0.10] via-success/[0.03] to-transparent",         glow: "hsl(var(--success))",     iconBg: "bg-success/15 text-success" },
  warn: { Icon: AlertTriangle, ring: "border-warning/30",     grad: "from-warning/[0.12] via-warning/[0.04] to-transparent",         glow: "hsl(var(--warning))",     iconBg: "bg-warning/15 text-warning" },
  down: { Icon: XCircle,       ring: "border-destructive/30", grad: "from-destructive/[0.12] via-destructive/[0.04] to-transparent", glow: "hsl(var(--destructive))", iconBg: "bg-destructive/15 text-destructive" },
};

/** Chip de dimensión de salud — pulso resumido, el detalle vive en Monitoreo. */
function DimChip({ label, tone }: { label: string; tone: Tone }) {
  return (
    <Link
      href="/superadmin/monitoring"
      className="inline-flex items-center gap-1.5 rounded-full border bg-card/70 px-3 py-1 text-[12px] font-medium text-foreground/80 shadow-xs backdrop-blur transition-colors hover:bg-card hover:text-foreground"
    >
      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", DOT[tone])} />
      {label}
    </Link>
  );
}

export default function PlatformHomePage() {
  const router = useRouter();

  // Saludo + fecha del día. Se calcula en el cliente (no en SSR) para usar la
  // hora real del navegador y evitar el mismatch de hidratación. Se refresca por
  // si la pestaña queda abierta y cruza una franja horaria o la medianoche.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const hour = now?.getHours();
  const greeting =
    hour == null ? "Inicio" :
    hour < 6     ? "Buenas noches" :
    hour < 13    ? "Buenos días" :
    hour < 20    ? "Buenas tardes" :
                   "Buenas noches";
  const fechaLabel = now
    ? (() => {
        const s = now.toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" });
        return s.charAt(0).toUpperCase() + s.slice(1);  // "Miércoles 18 de junio"
      })()
    : "Plataforma";

  // Nombre para el saludo: parte local del email del usuario logueado,
  // capitalizada (p. ej. pixs@… → "Pixs"). Sin hardcodear.
  const { userEmail } = useAuthStore();
  const niceName = (() => {
    const local = (userEmail || "").split("@")[0].trim();
    return local ? local.charAt(0).toUpperCase() + local.slice(1) : "";
  })();

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

  const alerts = alertsData?.alerts ?? [];
  const recentErrors = (errorsData?.errors ?? []).filter(e => e.level === "ERROR");

  // ── Chequeos de salud de PLATAFORMA (la infra es del super-admin; lo operativo
  //    de cada tenant no entra acá). El detalle de cada uno vive en Monitoreo. ──
  const services = system ? [
    { label: "PostgreSQL", up: system.postgres.up },
    { label: "Redis",      up: system.redis.up },
    { label: "Backend",    up: system.backend.up },
    { label: "Groq",       up: system.groq.total_calls === 0 ? true : (system.groq.by_model ?? []).every((m: any) => m.errors === 0 || m.errors < m.total) },
  ] : [];
  const downServices = services.filter(s => !s.up);
  const svcTone: Tone = downServices.length > 0 ? "down" : "ok";

  const alertTone: Tone =
    alerts.some(a => a.severity === "critical") ? "down" :
    alerts.length > 0 ? "warn" : "ok";

  const errTone: Tone = recentErrors.length > 0 ? "warn" : "ok";

  const daily   = system?.backups?.daily;
  const weekly  = system?.backups?.weekly;
  const diskPct = system?.storage?.used_pct ?? null;
  const backupTone: Tone =
    (daily && !daily.healthy) || (diskPct != null && diskPct >= 85) ? "down" :
    (weekly && !weekly.healthy) || (diskPct != null && diskPct >= 70) || system?.backups == null ? "warn" :
    "ok";

  const tones: Tone[] = [svcTone, alertTone, errTone, backupTone];
  const globalTone: Tone = tones.includes("down") ? "down" : tones.includes("warn") ? "warn" : "ok";
  const globalLabel = globalTone === "ok" ? "Todo en orden" : globalTone === "down" ? "Hay un problema" : "Requiere atención";

  type Issue = { tone: Tone; text: string };
  const issues: Issue[] = [];
  if (svcTone !== "ok")    issues.push({ tone: svcTone,    text: `Servicio caído: ${downServices.map(s => s.label).join(", ")}` });
  if (alertTone !== "ok")  issues.push({ tone: alertTone,  text: `${alerts.length} ${alerts.length === 1 ? "alerta activa" : "alertas activas"}${alerts[0]?.name ? ` · ${alerts[0].name}` : ""}` });
  if (errTone !== "ok")    issues.push({ tone: errTone,    text: `${recentErrors.length} ${recentErrors.length === 1 ? "error" : "errores"} en el backend` });
  if (backupTone !== "ok") issues.push({ tone: backupTone, text: system?.backups == null ? "Sin acceso al repositorio de backups" : (daily && !daily.healthy ? "Backup diario vencido" : diskPct != null && diskPct >= 70 ? `Disco al ${diskPct.toFixed(0)}%` : "Backup semanal pendiente") });

  const heroSummary = healthLoading
    ? "Consultando el estado de la plataforma…"
    : globalTone === "ok"
    ? "Servicios operativos, sin alertas y backups al día."
    : `${issues.length} ${issues.length === 1 ? "cosa requiere" : "cosas requieren"} tu atención ahora.`;

  const dims: Array<{ label: string; tone: Tone }> = [
    { label: "Servicios", tone: svcTone },
    { label: "Alertas",   tone: alertTone },
    { label: "Errores",   tone: errTone },
    { label: "Backups",   tone: backupTone },
  ];

  const hero = HERO[globalTone];
  const HeroIcon = hero.Icon;

  // ── Negocio: agregados de plataforma + pulso por organización ──
  const orgs = (traffic?.per_tenant ?? []).slice().sort((a, b) => b.tokens_30d - a.tokens_30d);
  const maxTokens = Math.max(1, ...orgs.map(o => o.tokens_30d));
  const totalQueries = orgs.reduce((s, o) => s + o.queries_30d, 0);
  const totalIngests = orgs.reduce((s, o) => s + o.ingests_30d, 0);

  return (
    <PageShell>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] bg-action-gradient bg-clip-text text-transparent">
          {fechaLabel}
        </p>
        <h1 className="mt-1 text-xl sm:text-2xl font-semibold tracking-tight">
          {greeting}{now && niceName ? `, ${niceName}` : ""}
        </h1>
      </div>

      {/* ── Hero de estado ── */}
      <div className={cn("relative overflow-hidden rounded-2xl border bg-gradient-to-br p-5 sm:p-6", hero.ring, hero.grad)}>
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-52 w-52 rounded-full opacity-[0.18] blur-3xl" style={{ background: hero.glow }} />
        <div className="relative flex items-start gap-4">
          <div className={cn("flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl shadow-sm", hero.iconBg)}>
            {healthLoading ? <Skeleton className="h-7 w-7 rounded-full" /> : <HeroIcon className="h-7 w-7" />}
          </div>
          <div className="min-w-0 flex-1">
            {healthLoading ? <Skeleton className="h-7 w-44" /> : <p className="text-xl sm:text-2xl font-semibold tracking-tight">{globalLabel}</p>}
            <p className="mt-1 text-sm text-muted-foreground leading-relaxed">{heroSummary}</p>
          </div>
        </div>
        <div className="relative mt-5 flex flex-wrap gap-2">
          {dims.map(d => <DimChip key={d.label} label={d.label} tone={healthLoading ? "ok" : d.tone} />)}
        </div>
      </div>

      {/* ── Requiere atención — solo si hay algo ── */}
      {!healthLoading && issues.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-warning/30 bg-warning/[0.05]">
          <div className="flex items-center justify-between gap-3 border-b border-warning/20 px-4 py-2.5">
            <p className="flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-warning" /> Requiere tu atención</p>
            <Link href="/superadmin/monitoring" className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">Ver en Monitoreo <ArrowRight className="h-3.5 w-3.5" /></Link>
          </div>
          <div className="divide-y divide-border/60">
            {issues.map((it, i) => (
              <Link key={i} href="/superadmin/monitoring" className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-warning/[0.06]">
                <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT[it.tone])} />
                <span className={cn("flex-1 min-w-0 truncate text-sm", it.tone === "down" ? "text-destructive font-medium" : "text-foreground")}>{it.text}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ── Números del negocio (últimos 30 días) ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
        <Kpi icon={Building2}     label="Organizaciones activas" value={(health?.active_tenants ?? 0).toLocaleString("es-AR")} loading={!health} />
        <Kpi icon={MessageSquare} label="Consultas · 30 días"    value={fmtNum(totalQueries)} loading={!traffic} />
        <Kpi
          icon={Coins}
          label="Gasto OpenAI · 30 días"
          value={costs?.available
            ? `US$ ${costs.total_usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : "—"}
          accentBrand
          loading={costs === undefined}
        />
        <Kpi icon={Upload}        label="Ingestas · 30 días"     value={fmtNum(totalIngests)} loading={!traffic} />
      </div>

      {/* ── Pulso de organizaciones ── */}
      <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
        <div className="flex items-center gap-2.5 border-b bg-muted/30 px-4 py-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-action-gradient-soft shrink-0">
            <Network className="h-4 w-4 text-action" />
          </span>
          <span className="text-sm font-semibold">Pulso de organizaciones</span>
          <span className="text-xs text-muted-foreground">consumo y actividad, últimos 30 días</span>
          <Link href="/superadmin/orgs" className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
            Ver todas <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        <div className="p-2">
          {!traffic ? (
            <div className="space-y-1 p-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-14 rounded-xl" />)}</div>
          ) : orgs.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">Todavía no hay organizaciones con actividad registrada.</p>
          ) : (
            <div className="divide-y divide-border/50">
              {orgs.map(o => {
                const idle = o.tokens_30d === 0 && o.queries_30d === 0;
                const pct = Math.round((o.tokens_30d / maxTokens) * 100);
                return (
                  <button
                    key={o.id}
                    onClick={() => router.push(`/superadmin/tenants/${o.id}`)}
                    className="group flex w-full items-center gap-3.5 rounded-lg px-3 py-3 text-left transition-colors hover:bg-muted/50"
                  >
                    <span className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold",
                      idle ? "bg-muted text-muted-foreground" : "bg-action-gradient-soft text-action",
                    )}>
                      {o.name.charAt(0).toUpperCase()}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="truncate text-sm font-semibold">{o.name}</p>
                        <p className="shrink-0 text-sm font-semibold tabular-nums">
                          {idle ? <span className="text-muted-foreground/70 font-normal">sin uso</span> : <>{fmtNum(o.tokens_30d)} <span className="text-xs font-normal text-muted-foreground">tokens</span></>}
                        </p>
                      </div>
                      {/* barra de consumo relativa al máximo */}
                      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div className={cn("h-full rounded-full", idle ? "bg-transparent" : "bg-action-gradient")} style={{ width: `${pct}%` }} />
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                        {fmtNum(o.queries_30d)} consultas · {fmtNum(o.ingests_30d)} ingestas
                      </p>
                    </div>

                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}
