"use client";

// Detalle de organización — la ficha de cliente del superadmin.
// Un solo scroll que responde, en orden: ¿hay algo que mirar? → quién es y
// qué contrata (Ficha/Asistente) → cuánto usa → qué pregunta la gente →
// quiénes entran → salud técnica. Cada pieza vive en _components/.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { StatePill, type StatePillTone } from "@/components/ui/state-pill";
import { SuperShell } from "@/components/superadmin/shell";
import { quotaTone } from "@/components/superadmin/status";
import { cn } from "@/lib/utils";
import { FichaPanel } from "./_components/ficha-panel";
import { AssistantPanel } from "./_components/assistant-panel";
import { UsagePanel } from "./_components/usage-panel";
import { QueriesPanel } from "./_components/queries-panel";
import { TeamPanel } from "./_components/team-panel";
import { HealthPanel } from "./_components/health-panel";

const STATUS_META: Record<string, { label: string; tone: StatePillTone }> = {
  active:     { label: "Activa",     tone: "success" },
  onboarding: { label: "Onboarding", tone: "info" },
  suspended:  { label: "Suspendida", tone: "destructive" },
};

export default function TenantDetailPage() {
  const { id: tenantId } = useParams() as { id: string };
  const qc = useQueryClient();

  const { data: m, isLoading, error } = useQuery({
    queryKey: ["tenant-metrics", tenantId],
    queryFn:  () => api.tenants.metrics(tenantId),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: health, isLoading: healthLoading } = useQuery({
    queryKey: ["tenant-health", tenantId],
    queryFn: () => api.tenants.tenantHealth(tenantId),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["tenant-metrics", tenantId] });
    qc.invalidateQueries({ queryKey: ["tenants"] });
  };

  if (isLoading) {
    return (
      <SuperShell title="Organización" back={{ href: "/superadmin/orgs", label: "Volver a Organizaciones" }}>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Skeleton className="h-48 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-56 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </div>
        </div>
      </SuperShell>
    );
  }

  if (error || !m) {
    return (
      <SuperShell title="Organización" back={{ href: "/superadmin/orgs", label: "Volver a Organizaciones" }}>
        <p className="py-20 text-center text-sm text-muted-foreground">No se pudo cargar la información de la organización.</p>
      </SuperShell>
    );
  }

  const t = m.tenant;
  const quotaQ = m.quota.queries_month;
  const quotaD = m.quota.documents;
  const statusMeta = STATUS_META[t.status] ?? { label: t.status, tone: "muted" as StatePillTone };

  // ── Qué mirar: los problemas de ESTE cliente, o una línea verde ────────────
  const issues: Array<{ tone: "warn" | "down"; text: string }> = [];
  if (health && health.errors.length > 0) issues.push({ tone: "down", text: `${health.errors.length} ${health.errors.length === 1 ? "error reciente" : "errores recientes"} en el backend` });
  if (m.docs.failed > 0) issues.push({ tone: "warn", text: `${m.docs.failed} ${m.docs.failed === 1 ? "documento que falló" : "documentos que fallaron"} en la ingesta` });
  if (quotaQ.limit !== -1 && quotaTone(quotaQ.pct) !== "ok" && quotaQ.pct != null) issues.push({ tone: quotaTone(quotaQ.pct) === "down" ? "down" : "warn", text: `Consultas al ${quotaQ.pct.toFixed(0)}% del límite del plan` });
  if (quotaD.limit !== -1 && quotaTone(quotaD.pct) !== "ok" && quotaD.pct != null) issues.push({ tone: quotaTone(quotaD.pct) === "down" ? "down" : "warn", text: `Documentos al ${quotaD.pct.toFixed(0)}% del límite del plan` });
  if (m.quality.skipped > 0) issues.push({ tone: "warn", text: `${m.quality.skipped} ${m.quality.skipped === 1 ? "documento descartado" : "documentos descartados"} por el quality gate` });
  if (health && !health.activity.last_query_at) issues.push({ tone: "warn", text: "Todavía sin consultas — cliente inactivo" });

  return (
    <SuperShell
      title={t.name}
      back={{ href: "/superadmin/orgs", label: "Volver a Organizaciones" }}
      badge={
        <span className="flex items-center gap-1.5">
          <StatePill tone="muted" className="capitalize">{t.plan}</StatePill>
          <StatePill tone={statusMeta.tone}>{statusMeta.label}</StatePill>
        </span>
      }
    >
      {/* ── Qué mirar ── */}
      <div className="mb-4">
        {healthLoading && issues.length === 0 ? (
          <Skeleton className="h-5 w-72" />
        ) : issues.length === 0 ? (
          <div className="flex items-center gap-2.5">
            <span className="h-2 w-2 shrink-0 rounded-full bg-success" />
            <p className="text-sm text-muted-foreground">Cliente sano — sin errores, cuotas con margen y la ingesta al día.</p>
          </div>
        ) : (
          <div className="divide-y divide-border/60 rounded-lg border">
            {issues.map((it, i) => (
              <div key={i} className="flex items-center gap-2.5 px-3.5 py-2.5">
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", it.tone === "down" ? "bg-destructive" : "bg-warning")} />
                <span className={cn("text-[13px]", it.tone === "down" ? "font-medium text-destructive" : "text-foreground")}>{it.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Principal (2/3) + lateral (1/3). En móvil: Ficha y Asistente
             primero (definen al cliente), después el uso. ── */}
      <div className="grid items-start gap-4 lg:grid-cols-3">

        <div className="order-2 min-w-0 space-y-4 lg:order-1 lg:col-span-2">
          <UsagePanel usage={m.usage} quotaQ={quotaQ} quotaD={quotaD} />
          <QueriesPanel queries={m.recent_queries} />
          <TeamPanel tenantId={tenantId} tenantName={t.name} />
          <HealthPanel m={m} health={health} loading={healthLoading} />
        </div>

        <div className="order-1 min-w-0 space-y-4 lg:order-2">
          <FichaPanel tenant={t} onChanged={invalidateAll} />
          <AssistantPanel tenantId={tenantId} />
        </div>

      </div>
    </SuperShell>
  );
}
