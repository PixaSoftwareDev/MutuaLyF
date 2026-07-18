"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, TrendingDown, Globe, Smartphone } from "lucide-react";
import { api, type TenantMetrics } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";

// ── Formateo ─────────────────────────────────────────────────────────────────

const nf = (n: number) => n.toLocaleString("es-AR");

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Variación % contra el período anterior (null si no hay base de comparación)
const pctChange = (cur: number, prev: number): number | null =>
  prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null;

function fmtBytes(b: number): string {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
  return `${(b / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtDuration(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return nf(n);
}

// Serie continua de N días (rellena los días sin actividad con 0) para que el
// gráfico sea honesto y no comprima los huecos.
function buildDailySeries(daily: Array<{ day: string; total: number }>, days: number) {
  const byDay = new Map(daily.map((d) => [d.day, d.total]));
  const out: Array<{ date: Date; total: number }> = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.push({ date: d, total: byDay.get(key) ?? 0 });
  }
  return out;
}

// ── Gráfico de actividad (SVG inline) ────────────────────────────────────────
// Estilo de la referencia: línea fina azul oscura, área casi imperceptible,
// grilla punteada muy suave. El color es fijo (no de marca): es dato, no chrome.
const CHART_COLOR = "#2563eb";

function ActivityChart({ series }: { series: Array<{ date: Date; total: number }> }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = series.length;
  const w = 1000, h = 220, padY = 18;
  const max = Math.max(...series.map((s) => s.total), 1);
  const step = w / (n - 1 || 1);
  const y = (v: number) => h - padY - (v / max) * (h - padY * 2);
  const pts = series.map((s, i) => [i * step, y(s.total)] as const);
  // Curva suave (mitad de segmento como control) → trazo moderno, no quebrado.
  const path = pts.reduce((acc, p, i) => {
    if (i === 0) return `M ${p[0]},${p[1]}`;
    const p0 = pts[i - 1];
    const cx = (p0[0] + p[0]) / 2;
    return `${acc} C ${cx},${p0[1]} ${cx},${p[1]} ${p[0]},${p[1]}`;
  }, "");
  const areaPath = `${path} L ${w},${h} L 0,${h} Z`;

  // Mapeo en fracciones (0-1) para posicionar overlays HTML sobre el mismo box
  // que el SVG, sin la distorsión de preserveAspectRatio="none".
  const padFrac = padY / h, span = 1 - 2 * padFrac;
  const xFrac = (i: number) => (n === 1 ? 0 : i / (n - 1));
  const yFrac = (v: number) => 1 - padFrac - (v / max) * span;

  const fmtDay = (d: Date, long = false) =>
    d.toLocaleDateString("es-AR", long ? { weekday: "short", day: "2-digit", month: "short" } : { day: "2-digit", month: "short" });
  const gridVals = [max, Math.round(max / 2), 0];
  // ~6 etiquetas de fecha repartidas en el eje X.
  const tickIdx = Array.from(new Set(Array.from({ length: 6 }, (_, k) => Math.round((k / 5) * (n - 1)))));
  const peakIdx = series.reduce((best, s, i) => (s.total > series[best].total ? i : best), 0);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left) / rect.width) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const active = hover != null ? series[hover] : null;

  return (
    <div className="select-none pl-9">
      <div className="relative h-52">
        {/* Etiquetas del eje Y */}
        <div className="pointer-events-none absolute inset-y-0 -left-9 w-8 text-right">
          {gridVals.map((v) => (
            <span key={v} className="absolute right-0 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground/70" style={{ top: `${yFrac(v) * 100}%` }}>{nf(v)}</span>
          ))}
        </div>

        <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full" preserveAspectRatio="none" role="img" aria-label={`Consultas diarias de los últimos ${n} días`}>
          <defs>
            <linearGradient id="mx-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLOR} stopOpacity="0.10" />
              <stop offset="100%" stopColor={CHART_COLOR} stopOpacity="0" />
            </linearGradient>
          </defs>
          {gridVals.map((v) => (
            <line key={v} x1="0" x2={w} y1={y(v)} y2={y(v)} stroke="hsl(var(--border))" strokeWidth="1" strokeDasharray="2 6" vectorEffect="non-scaling-stroke" />
          ))}
          <path d={areaPath} fill="url(#mx-area)" />
          <path d={path} fill="none" stroke={CHART_COLOR} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>

        {/* Marca fija en el pico con su valor */}
        {max > 0 && hover == null && (
          <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full" style={{ left: `${xFrac(peakIdx) * 100}%`, top: `${yFrac(series[peakIdx].total) * 100}%` }}>
            <span className="mb-1 block whitespace-nowrap rounded-md bg-foreground/90 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-background">{nf(series[peakIdx].total)}</span>
          </div>
        )}

        {/* Guía + punto + tooltip en hover */}
        {active && (
          <>
            <div className="pointer-events-none absolute inset-y-0 w-px opacity-30" style={{ left: `${xFrac(hover!) * 100}%`, backgroundColor: CHART_COLOR }} />
            <div className="pointer-events-none absolute z-10 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card shadow" style={{ left: `${xFrac(hover!) * 100}%`, top: `${yFrac(active.total) * 100}%`, backgroundColor: CHART_COLOR }} />
            <div className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg bg-foreground px-2.5 py-1.5 text-center text-background shadow-md" style={{ left: `${Math.min(Math.max(xFrac(hover!) * 100, 8), 92)}%`, top: `calc(${yFrac(active.total) * 100}% - 8px)` }}>
              <p className="text-sm font-bold tabular-nums leading-none">{nf(active.total)} <span className="font-medium opacity-80">{active.total === 1 ? "consulta" : "consultas"}</span></p>
              <p className="mt-0.5 text-[10px] capitalize opacity-70">{fmtDay(active.date, true)}</p>
            </div>
          </>
        )}

        {/* Captura de hover sobre todo el área */}
        <div className="absolute inset-0 cursor-crosshair" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </div>

      {/* Eje X: fechas repartidas */}
      <div className="relative mt-2 h-4">
        {tickIdx.map((i, k) => (
          <span key={i} className={cn("absolute text-[10px] tabular-nums text-muted-foreground/70", k === 0 && "left-0", k === tickIdx.length - 1 && "right-0", k !== 0 && k !== tickIdx.length - 1 && "-translate-x-1/2")}
            style={k === 0 || k === tickIdx.length - 1 ? undefined : { left: `${xFrac(i) * 100}%` }}>
            {i === n - 1 ? "hoy" : fmtDay(series[i].date)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Barras diarias (molde referencia: barras planas redondeadas, sin ejes) ───
// Serie continua de 30 días; `secondary` pinta un subconjunto (ej. derivadas)
// como segmento ámbar sobre la base azul.
function DailyBars({ data, days = 30, titleFmt }: {
  data: Array<{ day: string; total: number; secondary?: number }>;
  days?: number;
  titleFmt: (d: { date: Date; total: number; secondary: number }) => string;
}) {
  const byDay = new Map(data.map(d => [d.day, d]));
  const series: Array<{ date: Date; total: number; secondary: number }> = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const row = byDay.get(key);
    series.push({ date: d, total: row?.total ?? 0, secondary: row?.secondary ?? 0 });
  }
  const max = Math.max(...series.map(s => s.total), 1);
  const fmtDay = (d: Date) => d.toLocaleDateString("es-AR", { day: "2-digit", month: "short" });

  return (
    <div>
      <div className="flex h-28 items-end gap-[3px]">
        {series.map((s, i) => (
          <div key={i} className="group relative flex h-full flex-1 items-end rounded-[3px] bg-muted/40" title={titleFmt(s)}>
            {s.total > 0 && (
              <div
                className="relative w-full rounded-[3px] transition-opacity group-hover:opacity-80"
                style={{ height: `${Math.max((s.total / max) * 100, 3)}%`, backgroundColor: CHART_COLOR }}
              >
                {s.secondary > 0 && (
                  <div
                    className="absolute inset-x-0 bottom-0 rounded-b-[3px] bg-warning"
                    style={{ height: `${Math.min((s.secondary / s.total) * 100, 100)}%` }}
                  />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] tabular-nums text-muted-foreground/70">
        <span>{fmtDay(series[0].date)}</span>
        <span>hoy</span>
      </div>
    </div>
  );
}

/** Fila de desglose (molde referencia): cuadradito de color + label + valor. */
function BreakdownRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5 py-1.5 text-sm">
      <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: color }} />
      <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
      <span className="shrink-0 font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

// ── Primitivas (elevación por sombra, sin bordes duros) ──────────────────────

// Molde de la referencia (Reports): cards blancas con borde fino, sin sombras.
function Card({ children, className, interactive }: { children: React.ReactNode; className?: string; interactive?: boolean }) {
  return (
    <div className={cn("rounded-xl border bg-card p-5", interactive && "card-interactive", className)}>
      {children}
    </div>
  );
}

// Título de sección plano ("Chats", "Tickets" de la referencia) + ancla para
// navegar desde el panel. scroll-mt compensa el padding del contenedor.
function Group({ label, meta, id, children }: { label: string; meta?: string; id?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-4 space-y-3">
      <h2 className="flex items-baseline gap-2 px-1 text-sm font-semibold text-foreground">
        {label}
        {meta && <span className="text-xs font-normal text-muted-foreground">{meta}</span>}
      </h2>
      {children}
    </section>
  );
}

// ── Página ───────────────────────────────────────────────────────────────────

export default function MetricsPage() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["tenant-metrics"],
    queryFn: api.metrics.get,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  return (
    <PageShell width="wide">
      {isError ? (
        <Card><ErrorState title="No se pudieron cargar las métricas" description="Probá de nuevo en un momento." onRetry={() => refetch()} /></Card>
      ) : isLoading || !data ? (
        <MetricsSkeleton />
      ) : (
        <Suspense fallback={<MetricsSkeleton />}>
          <Dashboard m={data} />
        </Suspense>
      )}
    </PageShell>
  );
}

// Cada informe es su PROPIA vista (?view=), como los reports de la referencia —
// el panel de la sección navega entre ellas. Sin scroll compartido ni anclas.
type ViewKey = "resumen" | "asistente" | "atencion" | "conocimiento" | "plan";
const VIEW_TITLES: Record<ViewKey, string> = {
  resumen: "Resumen", asistente: "Asistente", atencion: "Atención",
  conocimiento: "Conocimiento", plan: "Plan",
};

function Dashboard({ m }: { m: TenantMetrics }) {
  const params = useSearchParams();
  const raw = params.get("view");
  const view: ViewKey = raw && raw in VIEW_TITLES ? (raw as ViewKey) : "resumen";
  const [range, setRange] = useState<7 | 30 | 90>(30);
  const series = useMemo(() => buildDailySeries(m.usage.daily, range), [m.usage.daily, range]);
  const rangeTotal = useMemo(() => series.reduce((a, s) => a + s.total, 0), [series]);
  const conf = m.performance.avg_confidence;
  const cache = m.performance.cache_hit_rate;

  // Estado de cada KPI → lavado sutil de fondo. Solo se colorea lo notable;
  // con pocos datos no se colorea nada (un 66% sobre 3 conversaciones no es señal).
  const resolvedTone: KpiTone | null =
    m.conversations.bot_resolved_pct == null || m.conversations.total < 10 ? null
    : m.conversations.bot_resolved_pct >= 85 ? "good"
    : m.conversations.bot_resolved_pct < 65 ? "warn"
    : null;
  const confTone: KpiTone | null =
    conf == null ? null : conf >= 0.8 ? "good" : conf < 0.6 ? "warn" : null;
  const latencyTone: KpiTone | null =
    m.performance.latency_p50 == null ? null
    : m.performance.latency_p50 <= 2500 ? "good"
    : m.performance.latency_p50 > 4000 ? "warn"
    : null;

  // Alguna cuota del plan al 90%+ → la card entera avisa con el lavado ámbar.
  const quotaWarn =
    (m.quota.queries_month.limit > 0 && (m.quota.queries_month.pct ?? 0) >= 90) ||
    (m.quota.documents.limit > 0 && (m.quota.documents.pct ?? 0) >= 90);

  return (
    <div className="space-y-8">
      {/* ── Cabecera del informe: barra estándar (patrón referencia) ────────── */}
      <PageHeader
        title={VIEW_TITLES[view]}
        badge={<span className="text-xs text-muted-foreground">últimos {view === "resumen" ? range : 30} días</span>}
        actions={view === "resumen" ? (
          <div className="flex items-center gap-0.5">
            {([7, 30, 90] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={cn(
                  "rounded-lg px-2.5 py-1 text-[13px] font-medium tabular-nums transition-colors",
                  range === r ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {r} días
              </button>
            ))}
          </div>
        ) : undefined}
      />

      {/* ══ RESUMEN ══════════════════════════════════════════════════════════ */}
      {view === "resumen" && (<>
      <div className="grid grid-cols-2 gap-4 stagger-children xl:grid-cols-4">
        <Kpi label="Consultas este mes" value={nf(m.usage.queries_this_month)} foot={<Delta pct={m.usage.mom_pct} />} />
        <Kpi
          label="Resueltas por el bot"
          tone={resolvedTone}
          value={m.conversations.bot_resolved_pct != null ? `${m.conversations.bot_resolved_pct}%` : "—"}
          foot={m.conversations.total > 0
            ? <span className="text-muted-foreground">{nf(m.conversations.handoffs)} pasaron a una persona</span>
            : <span className="text-muted-foreground">Sin conversaciones aún</span>}
        />
        <Kpi
          label="Confianza promedio"
          tone={confTone}
          value={conf != null ? `${Math.round(conf * 100)}%` : "—"}
          foot={<span className="text-muted-foreground">{cache != null ? `${Math.round(cache * 100)}% resuelto por caché` : "—"}</span>}
        />
        <Kpi
          label="Tiempo de respuesta"
          tone={latencyTone}
          value={m.performance.latency_p50 != null ? `${(m.performance.latency_p50 / 1000).toFixed(1)}s` : "—"}
          foot={<span className="text-muted-foreground">{m.performance.latency_p95 != null ? `p95 ${(m.performance.latency_p95 / 1000).toFixed(1)}s` : "mediana"}</span>}
        />
      </div>

      <div className="rounded-xl border bg-card p-6">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-foreground">Actividad</p>
            <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums">{nf(rangeTotal)}</p>
            <p className="text-xs text-muted-foreground">consultas · últimos {range} días</p>
          </div>
          <p className="text-xs text-muted-foreground"><span className="font-semibold text-foreground">{nf(m.usage.queries_today)}</span> hoy</p>
        </div>
        <ActivityChart series={series} />
      </div>
      </>)}

      {/* ══ ASISTENTE ════════════════════════════════════════════════════════ */}
      {view === "asistente" && (<>
      <div className="grid grid-cols-2 gap-4 stagger-children xl:grid-cols-4">
        <Kpi
          label="Confianza promedio"
          tone={confTone}
          value={conf != null ? `${Math.round(conf * 100)}%` : "—"}
          foot={<span className="text-muted-foreground">al clasificar consultas</span>}
        />
        <Kpi
          label="Resuelto por caché"
          value={cache != null ? `${Math.round(cache * 100)}%` : "—"}
          foot={<span className="text-muted-foreground">respuestas instantáneas</span>}
        />
        <Kpi
          label="Tiempo de respuesta"
          tone={latencyTone}
          value={m.performance.latency_p50 != null ? `${(m.performance.latency_p50 / 1000).toFixed(1)}s` : "—"}
          foot={<span className="text-muted-foreground">{m.performance.latency_p95 != null ? `p95 ${(m.performance.latency_p95 / 1000).toFixed(1)}s` : "mediana"}</span>}
        />
        <Kpi
          label="Sin clasificar"
          tone={m.performance.total_logged > 0 && m.performance.unclassified_30d / m.performance.total_logged > 0.3 ? "warn" : null}
          value={nf(m.performance.unclassified_30d)}
          foot={<span className="text-muted-foreground">
            {m.performance.total_logged > 0
              ? `${Math.round((m.performance.unclassified_30d / m.performance.total_logged) * 100)}% de las consultas`
              : "sin consultas aún"}
          </span>}
        />
      </div>

      <Card className="p-6">
        <CardTitle title="Consultas al asistente por día" meta="30 días" />
        <DailyBars
          data={m.assistant.daily.map(d => ({ day: d.day, total: d.total }))}
          titleFmt={s => {
            const conf = m.assistant.daily.find(d => d.day === isoDay(s.date))?.avg_confidence;
            return `${s.date.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })}: ${nf(s.total)} consultas${conf != null ? ` · confianza ${Math.round(conf * 100)}%` : ""}`;
          }}
        />
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle title="Temas más consultados" meta="30 días" />
          <TopIntents items={m.top_intents} />
        </Card>
        <Card className="p-2">
          <div className="px-3 pb-1 pt-3"><CardTitle title="Consultas recientes" /></div>
          <RecentQueries items={m.recent_queries} />
        </Card>
      </div>
      </>)}

      {/* ══ ATENCIÓN ═════════════════════════════════════════════════════════ */}
      {view === "atencion" && (<>
      <div className="grid grid-cols-2 gap-4 stagger-children xl:grid-cols-4">
        <Kpi
          label="Conversaciones"
          value={nf(m.conversations.total)}
          foot={<Delta pct={pctChange(m.conversations.total, m.conversations.prev_total)} label="vs. 30 días previos" />}
        />
        <Kpi
          label="Resueltas por el bot"
          tone={resolvedTone}
          value={m.conversations.bot_resolved_pct != null ? `${m.conversations.bot_resolved_pct}%` : "—"}
          foot={<span className="text-muted-foreground">{nf(m.conversations.handoffs)} derivadas ({m.conversations.handoff_rate != null ? `${Math.round(m.conversations.handoff_rate * 100)}%` : "—"})</span>}
        />
        <Kpi
          label="Espera hasta operador"
          value={fmtDuration(m.conversations.avg_wait_seconds)}
          foot={<span className="text-muted-foreground">del pedido a la primera respuesta</span>}
        />
        <Kpi label="Resolución promedio" value={fmtDuration(m.conversations.avg_resolution_seconds)} foot={<span className="text-muted-foreground">de inicio a cierre</span>} />
      </div>

      <Card className="p-6">
        <div className="mb-4 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-foreground">Conversaciones por día</h3>
          <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ backgroundColor: CHART_COLOR }} /> Total</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px] bg-warning" /> Derivadas</span>
          </div>
        </div>
        <DailyBars
          data={m.conversations.daily.map(d => ({ day: d.day, total: d.total, secondary: d.handoffs }))}
          titleFmt={s => `${s.date.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })}: ${nf(s.total)} conversaciones · ${nf(s.secondary)} derivadas`}
        />
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-6">
          {m.conversations.total === 0 ? (
            <Empty text="Todavía no hay conversaciones registradas." />
          ) : (
            <SplitBar
              label="Cómo terminaron"
              segments={[
                { label: "Resueltas por el bot", value: Math.max(m.conversations.total - m.conversations.handoffs, 0), color: "bg-foreground", dot: "bg-foreground" },
                { label: "Pasaron a una persona", value: m.conversations.handoffs, color: "bg-warning", dot: "bg-warning" },
              ]}
            />
          )}
        </Card>
        <Card className="p-6">
          {m.conversations.total === 0 ? (
            <Empty text="Todavía no hay conversaciones registradas." />
          ) : (
            <SplitBar
              label="Por dónde llegaron"
              segments={[
                { label: "Widget", value: m.conversations.widget, color: "bg-info", dot: "bg-info", icon: Globe },
                { label: "WhatsApp", value: m.conversations.whatsapp, color: "bg-success", dot: "bg-success", icon: Smartphone },
              ]}
            />
          )}
        </Card>
        <Card className="p-6">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Por sector</p>
          {m.conversations.by_sector.length === 0 ? (
            <Empty text="Sin datos aún." />
          ) : (
            <div className="divide-y divide-border/60">
              {m.conversations.by_sector.map(s => (
                <BreakdownRow key={s.nombre} color={CHART_COLOR} label={s.nombre} value={nf(s.total)} />
              ))}
            </div>
          )}
        </Card>
      </div>
      </>)}

      {/* ══ CONOCIMIENTO ═════════════════════════════════════════════════════ */}
      {view === "conocimiento" && (<>
      <div className="grid grid-cols-2 gap-4 stagger-children xl:grid-cols-4">
        <Kpi label="Documentos" value={nf(m.docs.total)} foot={<span className="text-muted-foreground">{fmtBytes(m.docs.storage_bytes)} usados</span>} />
        <Kpi label="Listos" tone={m.docs.total > 0 && m.docs.ready === m.docs.total ? "good" : null} value={nf(m.docs.ready)} foot={<span className="text-muted-foreground">indexados y consultables</span>} />
        <Kpi label="Con error" tone={m.docs.failed > 0 ? "warn" : null} value={nf(m.docs.failed)} foot={<span className="text-muted-foreground">{m.docs.processing > 0 ? `${nf(m.docs.processing)} procesando` : "nada procesando"}</span>} />
        <Kpi label="Ingestas" value={nf(m.usage.ingests_30d)} foot={<span className="text-muted-foreground">últimos 30 días</span>} />
      </div>

      <Card className="p-6">
        <CardTitle title="Ingestas por día" meta="30 días" />
        <DailyBars
          data={m.usage.ingest_daily}
          titleFmt={s => `${s.date.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })}: ${nf(s.total)} ingestas`}
        />
      </Card>

        <Card>
            <CardTitle title="Documentos" meta={`${fmtBytes(m.docs.storage_bytes)} usados`} />
            <div className="grid grid-cols-3 gap-3">
              <DocStat label="Listos" value={m.docs.ready} tone="text-success" />
              <DocStat label="Procesando" value={m.docs.processing} tone="text-info" />
              <DocStat label="Con error" value={m.docs.failed} tone={m.docs.failed > 0 ? "text-destructive" : "text-muted-foreground"} />
            </div>
            <div className="mt-5">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Validación de calidad</p>
              <QualityBar q={m.quality} />
            </div>
        </Card>
      </>)}

      {/* ══ PLAN ═════════════════════════════════════════════════════════════ */}
      {view === "plan" && (<>
      <div className="grid grid-cols-2 gap-4 stagger-children xl:grid-cols-4">
        <Kpi
          label="Consultas"
          value={nf(m.usage.queries_30d)}
          foot={<Delta pct={pctChange(m.usage.queries_30d, m.usage.queries_prev_30d)} label="vs. 30 días previos" />}
        />
        <Kpi
          label="Tokens LLM"
          value={fmtTokens(m.usage.llm_tokens_30d)}
          foot={<Delta pct={pctChange(m.usage.llm_tokens_30d, m.usage.llm_tokens_prev_30d)} label="vs. 30 días previos" />}
        />
        <Kpi
          label="Cuota de consultas"
          tone={m.quota.queries_month.limit > 0 && (m.quota.queries_month.pct ?? 0) >= 90 ? "warn" : null}
          value={m.quota.queries_month.pct != null ? `${m.quota.queries_month.pct}%` : "∞"}
          foot={<span className="text-muted-foreground">del límite mensual</span>}
        />
        <Kpi
          label="Cuota de documentos"
          tone={m.quota.documents.limit > 0 && (m.quota.documents.pct ?? 0) >= 90 ? "warn" : null}
          value={m.quota.documents.pct != null ? `${m.quota.documents.pct}%` : "∞"}
          foot={<span className="text-muted-foreground">del límite del plan</span>}
        />
      </div>

      <Card className="p-6">
        <CardTitle title="Tokens LLM por día" meta="30 días" />
        <DailyBars
          data={m.usage.tokens_daily}
          titleFmt={s => `${s.date.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })}: ${fmtTokens(s.total)} tokens`}
        />
      </Card>

          <Card>
            <div className="mb-4 flex items-baseline justify-between">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                {quotaWarn && <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT.warn)} />}
                Plan y consumo
              </h3>
              {m.tenant.plan && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold capitalize text-foreground">{m.tenant.plan}</span>
              )}
            </div>
            <div className="grid gap-x-10 gap-y-5 sm:grid-cols-2">
              <QuotaBar label="Consultas del mes" used={m.quota.queries_month.used} limit={m.quota.queries_month.limit} pct={m.quota.queries_month.pct} />
              <QuotaBar label="Documentos" used={m.quota.documents.used} limit={m.quota.documents.limit} pct={m.quota.documents.pct} />
            </div>
            <div className="mt-5 grid border-t pt-2 sm:grid-cols-2 sm:gap-x-10">
              <DataRow label="Tokens LLM · 30 días" value={fmtTokens(m.usage.llm_tokens_30d)} />
              <DataRow label="Ingestas · 30 días" value={nf(m.usage.ingests_30d)} />
            </div>
          </Card>
      </>)}
    </div>
  );
}

// ── Sub-componentes ──────────────────────────────────────────────────────────

function CardTitle({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="mb-4 flex items-baseline justify-between">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {meta && <span className="text-xs tabular-nums text-muted-foreground">{meta}</span>}
    </div>
  );
}

/** KPI: número protagonista, sin chip de color — el dato manda, el color se
 *  reserva a lo que comunica (tendencia, estado).
 *
 *  `tone` agrega un lavado de fondo apenas perceptible SOLO cuando la métrica
 *  está en un estado notable (bien / floja). Neutro = sin color: la ausencia
 *  de tinte también comunica. El puntito junto al label refuerza el estado
 *  para que no dependa solo del fondo (daltonismo, modo oscuro). */
type KpiTone = "good" | "warn";

const TONE_DOT: Record<KpiTone, string> = {
  good: "bg-success",
  warn: "bg-warning",
};

function Kpi({ label, value, foot, tone }: { label: string; value: React.ReactNode; foot?: React.ReactNode; tone?: KpiTone | null }) {
  return (
    <Card interactive>
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {tone && <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[tone])} />}
        {label}
      </p>
      <p className="mt-2 text-3xl font-bold leading-none tracking-tight tabular-nums text-foreground">{value}</p>
      {foot && <div className="mt-2.5 text-xs">{foot}</div>}
    </Card>
  );
}

function Delta({ pct, label = "vs. mes anterior" }: { pct: number | null; label?: string }) {
  // Sin comparativa → chip gris "–" (molde de la referencia), no una frase larga.
  if (pct == null) return (
    <span className="inline-flex items-center gap-1.5">
      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">–</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
  const up = pct >= 0;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
        up ? "bg-success/10 text-success" : "bg-attention/10 text-attention")}>
        {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
        {up ? "+" : ""}{pct}%
      </span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

/** Barra de distribución con leyenda — mismo lenguaje visual que QualityBar.
 *  Cada segmento muestra su parte proporcional; la leyenda lleva conteo y %. */
function SplitBar({ label, segments }: {
  label: string;
  segments: Array<{ label: string; value: number; color: string; dot: string; icon?: typeof Globe }>;
}) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  if (total === 0) return null;
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-muted">
        {segments.map((s) => s.value > 0 && (
          <div key={s.label} className={cn("h-full transition-all", s.color)} style={{ width: `${(s.value / total) * 100}%` }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span className={cn("h-2 w-2 rounded-full", s.dot)} />
            {s.icon && <s.icon className="h-3 w-3" />}
            {s.label}
            <span className="font-semibold tabular-nums text-foreground">{nf(s.value)}</span>
            <span className="tabular-nums">· {Math.round((s.value / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function TopIntents({ items }: { items: TenantMetrics["top_intents"] }) {
  if (items.length === 0) return <Empty text="Todavía no hay temas clasificados." />;
  const max = Math.max(...items.map((i) => i.count), 1);
  const sum = items.reduce((a, i) => a + i.count, 0);
  return (
    <ul className="space-y-3.5">
      {items.map((it, idx) => (
        <li key={it.label} className="space-y-1.5">
          <div className="flex items-baseline gap-2.5">
            <span className="w-4 shrink-0 text-right text-[11px] font-semibold tabular-nums text-muted-foreground/60">{idx + 1}</span>
            <span className="min-w-0 truncate text-sm text-foreground">{it.label}</span>
            <span className="ml-auto shrink-0 text-xs font-semibold tabular-nums text-foreground">{nf(it.count)}</span>
            <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{Math.round((it.count / sum) * 100)}%</span>
          </div>
          <div className="ml-[26px] h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full transition-all" style={{ width: `${(it.count / max) * 100}%`, backgroundColor: CHART_COLOR }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function RecentQueries({ items }: { items: TenantMetrics["recent_queries"] }) {
  if (items.length === 0) return <div className="px-3"><Empty text="Todavía no hay consultas registradas." /></div>;
  const fmtWhen = (iso: string) => new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <ul>
      {items.map((q, i) => (
        <li key={i} className="flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-muted/60">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-action/60" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-foreground">{q.question_text ?? <span className="italic text-muted-foreground">Sin texto</span>}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
              {q.intent_label && <span className="font-medium text-foreground/70">{q.intent_label}</span>}
              <span>{fmtWhen(q.created_at)}</span>
              {q.from_cache && <span>· caché</span>}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function DocStat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-xl bg-muted/40 px-3 py-4 text-center">
      <p className={cn("text-2xl font-bold tabular-nums", tone)}>{nf(value)}</p>
      <p className="mt-0.5 text-[11px] font-medium text-muted-foreground">{label}</p>
    </div>
  );
}

function DataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-muted/60">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="ml-auto text-sm font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function QualityBar({ q }: { q: TenantMetrics["quality"] }) {
  const total = q.passed + q.pending + q.skipped;
  if (total === 0) return <Empty text="Sin documentos validados aún." />;
  const seg = (n: number, cls: string) => n > 0 && <div className={cls} style={{ width: `${(n / total) * 100}%` }} />;
  return (
    <div className="space-y-2.5">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
        {seg(q.passed, "bg-success")}
        {seg(q.pending, "bg-warning")}
        {seg(q.skipped, "bg-muted-foreground/40")}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <Legend color="bg-success" label="Validados" n={q.passed} />
        <Legend color="bg-warning" label="Pendientes" n={q.pending} />
        <Legend color="bg-muted-foreground/40" label="Omitidos" n={q.skipped} />
      </div>
    </div>
  );
}

function Legend({ color, label, n }: { color: string; label: string; n: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("h-2 w-2 rounded-full", color)} /> {label} <span className="font-semibold tabular-nums text-foreground">{nf(n)}</span>
    </span>
  );
}

function QuotaBar({ label, used, limit, pct }: { label: string; used: number; limit: number; pct: number | null }) {
  const unlimited = limit <= 0;
  const p = pct ?? 0;
  const barColor = p >= 90 ? "bg-destructive" : p >= 75 ? "bg-warning" : "bg-foreground";
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {unlimited ? (
            <><span className="font-semibold text-foreground">{nf(used)}</span> · sin límite</>
          ) : (
            <>{nf(used)} / {nf(limit)}{pct != null && <span className="ml-1 font-semibold text-foreground">{pct}%</span>}</>
          )}
        </span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-muted">
        {!unlimited && <div className={cn("h-full rounded-full transition-all", barColor)} style={{ width: `${Math.min(p, 100)}%` }} />}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{text}</p>;
}

// ── Skeleton ─────────────────────────────────────────────────────────────────

function MetricsSkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
      </div>
      <Skeleton className="h-72 rounded-2xl" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    </div>
  );
}
