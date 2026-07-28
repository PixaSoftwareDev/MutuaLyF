"use client";

import { useMemo, useState } from "react";
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

// Variación % contra el período anterior (null si no hay base de comparación)
const pctChange = (cur: number, prev: number): number | null =>
  prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null;

function fmtDuration(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
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

// ── Dashboard ────────────────────────────────────────────────────────────────

// Cada informe es su PROPIA ruta (/admin/metrics, /asistente, /atencion). El
// `view` llega por prop desde la page de cada ruta, no por query-param.
export type ViewKey = "resumen" | "asistente" | "atencion";
const VIEW_TITLES: Record<ViewKey, string> = {
  resumen: "Resumen", asistente: "Asistente", atencion: "Atención",
};

export function MetricsDashboard({ view }: { view: ViewKey }) {
  // La ventana (7/30/90) vive acá porque dispara el refetch: los informes
  // Asistente y Atención se recalculan en el backend para el período elegido.
  const [range, setRange] = useState<7 | 30 | 90>(30);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["tenant-metrics", range],
    queryFn: () => api.metrics.get(range),
    staleTime: 60_000,
    refetchInterval: 120_000,
    placeholderData: (prev) => prev, // no parpadea al cambiar de rango
  });

  return (
    <PageShell width="wide">
      {isError ? (
        <Card><ErrorState title="No se pudieron cargar las métricas" description="Probá de nuevo en un momento." onRetry={() => refetch()} /></Card>
      ) : isLoading || !data ? (
        <MetricsSkeleton />
      ) : (
        <Dashboard m={data} view={view} range={range} setRange={setRange} />
      )}
    </PageShell>
  );
}

function Dashboard({ m, view, range, setRange }: { m: TenantMetrics; view: ViewKey; range: 7 | 30 | 90; setRange: (r: 7 | 30 | 90) => void }) {
  const series = useMemo(() => buildDailySeries(m.usage.daily, range), [m.usage.daily, range]);
  const rangeTotal = useMemo(() => series.reduce((a, s) => a + s.total, 0), [series]);
  const cache = m.performance.cache_hit_rate;

  // Estado de cada KPI → lavado sutil de fondo. Solo se colorea lo notable;
  // con pocos datos no se colorea nada (un 66% sobre 3 conversaciones no es señal).
  const resolvedTone: KpiTone | null =
    m.conversations.bot_resolved_pct == null || m.conversations.total < 10 ? null
    : m.conversations.bot_resolved_pct >= 85 ? "good"
    : m.conversations.bot_resolved_pct < 65 ? "warn"
    : null;
  const latencyTone: KpiTone | null =
    m.performance.latency_p50 == null ? null
    : m.performance.latency_p50 <= 2500 ? "good"
    : m.performance.latency_p50 > 4000 ? "warn"
    : null;

  return (
    <div className="space-y-8">
      {/* ── Cabecera del informe: barra estándar (patrón referencia) ────────── */}
      <PageHeader
        title={VIEW_TITLES[view]}
        badge={<span className="text-xs text-muted-foreground">últimos {range} días</span>}
        actions={(
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
        )}
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
      </div>

      <Card className="p-6">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-foreground">Actividad</p>
            <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums">{nf(rangeTotal)}</p>
            <p className="text-xs text-muted-foreground">consultas · últimos {range} días</p>
          </div>
          <p className="text-xs text-muted-foreground"><span className="font-semibold text-foreground">{nf(m.usage.queries_today)}</span> hoy</p>
        </div>
        <DailyBars
          data={m.usage.daily}
          days={range}
          titleFmt={s => `${s.date.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })}: ${nf(s.total)} consultas`}
        />
      </Card>

      {/* Highlights de un vistazo: qué preguntan + cómo termina la atención.
          Curados para el overview; el detalle vive en Asistente y Atención. */}
      <div className="grid grid-cols-1 gap-4">
        <Card className="space-y-5 p-6">
          {m.conversations.total === 0 ? (
            <Empty text="Todavía no hay conversaciones registradas." />
          ) : (
            <>
              <SplitBar
                label="Cómo terminaron las conversaciones"
                segments={[
                  { label: "Resueltas por el bot", value: Math.max(m.conversations.total - m.conversations.handoffs, 0), color: "bg-foreground", dot: "bg-foreground" },
                  { label: "Pasaron a una persona", value: m.conversations.handoffs, color: "bg-warning", dot: "bg-warning" },
                ]}
              />
              <SplitBar
                label="Por dónde llegaron"
                segments={[
                  { label: "Widget",   value: m.conversations.widget,   color: "bg-info",    dot: "bg-info",    icon: Globe },
                  { label: "WhatsApp", value: m.conversations.whatsapp, color: "bg-success", dot: "bg-success", icon: Smartphone },
                ]}
              />
            </>
          )}
        </Card>
      </div>
      </>)}

      {/* ══ ASISTENTE ════════════════════════════════════════════════════════ */}
      {view === "asistente" && (<>
      <div className="grid grid-cols-3 gap-4 stagger-children">
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
          label="Consultas registradas"
          value={nf(m.performance.total_logged)}
          foot={<span className="text-muted-foreground">últimos 30 días</span>}
        />
      </div>

      <Card className="p-6">
        <CardTitle title="Consultas al asistente por día" meta={`${range} días`} />
        <DailyBars
          data={m.usage.daily}
          days={range}
          titleFmt={s => `${s.date.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })}: ${nf(s.total)} consultas`}
        />
      </Card>

      <div className="grid grid-cols-1 gap-4">
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
          foot={<Delta pct={pctChange(m.conversations.total, m.conversations.prev_total)} label={`vs. ${range} días previos`} />}
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

      {/* Satisfacción (caritas al cierre) — aparece cuando hay calificaciones */}
      {m.conversations.feedback && m.conversations.feedback.rated > 0 && (
        <div className="grid grid-cols-2 gap-4 stagger-children xl:grid-cols-4">
          <Kpi
            label="Satisfacción"
            tone={m.conversations.feedback.satisfaction_pct != null && m.conversations.feedback.satisfaction_pct >= 70 ? "good" : "warn"}
            value={m.conversations.feedback.satisfaction_pct != null ? `${m.conversations.feedback.satisfaction_pct}%` : "—"}
            foot={<span className="text-muted-foreground">😞 {m.conversations.feedback.sad} · 😐 {m.conversations.feedback.neutral} · 😊 {m.conversations.feedback.happy}</span>}
          />
          <Kpi
            label="Satisfacción del bot"
            value={m.conversations.feedback.satisfaction_bot_pct != null ? `${m.conversations.feedback.satisfaction_bot_pct}%` : "—"}
            foot={<span className="text-muted-foreground">solo conversaciones sin operador</span>}
          />
          <Kpi
            label="Responden la encuesta"
            value={m.conversations.feedback.response_rate_pct != null ? `${m.conversations.feedback.response_rate_pct}%` : "—"}
            foot={<span className="text-muted-foreground">de las conversaciones cerradas</span>}
          />
          <Kpi
            label="Feedback por revisar"
            tone={m.conversations.feedback.pending_review > 0 ? "warn" : undefined}
            value={nf(m.conversations.feedback.pending_review)}
            foot={<span className="text-muted-foreground">en la cola de Feedback</span>}
          />
        </div>
      )}

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
          days={range}
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
              <span>{fmtWhen(q.created_at)}</span>
              {q.from_cache && <span>· caché</span>}
            </p>
          </div>
        </li>
      ))}
    </ul>
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
