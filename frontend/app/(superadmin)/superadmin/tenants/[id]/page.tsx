"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter, useParams } from "next/navigation";
import {
  ArrowLeft, RefreshCw, Loader2, AlertTriangle, CheckCircle2,
  PauseCircle, PlayCircle, Settings2, UserPlus, Building2,
  TrendingUp, FileText, Zap, Clock, Database, Shield,
  MessageSquare, Target, Activity, ChevronRight, Bot, X, Users, Eye, EyeOff,
  AtSign, Star, Plus, Trash2,
} from "lucide-react";
import { api, apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return (n * 100).toFixed(1) + "%";
}

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
  return ms + "ms";
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)   return "ahora";
  if (m < 60)  return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}

const PLAN_COLORS: Record<string, string> = {
  starter:      "bg-muted text-muted-foreground",
  professional: "bg-info/10 text-info",
  enterprise:   "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  active:    "default",
  onboarding:"secondary",
  suspended: "destructive",
};

// ── Page ──────────────────────────────────────────────────────────────────────
export default function TenantDetailPage() {
  const { id: tenantId } = useParams() as { id: string };
  const router   = useRouter();
  const qc       = useQueryClient();

  const [showCreateAdmin, setShowCreateAdmin]   = useState(false);
  const [editPlan, setEditPlan]                 = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [editingUser, setEditingUser] = useState<{ id: string; email: string; name: string; role: string; is_active: boolean } | null>(null);

  const inv = () => {
    qc.invalidateQueries({ queryKey: ["tenant-metrics", tenantId] });
    qc.invalidateQueries({ queryKey: ["tenant-users", tenantId] });
  };
  const invBots = () => qc.invalidateQueries({ queryKey: ["tenant-bots", tenantId] });

  const { data: m, isLoading, error } = useQuery({
    queryKey: ["tenant-metrics", tenantId],
    queryFn:  () => api.tenants.metrics(tenantId),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: tenantUsers = [], isLoading: usersLoading } = useQuery({
    queryKey: ["tenant-users", tenantId],
    queryFn:  () => api.tenants.listUsers(tenantId),
    staleTime: 30_000,
  });

  const { data: sys } = useQuery({
    queryKey: ["platform-system"],
    queryFn:  api.tenants.platformSystem,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: botsData } = useQuery({
    queryKey: ["tenant-bots", tenantId],
    queryFn: () => api.tenantBots.list(tenantId),
    staleTime: 30_000,
  });
  const bots = botsData?.bots ?? [];
  const activeBot = bots.find(b => b.is_active) ?? null;

  const { data: allTemplates = [] } = useQuery({
    queryKey: ["prompt-templates"],
    queryFn: api.promptTemplates.list,
    staleTime: 60_000,
  });

  const activateBotM = useMutation({
    mutationFn: (templateId: string) => api.tenantBots.activate(tenantId, templateId),
    onSuccess: () => { invBots(); toast({ title: "Bot activado", variant: "success" }); },
    onError: () => toast({ title: "Error al activar bot", variant: "destructive" }),
  });
  const deactivateBotM = useMutation({
    mutationFn: () => api.tenantBots.deactivate(tenantId),
    onSuccess: () => { invBots(); toast({ title: "Bot desactivado" }); },
    onError: () => toast({ title: "Error al desactivar bot", variant: "destructive" }),
  });
  const assignAndActivateM = useMutation({
    mutationFn: async (templateId: string) => {
      await api.promptTemplates.assignToTenants(templateId, [tenantId]);
      await api.tenantBots.activate(tenantId, templateId);
    },
    onSuccess: () => { invBots(); toast({ title: "Bot asignado y activado", variant: "success" }); },
    onError: (e: any) => toast({ title: e?.response?.data?.detail ?? "Error al asignar", variant: "destructive" }),
  });

  const suspendM  = useMutation({ mutationFn: () => apiClient.post(`/tenants/${tenantId}/suspend`),  onSuccess: () => { inv(); qc.invalidateQueries({ queryKey: ["tenants"] }); toast({ title: "Tenant suspendido" }); }, onError: () => toast({ title: "Error", variant: "destructive" }) });
  const activateM = useMutation({ mutationFn: () => apiClient.post(`/tenants/${tenantId}/activate`), onSuccess: () => { inv(); qc.invalidateQueries({ queryKey: ["tenants"] }); toast({ title: "Tenant reactivado", variant: "success" }); }, onError: () => toast({ title: "Error", variant: "destructive" }) });
  const resetM    = useMutation({
    mutationFn: () => apiClient.post(`/tenants/${tenantId}/reset-onboarding`),
    onSuccess: () => { inv(); setShowResetConfirm(false); toast({ title: "Onboarding reseteado", description: "El tenant arrancará desde el asistente de configuración.", variant: "success" }); },
    onError: () => toast({ title: "Error al resetear", variant: "destructive" }),
  });
  const planM     = useMutation({
    mutationFn: (plan: string) => apiClient.patch(`/tenants/${tenantId}`, { plan }),
    onSuccess: () => { inv(); qc.invalidateQueries({ queryKey: ["tenants"] }); setEditPlan(false); toast({ title: "Plan actualizado", variant: "success" }); },
    onError: () => toast({ title: "Error", variant: "destructive" }),
  });

  if (isLoading) return <LoadingState />;
  if (error || !m) return (
    <div className="h-full flex flex-col overflow-hidden">
      <TopBar onBack={() => router.push("/superadmin")} onRefresh={inv} label="—" loading={false} />
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        No se pudo cargar la información del tenant.
      </div>
    </div>
  );

  const t   = m.tenant;
  const isActive = t.status === "active" || t.status === "onboarding";
  const quotaQ = m.quota.queries_month;
  const quotaD = m.quota.documents;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-muted/20">
      <TopBar onBack={() => router.push("/superadmin")} onRefresh={inv} label={t.name} loading={false} />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 space-y-8 pb-10">

          {/* ═══════════════════════════════════════════════════════════
              ZONA 1 · ESTADO Y ACCIONES
          ═══════════════════════════════════════════════════════════ */}
          <section className="space-y-4">
          <ZoneHeader label="Estado y acciones" />

          {/* ── Identity ─────────────────────────────────────────────── */}
          <div className="rounded-xl border bg-card shadow-sm px-5 py-4">
            <div className="flex items-start gap-4 flex-wrap">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <span className="text-lg font-bold text-primary uppercase">{t.name[0]}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-lg font-semibold">{t.name}</h2>
                  <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">{t.id}</code>
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">{t.admin_email}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Creado {t.created_at ? new Date(t.created_at).toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" }) : "—"}
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={cn("text-xs font-medium px-2.5 py-1 rounded-full", PLAN_COLORS[t.plan] || "bg-muted")}>
                  {t.plan}
                </span>
                <Badge variant={STATUS_VARIANT[t.status] ?? "secondary"} className="capitalize">
                  {t.status}
                </Badge>
              </div>
            </div>

            <Separator className="my-4" />

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              {editPlan ? (
                <div className="flex items-center gap-2">
                  <Select
                    defaultValue={t.plan}
                    onValueChange={v => planM.mutate(v)}
                    disabled={planM.isPending}
                  >
                    <SelectTrigger className="h-8 text-sm w-auto gap-2">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="starter">Starter</SelectItem>
                      <SelectItem value="professional">Professional</SelectItem>
                      <SelectItem value="enterprise">Enterprise</SelectItem>
                    </SelectContent>
                  </Select>
                  {planM.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setEditPlan(false)}>Cancelar</Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => setEditPlan(true)}>
                  <Settings2 className="h-3.5 w-3.5" />Cambiar plan
                </Button>
              )}

              {isActive ? (
                <Button
                  size="sm" variant="outline"
                  className="h-8 gap-1.5 text-xs text-warning border-warning/20 hover:bg-warning/10"
                  disabled={suspendM.isPending}
                  onClick={() => suspendM.mutate()}
                >
                  {suspendM.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PauseCircle className="h-3.5 w-3.5" />}
                  Suspender
                </Button>
              ) : (
                <Button
                  size="sm" variant="outline"
                  className="h-8 gap-1.5 text-xs text-success border-success/20 hover:bg-success/10"
                  disabled={activateM.isPending}
                  onClick={() => activateM.mutate()}
                >
                  {activateM.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
                  Activar
                </Button>
              )}

              <Button
                size="sm" variant="outline"
                className="h-8 gap-1.5 text-xs text-destructive border-destructive/20 hover:bg-destructive/10"
                onClick={() => setShowResetConfirm(true)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Resetear onboarding
              </Button>
            </div>
          </div>

          {/* ── Dominios de email (email-first login) ───────────────────── */}
          <EmailDomainsSection tenantId={tenantId} />

          {/* ── Usuarios ─────────────────────────────────────────────── */}
          <div className="flex items-center justify-between">
            <SectionTitle icon={Users} label="Usuarios" sublabel={`${tenantUsers.length} en total`} />
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => setShowCreateAdmin(true)}>
              <UserPlus className="h-3.5 w-3.5" />Nuevo usuario
            </Button>
          </div>
          {usersLoading ? (
            <div className="space-y-2">
              {[1,2,3].map(i => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
            </div>
          ) : tenantUsers.length === 0 ? (
            <EmptyState icon={Users} title="Sin usuarios registrados" className="rounded-xl border border-dashed" />
          ) : (
            <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead>Usuario</TableHead>
                    <TableHead className="hidden sm:table-cell">Email</TableHead>
                    <TableHead>Rol</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody className="divide-y">
                  {tenantUsers.map(u => (
                    <TableRow key={u.id}>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                            <span className="text-xs font-bold text-primary uppercase">{u.name?.[0] ?? u.email[0]}</span>
                          </div>
                          <span className="font-medium truncate max-w-[120px]">{u.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs hidden sm:table-cell">{u.email}</TableCell>
                      <TableCell>
                        <span className={cn(
                          "text-xs px-2 py-1 rounded-full font-medium",
                          u.role === "admin"    ? "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300" :
                          u.role === "operator" ? "bg-info/10 text-info" :
                          "bg-muted text-muted-foreground"
                        )}>
                          {u.role === "admin" ? "Admin" : u.role === "operator" ? "Operador" : u.role}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className={cn(
                          "text-xs px-2 py-1 rounded-full font-medium",
                          u.is_active ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"
                        )}>
                          {u.is_active ? "Activo" : "Inactivo"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => setEditingUser(u)}>
                          <Settings2 className="h-3.5 w-3.5" />Editar
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* ── Bot activo ───────────────────────────────────────────── */}
          <div className="space-y-2">
            <SectionTitle icon={Bot} label="Bot activo" sublabel="personalidad del asistente de este tenant" />
            <BotSelector
              allTemplates={allTemplates}
              bots={bots}
              activeBot={activeBot}
              activateBotM={activateBotM}
              deactivateBotM={deactivateBotM}
              assignAndActivateM={assignAndActivateM}
            />
          </div>

          </section>

          {/* ═══════════════════════════════════════════════════════════
              ZONA 2 · ACTIVIDAD
          ═══════════════════════════════════════════════════════════ */}
          <section className="space-y-4">
          <ZoneHeader label="Actividad" />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-4 items-start">

          {/* ── Usage KPIs ───────────────────────────────────────────── */}
          <div className="space-y-2 lg:col-span-2">
          <SectionTitle icon={TrendingUp} label="Uso" />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            <KPI label="Consultas hoy"   value={fmtNum(m.usage.queries_today)}  color="text-primary" />
            <KPI label="Consultas 7d"    value={fmtNum(m.usage.queries_7d)}     color="text-primary" />
            <KPI label="Consultas 30d"   value={fmtNum(m.usage.queries_30d)}    color="text-primary" />
            <KPI label="Ingestas 30d"    value={fmtNum(m.usage.ingests_30d)}    color="text-violet-600" />
            <KPI label="Tokens LLM 30d"  value={fmtNum(m.usage.llm_tokens_30d)} color="text-warning" sublabel="aprox." />
            <KPI label="Consultas log."  value={fmtNum(m.performance.total_logged)} color="text-muted-foreground" sublabel="30d" />
          </div>
          </div>

          {/* ── Performance ──────────────────────────────────────────── */}
          <div className="space-y-2 lg:col-span-2">
          <SectionTitle icon={Zap} label="Rendimiento" sublabel="últimos 30d, datos de consultas_log" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <KPI label="Latencia p50"    value={fmtMs(m.performance.latency_p50)}   color="text-success" />
            <KPI label="Latencia p95"    value={fmtMs(m.performance.latency_p95)}   color={latencyColor(m.performance.latency_p95)} />
            <KPI label="Cache hit rate"  value={fmtPct(m.performance.cache_hit_rate)} color="text-info" />
            <KPI label="Conf. promedio"  value={m.performance.avg_confidence != null ? (m.performance.avg_confidence * 100).toFixed(0) + "%" : "—"} color="text-violet-600" />
          </div>
          </div>

          {/* ── Top intents ──────────────────────────────────────────── */}
          {m.top_intents.length > 0 && (
            <div className="space-y-2">
              <SectionTitle icon={Target} label="Intenciones más frecuentes" sublabel="30d" />
              <div className="rounded-xl border bg-card shadow-sm divide-y overflow-hidden">
                {m.top_intents.map((intent, i) => {
                  const max = m.top_intents[0].count;
                  const pct = Math.round((intent.count / max) * 100);
                  return (
                    <div key={intent.label} className="flex items-center gap-3 px-4 py-2.5">
                      <span className="text-xs text-muted-foreground w-4 tabular-nums shrink-0">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{intent.label}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                            <div className="h-full bg-primary/60 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      </div>
                      <span className="text-xs tabular-nums text-muted-foreground shrink-0">{fmtNum(intent.count)} q</span>
                      {intent.avg_confidence != null && (
                        <span className="text-xs tabular-nums text-muted-foreground shrink-0 hidden sm:inline">
                          {(intent.avg_confidence * 100).toFixed(0)}% conf.
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Recent queries ───────────────────────────────────────── */}
          {m.recent_queries.length > 0 && (
            <div className="space-y-2">
              <SectionTitle icon={MessageSquare} label="Últimas consultas" sublabel="máx. 10" />
              <div className="rounded-xl border bg-card shadow-sm divide-y overflow-hidden">
                {m.recent_queries.map((q, i) => (
                  <div key={i} className="flex items-start gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground truncate">
                        {q.question_text ?? <span className="text-muted-foreground italic">sin texto</span>}
                      </p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {q.intent_label && (
                          <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded-full">
                            {q.intent_label}
                          </span>
                        )}
                        {q.from_cache && (
                          <span className="text-xs bg-info/10 text-info px-1.5 py-0.5 rounded-full">
                            cache
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">{fmtMs(q.latency_ms)}</span>
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0 mt-0.5">{relTime(q.created_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Empty state for no consultas_log data */}
          {m.performance.total_logged === 0 && (
            <div className="lg:col-span-2">
              <EmptyState
                icon={Activity}
                title="Sin consultas registradas"
                description="Este tenant aún no tiene consultas en los últimos 30 días."
                className="rounded-xl border border-dashed bg-card"
              />
            </div>
          )}

          </div>{/* /grid Actividad */}
          </section>

          {/* ═══════════════════════════════════════════════════════════
              ZONA 3 · RECURSOS
          ═══════════════════════════════════════════════════════════ */}
          <section className="space-y-4">
          <ZoneHeader label="Recursos" />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-4 items-start">

          {/* ── Documents + Storage ──────────────────────────────────── */}
          <div className="space-y-2">
          <SectionTitle icon={FileText} label="Documentos" />
          <div className="rounded-xl border bg-card shadow-sm divide-y">
            <div className="grid grid-cols-2 sm:grid-cols-4 divide-x">
              <DocStat label="Total"      value={m.docs.total}                color="" />
              <DocStat label="Listos"     value={m.docs.ready}               color="text-success" />
              <DocStat label="Fallidos"   value={m.docs.failed}              color={m.docs.failed > 0 ? "text-destructive" : ""} />
              <DocStat label="Procesando" value={m.docs.processing}          color="text-warning" />
            </div>
            <div className="px-4 py-3 flex items-center gap-2 text-sm text-muted-foreground">
              <Database className="h-3.5 w-3.5 shrink-0" />
              <span>Almacenamiento: <span className="font-medium text-foreground">{fmtBytes(m.docs.storage_bytes)}</span></span>
            </div>
          </div>
          </div>

          {/* ── Quality gate ─────────────────────────────────────────── */}
          <div className="space-y-2">
          <SectionTitle icon={CheckCircle2} label="Quality gate" sublabel="últimos 30d" />
          <div className="grid grid-cols-3 gap-2.5">
            <KPI label="Aprobadas"  value={fmtNum(m.quality.passed)}  color="text-success" />
            <KPI label="Pendientes" value={fmtNum(m.quality.pending)} color="text-warning" />
            <KPI label="Saltadas"   value={fmtNum(m.quality.skipped)} color={m.quality.skipped > 0 ? "text-destructive" : "text-muted-foreground"} />
          </div>
          </div>

          {/* ── Quotas ───────────────────────────────────────────────── */}
          <div className="space-y-2 lg:col-span-2">
          <SectionTitle icon={Shield} label="Cuotas del plan" sublabel={t.plan} />
          <div className="grid sm:grid-cols-2 gap-3">
            <QuotaBar
              label="Consultas / mes"
              used={quotaQ.used}
              limit={quotaQ.limit}
              pct={quotaQ.pct}
            />
            <QuotaBar
              label="Documentos"
              used={quotaD.used}
              limit={quotaD.limit}
              pct={quotaD.pct}
            />
          </div>
          </div>

          {/* ── Groq API (platform-wide, from Prometheus) ────────────── */}
          {sys && (
            <div className="space-y-2 lg:col-span-2">
              <SectionTitle icon={Bot} label="Groq API" sublabel="plataforma completa · desde inicio del proceso" />
              {sys.groq.total_calls === 0 ? (
                <div className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
                  Sin llamadas a Groq registradas aún. Los contadores se resetean al reiniciar el backend.
                </div>
              ) : (
                <div className="space-y-2">
                  {sys.groq.by_model.map((gm: any) => (
                    <div key={gm.model} className="rounded-lg border bg-card px-4 py-3">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <code className="text-xs font-mono">{gm.model}</code>
                        <div className="flex gap-2 text-xs text-muted-foreground">
                          <span className="tabular-nums">{fmtNum(gm.total)} llamadas</span>
                          {gm.errors > 0 && <span className="text-destructive font-medium">{gm.errors} errores</span>}
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {Object.entries(gm.calls as Record<string, number>).map(([status, count]) => (
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
            </div>
          )}

          </div>{/* /grid Recursos */}
          </section>

        </div>
      </div>

      {showCreateAdmin && (
        <CreateAdminModal
          tenantId={tenantId}
          tenantName={t.name}
          onClose={() => setShowCreateAdmin(false)}
          onCreated={inv}
        />
      )}

      {editingUser && (
        <EditUserModal
          tenantId={tenantId}
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onSaved={() => { setEditingUser(null); qc.invalidateQueries({ queryKey: ["tenant-users", tenantId] }); }}
        />
      )}

      {showResetConfirm && (
        <Dialog open onOpenChange={v => !v && setShowResetConfirm(false)}>
          <DialogContent className="w-full max-w-sm mx-4 sm:mx-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-4 w-4" />
                Resetear onboarding
              </DialogTitle>
              <p className="text-sm text-muted-foreground pt-1">
                Esto va a borrar la configuración del bot y los sectores de{" "}
                <span className="font-medium text-foreground">{t.name}</span>.
                El tenant tendrá que volver a completar el asistente de configuración.
              </p>
            </DialogHeader>
            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button variant="outline" className="w-full sm:w-auto" onClick={() => setShowResetConfirm(false)}>
                Cancelar
              </Button>
              <Button
                variant="destructive" className="w-full sm:w-auto"
                disabled={resetM.isPending}
                onClick={() => resetM.mutate()}
              >
                {resetM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Sí, resetear
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TopBar({ onBack, onRefresh, label, loading }: { onBack: () => void; onRefresh: () => void; label: string; loading: boolean }) {
  return (
    <div className="shrink-0 bg-background border-b px-4 sm:px-6 pt-4 sm:pt-6 pb-4">
      <div className="max-w-7xl mx-auto">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Plataforma
        </button>
        <PageHeader
          title={label}
          description="Detalle, uso y recursos de la organización"
          actions={
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={onRefresh} title="Actualizar">
              <RefreshCw className="h-4 w-4" />
            </Button>
          }
        />
      </div>
    </div>
  );
}

function ZoneHeader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="text-base font-bold tracking-tight text-foreground shrink-0">{label}</h2>
      <Separator className="flex-1" />
    </div>
  );
}

function SectionTitle({ icon: Icon, label, sublabel }: { icon: any; label: string; sublabel?: string }) {
  return (
    <div className="flex items-center gap-2 pt-2">
      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      <span className="text-sm font-semibold">{label}</span>
      {sublabel && <span className="text-xs text-muted-foreground">{sublabel}</span>}
    </div>
  );
}

function KPI({ label, value, color, sublabel }: { label: string; value: string; color: string; sublabel?: string }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <p className={cn("text-xl font-bold tabular-nums leading-none", color)}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1.5 leading-tight">{label}</p>
      {sublabel && <p className="text-[11px] text-muted-foreground/70">{sublabel}</p>}
    </div>
  );
}

function DocStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="px-4 py-3 text-center">
      <p className={cn("text-xl font-bold tabular-nums leading-none", color || "text-foreground")}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{label}</p>
    </div>
  );
}

function QuotaBar({ label, used, limit, pct }: { label: string; used: number; limit: number; pct: number | null }) {
  const unlimited = limit === -1;
  const danger = !unlimited && (pct ?? 0) >= 90;
  const warn   = !unlimited && (pct ?? 0) >= 70;

  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {unlimited
          ? <span className="text-xs text-violet-600 font-medium">Ilimitado</span>
          : <span className={cn("text-xs font-medium", danger ? "text-destructive" : warn ? "text-warning" : "text-muted-foreground")}>
              {pct != null ? pct.toFixed(1) + "%" : "—"}
            </span>
        }
      </div>
      {!unlimited && (
        <div className="h-1.5 bg-muted rounded-full overflow-hidden mb-2">
          <div
            className={cn("h-full rounded-full transition-all", danger ? "bg-destructive" : warn ? "bg-warning" : "bg-primary")}
            style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
          />
        </div>
      )}
      <p className="text-sm font-bold tabular-nums">
        {fmtNum(used)}
        {!unlimited && <span className="text-xs font-normal text-muted-foreground"> / {fmtNum(limit)}</span>}
      </p>
    </div>
  );
}

function latencyColor(ms: number | null | undefined): string {
  if (ms == null) return "text-muted-foreground";
  if (ms > 5000)  return "text-destructive";
  if (ms > 3000)  return "text-warning";
  return "text-success";
}

function LoadingState() {
  return (
    <div className="h-full flex flex-col overflow-hidden bg-muted/20">
      <div className="shrink-0 bg-background border-b px-4 sm:px-6 py-3 h-14" />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 space-y-4">
          <Skeleton className="h-32 w-full rounded-xl" />
          <div className="grid grid-cols-3 gap-2.5">
            {[1,2,3,4,5,6].map(i => <Skeleton key={i} className="h-16 rounded-lg" />)}
          </div>
          <div className="grid grid-cols-4 gap-2.5">
            {[1,2,3,4].map(i => <Skeleton key={i} className="h-16 rounded-lg" />)}
          </div>
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}

// ── BotSelector ───────────────────────────────────────────────────────────────
function BotSelector({ allTemplates, bots, activeBot, activateBotM, deactivateBotM, assignAndActivateM }: {
  allTemplates: any[];
  bots: any[];
  activeBot: any | null;
  activateBotM: any;
  deactivateBotM: any;
  assignAndActivateM: any;
}) {
  const assignedIds = new Set(bots.map((b: any) => b.id));
  const activeTemplates = allTemplates.filter((t: any) => t.is_active);

  if (activeTemplates.length === 0) {
    return (
      <EmptyState
        icon={Bot}
        title="No hay bots creados en la plataforma aún"
        className="rounded-xl border bg-card shadow-sm"
      />
    );
  }

  // Order: active first, then assigned+inactive, then unassigned
  const sorted = [
    ...activeTemplates.filter((t: any) => {
      const a = bots.find((b: any) => b.id === t.id);
      return a?.is_active;
    }),
    ...activeTemplates.filter((t: any) => {
      const a = bots.find((b: any) => b.id === t.id);
      return a && !a.is_active;
    }),
    ...activeTemplates.filter((t: any) => !assignedIds.has(t.id)),
  ];

  return (
    <div className="rounded-xl border bg-card shadow-sm px-5 py-4 space-y-3">
      {/* Status strip */}
      <div className={cn(
        "flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm",
        activeBot ? "bg-success/10 border-success/20" : "bg-muted border-border"
      )}>
        <div className="flex items-center gap-2">
          {activeBot ? (
            <>
              <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
              <span className="font-medium text-success">
                {activeBot.nombre} activo
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Modo estándar — hacé clic en un bot para activarlo</span>
          )}
        </div>
        {activeBot && (
          <button
            onClick={() => deactivateBotM.mutate()}
            disabled={deactivateBotM.isPending}
            className="text-xs text-muted-foreground hover:text-destructive transition-colors shrink-0 flex items-center gap-1"
          >
            {deactivateBotM.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
            Desactivar
          </button>
        )}
      </div>

      {/* Bot grid */}
      <div className="grid gap-2 sm:grid-cols-2">
        {sorted.map((t: any) => {
          const assigned = bots.find((b: any) => b.id === t.id);
          const isActive = assigned?.is_active ?? false;
          const isAssigned = !!assigned;
          const isBusy = (activateBotM.isPending && activateBotM.variables === t.id)
            || (assignAndActivateM.isPending && assignAndActivateM.variables === t.id);

          return (
            <div
              key={t.id}
              className={cn(
                "flex items-center gap-3 rounded-lg border px-3 py-3 transition-all",
                isActive
                  ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                  : "border-border"
              )}
            >
              <Bot className={cn("h-5 w-5 shrink-0", isActive ? "text-primary" : "text-muted-foreground")} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{t.nombre}</p>
                {t.descripcion && (
                  <p className="text-xs text-muted-foreground truncate">{t.descripcion}</p>
                )}
                {!isAssigned && (
                  <p className="text-[11px] text-muted-foreground/60 mt-0.5">No asignado</p>
                )}
              </div>
              <div className="shrink-0">
                {isActive ? (
                  <span className="text-xs font-semibold text-primary">Activo</span>
                ) : isBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : isAssigned ? (
                  <Button
                    size="sm" variant="outline" className="h-7 text-xs"
                    onClick={() => activateBotM.mutate(t.id)}
                    disabled={activateBotM.isPending || assignAndActivateM.isPending}
                  >
                    Activar
                  </Button>
                ) : (
                  <Button
                    size="sm" className="h-7 text-xs"
                    onClick={() => assignAndActivateM.mutate(t.id)}
                    disabled={activateBotM.isPending || assignAndActivateM.isPending}
                  >
                    Asignar
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Modal editar usuario ──────────────────────────────────────────────────────
function EditUserModal({ tenantId, user, onClose, onSaved }: {
  tenantId: string;
  user: { id: string; email: string; name: string; role: string; is_active: boolean };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName]         = useState(user.name);
  const [role, setRole]         = useState(user.role);
  const [isActive, setIsActive] = useState(user.is_active);
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd]   = useState(false);
  const [error, setError]       = useState("");

  const saveM = useMutation({
    mutationFn: () => api.tenants.updateUser(tenantId, user.id, {
      name: name.trim(),
      role,
      is_active: isActive,
      ...(password ? { password } : {}),
    }),
    onSuccess: () => { toast({ title: "Usuario actualizado", variant: "success" }); onSaved(); },
    onError: (e: any) => {
      const detail = e?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Error al guardar. Verificá los datos.");
    },
  });

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-sm p-6 w-[calc(100%-2rem)]">
        <DialogHeader className="mb-2">
          <DialogTitle>Editar usuario</DialogTitle>
          <p className="text-xs text-muted-foreground">{user.email}</p>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="eu-name" className="text-xs font-medium">Nombre</Label>
            <Input id="eu-name" value={name} onChange={e => setName(e.target.value)} placeholder="Nombre completo" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="eu-role" className="text-xs font-medium">Rol</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="eu-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="operator">Operador</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between rounded-lg border px-4 py-3 bg-muted/30">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Activo</p>
              <p className="text-xs text-muted-foreground">{isActive ? "Puede iniciar sesión" : "Acceso bloqueado"}</p>
            </div>
            <button
              type="button"
              onClick={() => setIsActive(v => !v)}
              className={cn(
                "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
                isActive ? "bg-success" : "bg-muted-foreground/30"
              )}
            >
              <span className={cn(
                "inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                isActive ? "translate-x-6" : "translate-x-1"
              )} />
            </button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="eu-pwd" className="text-xs font-medium">
              Nueva contraseña <span className="text-muted-foreground font-normal">(opcional)</span>
            </Label>
            <div className="relative">
              <Input
                id="eu-pwd"
                type={showPwd ? "text" : "password"}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Mínimo 8 caracteres"
                className="pr-9"
              />
              <button
                type="button"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPwd(v => !v)}
                tabIndex={-1}
              >
                {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => saveM.mutate()} disabled={saveM.isPending || !name.trim()}>
            {saveM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


// ── Modal crear admin ─────────────────────────────────────────────────────────
function CreateAdminModal({ tenantId, tenantName, onClose, onCreated }: {
  tenantId: string; tenantName: string; onClose: () => void; onCreated: () => void;
}) {
  const [form, setForm] = useState({ email: "", name: "", password: "" });
  const [error, setError] = useState("");
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const createM = useMutation({
    mutationFn: () => api.tenants.createAdmin(tenantId, form),
    onSuccess: () => {
      onCreated(); onClose();
      toast({ title: "Admin creado", description: `${form.email} puede iniciar sesión en '${tenantId}'.`, variant: "success" });
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail ?? "Error al crear admin.";
      setError(typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="w-full max-w-sm mx-4 sm:mx-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-primary" />
            Nuevo admin
          </DialogTitle>
          <p className="text-sm text-muted-foreground pt-1">
            Para <span className="font-medium text-foreground">{tenantName}</span>
          </p>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {([
            { key: "email",    label: "Email",      placeholder: "admin@empresa.com", type: "email" },
            { key: "name",     label: "Nombre",     placeholder: "Nombre Apellido",   type: "text" },
            { key: "password", label: "Contraseña", placeholder: "Mínimo 8 chars",   type: "password" },
          ] as const).map(f => (
            <div key={f.key} className="space-y-1">
              <Label className="text-xs font-medium">{f.label}</Label>
              <Input type={f.type} placeholder={f.placeholder} value={(form as any)[f.key]} onChange={set(f.key)} className="h-9" />
            </div>
          ))}
          {error && (
            <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2">
              <p className="text-xs text-destructive">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button variant="outline" className="w-full sm:w-auto" onClick={onClose}>Cancelar</Button>
          <Button
            className="w-full sm:w-auto"
            disabled={createM.isPending || !form.email || !form.password}
            onClick={() => { setError(""); createM.mutate(); }}
          >
            {createM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Crear admin
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── EmailDomainsSection ─────────────────────────────────────────────────────
//
// Dominios de email asociados al tenant. Cuando un usuario ingresa
// pedro@<dominio cargado aqui>, el sistema autocompleta la organizacion y
// le muestra el branding sin pedir mas datos (email-first login).
//
// Sin dominios cargados, el login sigue funcionando — solo cae al fallback
// de "pedinos tu organizacion".
function EmailDomainsSection({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [newDomain, setNewDomain] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const { data: domains = [], isLoading } = useQuery({
    queryKey: ["tenant-email-domains", tenantId],
    queryFn:  () => api.tenants.listEmailDomains(tenantId),
    staleTime: 30_000,
  });

  const addM = useMutation({
    mutationFn: () => api.tenants.addEmailDomain(tenantId, newDomain.trim(), isPrimary),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tenant-email-domains", tenantId] });
      setNewDomain("");
      setIsPrimary(false);
      setError(null);
      toast({ title: "Dominio agregado", variant: "success" });
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail ?? "No se pudo agregar el dominio";
      setError(typeof detail === "string" ? detail : "Error desconocido");
    },
  });

  const removeM = useMutation({
    mutationFn: (domain: string) => api.tenants.removeEmailDomain(tenantId, domain),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tenant-email-domains", tenantId] });
      toast({ title: "Dominio eliminado" });
    },
    onError: () => toast({ title: "Error al eliminar", variant: "destructive" }),
  });

  const handleAdd = () => {
    setError(null);
    if (!newDomain.trim()) return;
    addM.mutate();
  };

  return (
    <div className="space-y-2">
      <SectionTitle
        icon={AtSign}
        label="Dominios de email"
        sublabel={domains.length === 0 ? "Opcional · email-first login" : `${domains.length} configurado${domains.length === 1 ? "" : "s"}`}
      />

      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        {/* Lista */}
        {isLoading ? (
          <div className="p-4"><Skeleton className="h-8 w-full" /></div>
        ) : domains.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            Sin dominios cargados. Los usuarios van a tener que tipear el nombre del tenant al loguearse.
          </p>
        ) : (
          <ul className="divide-y">
            {domains.map(d => (
              <li key={d.domain} className="flex items-center gap-3 px-4 py-2.5">
                <AtSign className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="font-mono text-sm flex-1 truncate">{d.domain}</span>
                {d.is_primary && (
                  <span className="inline-flex items-center gap-1 text-[11px] rounded-full bg-warning/10 text-warning border border-warning/20 px-2 py-0.5">
                    <Star className="h-3 w-3" />Principal
                  </span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeM.mutate(d.domain)}
                  disabled={removeM.isPending}
                  aria-label={`Eliminar dominio ${d.domain}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {/* Add form */}
        <div className="border-t bg-muted/30 px-4 py-3 space-y-2">
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              value={newDomain}
              onChange={e => setNewDomain(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleAdd(); }}
              placeholder="empresa.com.ar"
              className="h-9 text-sm"
              disabled={addM.isPending}
            />
            <Button
              onClick={handleAdd}
              disabled={addM.isPending || !newDomain.trim()}
              className="h-9 shrink-0"
              size="sm"
            >
              {addM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
              Agregar
            </Button>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={e => setIsPrimary(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Marcar como principal (un solo dominio por tenant)
          </label>
          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
          <p className="text-[11px] text-muted-foreground">
            Solo dominios corporativos. No se aceptan @gmail.com, @hotmail.com, etc.
          </p>
        </div>
      </div>
    </div>
  );
}
