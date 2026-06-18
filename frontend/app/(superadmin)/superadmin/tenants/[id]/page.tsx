"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter, useParams } from "next/navigation";
import {
  ArrowLeft, RefreshCw, Loader2, AlertTriangle, CheckCircle2, XCircle,
  PauseCircle, PlayCircle, Settings2, UserPlus, Building2,
  TrendingUp, FileText, Zap, Clock, Database, Shield,
  MessageSquare, Target, Activity, ChevronRight, ChevronDown, Bot, X, Users, Eye, EyeOff,
  AtSign, Star, Plus, Trash2, HeartPulse, Bug, HardDrive, MoreVertical,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { FormSheet } from "@/components/layout/form-sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { Kpi, ErrorRow } from "@/components/superadmin/shared";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import Link from "next/link";

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
  enterprise:   "bg-action-gradient-soft text-action",
};

// Mismo lenguaje que la lista de Organizaciones: estado en español, pill suave.
const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  active:     { label: "Activa",     cls: "bg-success/10 text-success" },
  onboarding: { label: "Onboarding", cls: "bg-info/10 text-info" },
  suspended:  { label: "Suspendida", cls: "bg-destructive/10 text-destructive" },
};

// Sección "Dominios de email" oculta por ahora: el login funciona sin dominios
// (resuelve el tenant por email, escaneando los tenants). Los dominios son una
// optimización para cuando haya muchos clientes — el backend sigue intacto.
// Poner en true para volver a mostrarla en el detalle.
const SHOW_EMAIL_DOMAINS = false;

// ── Page ──────────────────────────────────────────────────────────────────────
export default function TenantDetailPage() {
  const { id: tenantId } = useParams() as { id: string };
  const router   = useRouter();
  const qc       = useQueryClient();

  const [showCreateAdmin, setShowCreateAdmin]   = useState(false);
  const [editPlan, setEditPlan]                 = useState(false);
  const [detailTab, setDetailTab]               = useState<"general" | "actividad" | "salud">("salud");
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showSuspendConfirm, setShowSuspendConfirm] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState("");
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

  const { data: healthData, isLoading: healthLoading } = useQuery({
    queryKey: ["tenant-health", tenantId],
    queryFn: () => api.tenants.tenantHealth(tenantId),
    enabled: detailTab === "salud",
    refetchInterval: detailTab === "salud" ? 30_000 : false,
    staleTime: 15_000,
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

  const suspendM  = useMutation({ mutationFn: () => apiClient.post(`/tenants/${tenantId}/suspend`),  onSuccess: () => { inv(); qc.invalidateQueries({ queryKey: ["tenants"] }); setShowSuspendConfirm(false); toast({ title: "Organización suspendida" }); }, onError: () => toast({ title: "Error", variant: "destructive" }) });
  const activateM = useMutation({ mutationFn: () => apiClient.post(`/tenants/${tenantId}/activate`), onSuccess: () => { inv(); qc.invalidateQueries({ queryKey: ["tenants"] }); toast({ title: "Tenant reactivado", variant: "success" }); }, onError: () => toast({ title: "Error", variant: "destructive" }) });
  const resetM    = useMutation({
    mutationFn: () => apiClient.post(`/tenants/${tenantId}/reset-onboarding`),
    onSuccess: () => { inv(); setShowResetConfirm(false); setResetConfirmText(""); toast({ title: "Onboarding reseteado", description: "El tenant arrancará desde el asistente de configuración.", variant: "success" }); },
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
      <TopBar onBack={() => router.push("/superadmin/orgs")} />
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
      <TopBar onBack={() => router.push("/superadmin/orgs")} />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-4 space-y-4 pb-10">

          {/* ── Identity — siempre visible, arriba de las tabs ─────────── */}
          <div className="rounded-2xl border bg-card shadow px-5 py-4">
            <div className="flex items-start gap-4 flex-wrap">
              <div className="w-12 h-12 rounded-xl bg-action-gradient-soft flex items-center justify-center shrink-0">
                <span className="text-lg font-bold text-action uppercase">{t.name[0]}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-xl font-semibold tracking-tight">{t.name}</h2>
                  <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">{t.id}</code>
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">{t.admin_email}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Creado {t.created_at ? new Date(t.created_at).toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" }) : "—"}
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={cn("text-xs font-medium px-2.5 py-1 rounded-full capitalize", PLAN_COLORS[t.plan] || "bg-muted")}>
                  {t.plan}
                </span>
                <span className={cn(
                  "text-xs font-medium px-2.5 py-1 rounded-full",
                  (STATUS_PILL[t.status] ?? { cls: "bg-muted text-muted-foreground" }).cls
                )}>
                  {(STATUS_PILL[t.status] ?? { label: t.status }).label}
                </span>
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
                  onClick={() => setShowSuspendConfirm(true)}
                >
                  <PauseCircle className="h-3.5 w-3.5" />
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

              {/* Acciones peligrosas escondidas detrás de un menú: resetear es
                  destructivo e irreversible, no debe estar a un click accidental. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost" className="h-8 w-8 p-0 ml-auto text-muted-foreground" title="Más acciones">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => setShowResetConfirm(true)}
                    className="text-destructive focus:text-destructive"
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Resetear onboarding
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* ── Tabs — organizan el detalle en 3 vistas en vez de un scroll
                 único con todo mezclado ──────────────────────────────────── */}
          <Tabs value={detailTab} onValueChange={v => setDetailTab(v as typeof detailTab)}>
            <TabsList>
              <TabsTrigger value="salud" className="gap-1.5">
                <HeartPulse className="h-3.5 w-3.5" /> Salud
              </TabsTrigger>
              <TabsTrigger value="actividad" className="gap-1.5">
                <Activity className="h-3.5 w-3.5" /> Actividad
              </TabsTrigger>
              <TabsTrigger value="general" className="gap-1.5">
                <Users className="h-3.5 w-3.5" /> Equipo y bot
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {detailTab === "general" && (
          <section className="space-y-4 animate-fade-in">
          {/* Dominios de email — oculto por ahora (ver SHOW_EMAIL_DOMAINS). */}
          {SHOW_EMAIL_DOMAINS && <EmailDomainsSection tenantId={tenantId} />}

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
                          u.role === "admin"    ? "bg-action-gradient-soft text-action" :
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
          )}

          {detailTab === "actividad" && (
          <section className="space-y-5 animate-fade-in">

          {m.performance.total_logged === 0 && m.usage.queries_30d === 0 ? (
            <EmptyState
              icon={Activity}
              title="Sin actividad todavía"
              description="Este cliente aún no registró consultas ni ingestas en los últimos 30 días."
              className="rounded-2xl border border-dashed bg-card"
            />
          ) : (
          <>
          {/* ── Resumen — lo que un superadmin mira primero ───────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi
              icon={MessageSquare}
              label="Consultas 30d"
              value={fmtNum(m.usage.queries_30d)}
              accentBrand
              sublabel={`${fmtNum(m.usage.queries_7d)} en los últimos 7 días`}
            />
            <Kpi
              icon={FileText}
              label="Ingestas 30d"
              value={fmtNum(m.usage.ingests_30d)}
              sublabel="documentos procesados"
            />
            <Kpi
              icon={Zap}
              label="Tokens LLM 30d"
              value={fmtNum(m.usage.llm_tokens_30d)}
              sublabel="consumo de IA · costo aprox."
            />
            <Kpi
              icon={Target}
              label="Confianza prom."
              value={m.performance.avg_confidence != null ? (m.performance.avg_confidence * 100).toFixed(0) + "%" : "—"}
              tone={m.performance.avg_confidence == null ? "neutral" : m.performance.avg_confidence >= 0.8 ? "success" : m.performance.avg_confidence >= 0.6 ? "warn" : "danger"}
              sublabel="calidad de las respuestas"
            />
          </div>

          {/* ── Volumen + Rendimiento ─────────────────────────────────── */}
          <div className="grid gap-4 lg:grid-cols-2 items-start">

            {/* Volumen — número protagonista + barras comparativas */}
            <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
              <PanelHeader icon={TrendingUp} label="Volumen de consultas" sublabel="ritmo de uso" />
              <div className="p-4">
                <div className="flex items-end justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-4xl font-bold tabular-nums leading-none">{fmtNum(m.usage.queries_30d)}</p>
                    <p className="mt-1.5 text-xs text-muted-foreground">consultas en 30 días</p>
                  </div>
                  <div className="shrink-0 rounded-xl bg-action-gradient-soft px-3 py-2 text-right">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-action/80">Promedio</p>
                    <p className="text-base font-semibold tabular-nums text-action leading-none mt-0.5">
                      ≈ {fmtNum(Math.round(m.usage.queries_30d / 30))}<span className="text-[11px] font-normal">/día</span>
                    </p>
                  </div>
                </div>
                <div className="mt-4 space-y-2.5">
                  <VolBar label="Hoy"     value={m.usage.queries_today} max={m.usage.queries_30d} />
                  <VolBar label="7 días"  value={m.usage.queries_7d}    max={m.usage.queries_30d} />
                  <VolBar label="30 días" value={m.usage.queries_30d}   max={m.usage.queries_30d} />
                </div>
              </div>
            </div>

            {/* Rendimiento — anillo de cache + gauges de latencia */}
            <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
              <PanelHeader icon={Zap} label="Rendimiento del servicio" sublabel="últimos 30d" />
              <div className="flex items-center gap-5 p-4">
                <Donut value={m.performance.cache_hit_rate} label="Cache hit" />
                <div className="h-14 w-px bg-border shrink-0" />
                <div className="flex flex-1 flex-col gap-3.5 min-w-0">
                  <LatencyGauge label="Latencia p50" ms={m.performance.latency_p50} />
                  <LatencyGauge label="Latencia p95" ms={m.performance.latency_p95} />
                </div>
              </div>
            </div>

          </div>

          {/* ── Qué consultan + Últimas consultas (desplegables) ──────── */}
          <div className="space-y-3">

            <CollapsiblePanel icon={Target} label="Qué consultan" sublabel="intenciones más frecuentes · 30d" count={m.top_intents.length}>
              <div className="divide-y">
                {m.top_intents.map((intent, i) => {
                  const max = m.top_intents[0].count;
                  const pct = Math.round((intent.count / max) * 100);
                  return (
                    <div key={intent.label} className="flex items-center gap-3 px-4 py-3">
                      <span className="text-xs text-muted-foreground/50 w-4 tabular-nums shrink-0 font-semibold">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{intent.label}</p>
                        <div className="mt-1.5 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className="h-full bg-action-gradient rounded-full" style={{ width: `${Math.max(pct, 4)}%` }} />
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-semibold tabular-nums leading-none">{fmtNum(intent.count)}</p>
                        {intent.avg_confidence != null && (
                          <p className="text-[10px] tabular-nums text-muted-foreground mt-1">{(intent.avg_confidence * 100).toFixed(0)}% conf.</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CollapsiblePanel>

            <CollapsiblePanel icon={MessageSquare} label="Últimas consultas" sublabel="las más recientes" count={m.recent_queries.length}>
              <div className="divide-y">
                {m.recent_queries.map((q, i) => (
                  <div key={i} className="flex items-start gap-3 px-4 py-3">
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted/60">
                      <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className={cn("text-sm truncate", q.question_text ? "text-foreground" : "italic text-muted-foreground/70")}>
                        {q.question_text ?? "Consulta sin texto guardado"}
                      </p>
                      <div className="mt-1 flex items-center gap-x-2 gap-y-1 flex-wrap text-[10px] text-muted-foreground">
                        {q.intent_label && (
                          <span className="font-medium bg-action-gradient-soft text-action px-1.5 py-0.5 rounded-full">{q.intent_label}</span>
                        )}
                        {q.from_cache && (
                          <span className="font-medium bg-info/10 text-info px-1.5 py-0.5 rounded-full">cache</span>
                        )}
                        <span className="tabular-nums">{fmtMs(q.latency_ms)}</span>
                        <span className="text-muted-foreground/40">·</span>
                        <span className="tabular-nums">{relTime(q.created_at)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CollapsiblePanel>

          </div>
          </>
          )}

          </section>
          )}

          {detailTab === "salud" && (
          <section className="space-y-4 animate-fade-in">

          {healthLoading || !healthData ? (
            <div className="space-y-2">
              {[1,2,3].map(i => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
            </div>
          ) : (() => {
            // Veredicto preventivo: qué hay que vigilar en este cliente.
            const issues: Array<{ tone: "warn" | "down"; text: string }> = [];
            if (healthData.errors.length > 0) issues.push({ tone: "down", text: `${healthData.errors.length} ${healthData.errors.length === 1 ? "error reciente" : "errores recientes"} en el backend` });
            if (m.docs.failed > 0) issues.push({ tone: "warn", text: `${m.docs.failed} ${m.docs.failed === 1 ? "documento que falló" : "documentos que fallaron"} en la ingesta` });
            if (quotaQ.pct != null && quotaQ.pct >= 90) issues.push({ tone: "down", text: `Consultas al ${quotaQ.pct.toFixed(0)}% del límite del plan` });
            else if (quotaQ.pct != null && quotaQ.pct >= 70) issues.push({ tone: "warn", text: `Consultas al ${quotaQ.pct.toFixed(0)}% del límite del plan` });
            if (quotaD.pct != null && quotaD.pct >= 90) issues.push({ tone: "down", text: `Documentos al ${quotaD.pct.toFixed(0)}% del límite del plan` });
            else if (quotaD.pct != null && quotaD.pct >= 70) issues.push({ tone: "warn", text: `Documentos al ${quotaD.pct.toFixed(0)}% del límite del plan` });
            if (m.quality.skipped > 0) issues.push({ tone: "warn", text: `${m.quality.skipped} ${m.quality.skipped === 1 ? "documento descartado" : "documentos descartados"} por el quality gate` });
            if (!healthData.activity.last_query_at) issues.push({ tone: "warn", text: "Todavía sin consultas — cliente inactivo" });

            const down = issues.some(i => i.tone === "down");
            const vtone: "ok" | "warn" | "down" = down ? "down" : issues.length ? "warn" : "ok";
            const VIcon = vtone === "ok" ? CheckCircle2 : vtone === "down" ? XCircle : AlertTriangle;
            const vCls = vtone === "ok"
              ? "border-success/25 from-success/[0.10] text-success"
              : vtone === "down"
              ? "border-destructive/30 from-destructive/[0.12] text-destructive"
              : "border-warning/30 from-warning/[0.12] text-warning";
            const vLabel = vtone === "ok" ? "Cliente sano" : vtone === "down" ? "Requiere acción" : "Para revisar";
            const vSummary = vtone === "ok"
              ? "Sin errores, cuotas con margen y la ingesta al día."
              : `${issues.length} ${issues.length === 1 ? "cosa para prevenir" : "cosas para prevenir"} en este cliente.`;

            return (
          <>
          {/* ── Veredicto preventivo del tenant ───────────────────────── */}
          <div className={cn("rounded-2xl border bg-gradient-to-br to-transparent p-5", vCls)}>
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-background/60">
                <VIcon className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <p className="text-lg font-semibold tracking-tight text-foreground">{vLabel}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{vSummary}</p>
              </div>
            </div>
          </div>

          {/* ── Para prevenir ─────────────────────────────────────────── */}
          {issues.length > 0 && (
            <div className="overflow-hidden rounded-2xl border border-warning/30 bg-warning/[0.05]">
              <div className="flex items-center gap-2 border-b border-warning/20 px-4 py-2.5 text-sm font-semibold">
                <AlertTriangle className="h-4 w-4 text-warning" /> Para prevenir en este cliente
              </div>
              <div className="divide-y divide-border/60">
                {issues.map((it, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <span className={cn("h-2 w-2 shrink-0 rounded-full", it.tone === "down" ? "bg-destructive" : "bg-warning")} />
                    <span className={cn("text-sm", it.tone === "down" ? "font-medium text-destructive" : "text-foreground")}>{it.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Capacidad: cuotas + base de conocimiento ──────────────── */}
          <div className="grid items-start gap-4 lg:grid-cols-2">

            {/* Cuotas del plan */}
            <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
              <PanelHeader icon={Shield} label="Cuotas del plan" sublabel={t.plan} />
              <div className="p-4 space-y-3.5">
                <QuotaBar label="Consultas / mes" used={quotaQ.used} limit={quotaQ.limit} pct={quotaQ.pct} />
                <QuotaBar label="Documentos" used={quotaD.used} limit={quotaD.limit} pct={quotaD.pct} />
              </div>
            </div>

            {/* Base de conocimiento — anillo de procesados + estados + quality */}
            <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
              <PanelHeader icon={FileText} label="Base de conocimiento" sublabel="documentos e ingesta" />
              <div className="flex items-center gap-5 p-4">
                <Donut value={m.docs.total > 0 ? m.docs.ready / m.docs.total : null} label="Procesados" />
                <div className="h-14 w-px bg-border shrink-0" />
                <div className="flex-1 min-w-0 space-y-2.5">
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold tabular-nums leading-none">{fmtNum(m.docs.total)}</span>
                    <span className="text-xs text-muted-foreground truncate">documentos · {fmtBytes(m.docs.storage_bytes)}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <StatusPill tone="success" label="listos" value={m.docs.ready} />
                    {m.docs.failed > 0 && <StatusPill tone="danger" label="fallidos" value={m.docs.failed} />}
                    {m.docs.processing > 0 && <StatusPill tone="warn" label="procesando" value={m.docs.processing} />}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap border-t pt-2 text-[11px] text-muted-foreground">
                    <CheckCircle2 className="h-3 w-3 shrink-0" /> Validación
                    <span className="font-semibold text-success tabular-nums">{fmtNum(m.quality.passed)} validados</span>
                    {m.quality.pending > 0 && <span className="font-semibold text-warning tabular-nums">· {fmtNum(m.quality.pending)} sin validar</span>}
                    {m.quality.skipped > 0 && <span className="font-semibold text-destructive tabular-nums">· {fmtNum(m.quality.skipped)} descartados</span>}
                  </div>
                </div>
              </div>
            </div>

          </div>

          {/* ── Infra: almacenamiento + señal de actividad ────────────── */}
          <div className="grid items-start gap-4 lg:grid-cols-2">

            {/* Almacenamiento + backup global */}
            <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
              <PanelHeader icon={HardDrive} label="Almacenamiento" sublabel="lo que ocupa en el servidor" />
              <div className="p-4 space-y-2.5">
                <StorageRow label="Documentos" value={healthData.storage.documents != null ? fmtNum(healthData.storage.documents) : "—"} />
                <StorageRow label="Datos en PostgreSQL" value={fmtBytes(healthData.storage.schema_bytes)} hint="schema propio" />
                <StorageRow
                  label="Archivos"
                  value={healthData.storage.minio_bytes != null ? fmtBytes(healthData.storage.minio_bytes) : "—"}
                  hint={healthData.storage.minio_objects != null ? `${fmtNum(healthData.storage.minio_objects)} objetos` : undefined}
                />
                <div className="flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                  <Database className="h-3.5 w-3.5 shrink-0" />
                  <span>Backups y disco son de toda la plataforma — en{" "}
                    <Link href="/superadmin/monitoring" className="text-action hover:underline">Monitoreo</Link>.</span>
                </div>
              </div>
            </div>

            {/* Señal de actividad — ¿el cliente sigue vivo? */}
            <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
              <PanelHeader icon={Activity} label="Señal de actividad" sublabel="¿el cliente está activo?" />
              <div className="grid grid-cols-2 divide-x">
                <div className="px-4 py-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Última consulta</p>
                  <p className={cn("mt-1.5 text-lg font-semibold leading-none", healthData.activity.last_query_at ? "text-foreground" : "text-warning")}>
                    {healthData.activity.last_query_at ? relTime(healthData.activity.last_query_at) : "Nunca"}
                  </p>
                </div>
                <div className="px-4 py-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Última ingesta</p>
                  <p className={cn("mt-1.5 text-lg font-semibold leading-none", healthData.activity.last_ingest_at ? "text-foreground" : "text-muted-foreground")}>
                    {healthData.activity.last_ingest_at ? relTime(healthData.activity.last_ingest_at) : "Nunca"}
                  </p>
                </div>
              </div>
            </div>

          </div>

          {/* ── Errores de esta organización ──────────────────────────── */}
          <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-2.5 border-b bg-muted/20">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-action-gradient-soft shrink-0">
                <Bug className="h-3.5 w-3.5 text-action" />
              </span>
              <span className="text-sm font-semibold">Errores de esta organización</span>
              <span className="text-xs text-muted-foreground hidden sm:inline">backend · últimos 7 días</span>
              {healthData.errors.length > 0 && (
                <span className="ml-auto inline-flex items-center justify-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-destructive">
                  {healthData.errors.length}
                </span>
              )}
            </div>
            {healthData.errors.length === 0 ? (
              <p className="px-4 py-4 text-sm text-success flex items-center gap-2 font-medium">
                <CheckCircle2 className="h-4 w-4 shrink-0" /> Sin errores registrados.
              </p>
            ) : (
              <div className="divide-y max-h-[320px] overflow-y-auto scrollbar-slim">
                {healthData.errors.map((e, i) => <ErrorRow key={i} e={e} />)}
              </div>
            )}
          </div>
          </>
            );
          })()}

          </section>
          )}

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
        <Dialog open onOpenChange={v => { if (!v) { setShowResetConfirm(false); setResetConfirmText(""); } }}>
          <DialogContent className="w-full max-w-md mx-4 sm:mx-auto">
            <DialogHeader>
              <div className="flex items-start gap-3 text-left">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                </div>
                <div className="min-w-0 space-y-1.5 pt-0.5">
                  <DialogTitle>Resetear onboarding</DialogTitle>
                  <p className="text-sm text-muted-foreground">
                    Esta acción borra de forma <span className="font-medium text-foreground">irreversible</span> en{" "}
                    <span className="font-medium text-foreground">{t.name}</span>:
                  </p>
                </div>
              </div>
            </DialogHeader>
            <ul className="space-y-1.5 text-sm text-muted-foreground pl-1">
              <li className="flex gap-2"><span className="text-destructive shrink-0">•</span> La configuración del bot (nombre, instrucciones, saludo)</li>
              <li className="flex gap-2"><span className="text-destructive shrink-0">•</span> Todos los sectores y sus asignaciones de operadores</li>
              <li className="flex gap-2"><span className="text-destructive shrink-0">•</span> <span><span className="font-medium text-foreground">Todas las conversaciones</span> con sus mensajes (el historial completo)</span></li>
            </ul>
            <p className="text-xs text-muted-foreground border-t pt-3">
              Los documentos y los usuarios no se tocan. El tenant vuelve a empezar desde el asistente
              de configuración. Antes de hacerlo en una organización con datos reales, verificá que el
              backup diario esté al día (Sistema → Backups y disco).
            </p>

            {/* Barrera anti-accidente: hay que tipear el nombre exacto. */}
            <div className="space-y-1.5">
              <Label htmlFor="reset-confirm" className="text-xs font-medium">
                Escribí <span className="font-semibold text-foreground">{t.name}</span> para confirmar
              </Label>
              <Input
                id="reset-confirm"
                value={resetConfirmText}
                onChange={e => setResetConfirmText(e.target.value)}
                placeholder={t.name}
                autoComplete="off"
              />
            </div>

            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button variant="outline" className="w-full sm:w-auto" onClick={() => { setShowResetConfirm(false); setResetConfirmText(""); }}>
                Cancelar
              </Button>
              <Button
                variant="destructive" className="w-full sm:w-auto"
                disabled={resetM.isPending || resetConfirmText.trim() !== t.name}
                onClick={() => resetM.mutate()}
              >
                {resetM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Sí, resetear
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {showSuspendConfirm && (
        <Dialog open onOpenChange={v => !v && setShowSuspendConfirm(false)}>
          <DialogContent className="w-full max-w-md mx-4 sm:mx-auto">
            <DialogHeader>
              <div className="flex items-start gap-3 text-left">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning/10">
                  <PauseCircle className="h-5 w-5 text-warning" />
                </div>
                <div className="min-w-0 space-y-1.5 pt-0.5">
                  <DialogTitle>Suspender organización</DialogTitle>
                  <p className="text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">{t.name}</span> va a quedar sin acceso:
                    sus usuarios no van a poder iniciar sesión y el asistente deja de responder a los afiliados.
                  </p>
                </div>
              </div>
            </DialogHeader>
            <p className="text-xs text-muted-foreground border-t pt-3">
              Es reversible — la podés reactivar cuando quieras desde acá. No se borra ningún dato.
            </p>
            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button variant="outline" className="w-full sm:w-auto" onClick={() => setShowSuspendConfirm(false)}>
                Cancelar
              </Button>
              <Button
                className="w-full sm:w-auto bg-warning text-warning-foreground hover:bg-warning/90"
                disabled={suspendM.isPending}
                onClick={() => suspendM.mutate()}
              >
                {suspendM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Suspender
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TopBar({ onBack }: { onBack: () => void }) {
  return (
    <div className="shrink-0 bg-background border-b px-4 sm:px-6 py-3">
      <div className="max-w-[1400px] mx-auto">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Organizaciones
        </button>
      </div>
    </div>
  );
}

// Panel desplegable: header clickeable con contador; cerrado por defecto.
function CollapsiblePanel({ icon: Icon, label, sublabel, count, defaultOpen = false, children }: {
  icon: any; label: string; sublabel?: string; count?: number; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const empty = count === 0;
  return (
    <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => !empty && setOpen(o => !o)}
        disabled={empty}
        className={cn(
          "flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors",
          empty ? "cursor-default" : "hover:bg-muted/30",
        )}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-action-gradient-soft shrink-0">
          <Icon className="h-3.5 w-3.5 text-action" />
        </span>
        <span className="text-sm font-semibold">{label}</span>
        {sublabel && <span className="text-xs text-muted-foreground hidden sm:inline">{sublabel}</span>}
        <span className="ml-auto flex items-center gap-2.5">
          {count != null && (
            <span className={cn(
              "inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums",
              empty ? "bg-muted text-muted-foreground/60" : "bg-action-gradient-soft text-action",
            )}>
              {count}
            </span>
          )}
          {!empty && <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />}
        </span>
      </button>
      {open && !empty && <div className="border-t animate-fade-in">{children}</div>}
    </div>
  );
}

// Cabecera de panel (ícono en gradient de marca + título).
function PanelHeader({ icon: Icon, label, sublabel }: { icon: any; label: string; sublabel?: string }) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5 border-b bg-muted/20">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-action-gradient-soft shrink-0">
        <Icon className="h-3.5 w-3.5 text-action" />
      </span>
      <span className="text-sm font-semibold">{label}</span>
      {sublabel && <span className="text-xs text-muted-foreground">{sublabel}</span>}
    </div>
  );
}

// Anillo radial (donut) para porcentajes — número al centro.
function Donut({ value, label }: { value: number | null; label: string }) {
  const pct = value == null ? null : Math.round(value * 100);
  const r = 25, c = 2 * Math.PI * r;
  const off = pct == null ? c : c * (1 - Math.min(pct, 100) / 100);
  return (
    <div className="flex shrink-0 flex-col items-center justify-center">
      <div className="relative h-[72px] w-[72px]">
        <svg className="h-[72px] w-[72px] -rotate-90" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r={r} fill="none" className="stroke-muted" strokeWidth="6" />
          {pct != null && (
            <circle
              cx="32" cy="32" r={r} fill="none"
              className="stroke-action transition-all"
              strokeWidth="6" strokeLinecap="round"
              strokeDasharray={c} strokeDashoffset={off}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-sm font-bold tabular-nums">
          {pct == null ? "—" : `${pct}%`}
        </div>
      </div>
      <p className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
    </div>
  );
}

// Indicador de latencia: número grande + estado + barra con zona SLA.
function LatencyGauge({ label, ms }: { label: string; ms: number | null }) {
  const tone = latencyTone(ms);
  const pct = ms == null ? 0 : Math.min((ms / 5000) * 100, 100); // 5s = lleno
  const bar =
    tone === "danger"  ? "bg-destructive" :
    tone === "warn"    ? "bg-warning" :
    tone === "success" ? "bg-success" :
                         "bg-muted-foreground/40";
  const txt =
    tone === "danger"  ? "text-destructive" :
    tone === "warn"    ? "text-warning" :
    tone === "success" ? "text-success" :
                         "text-muted-foreground";
  const status = ms == null ? "Sin datos" : tone === "success" ? "Óptima" : tone === "warn" ? "Elevada" : "Lenta";
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
        <span className={cn("inline-flex items-center gap-1 text-[10px] font-semibold", txt)}>
          <span className={cn("h-1.5 w-1.5 rounded-full", bar)} /> {status}
        </span>
      </div>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums leading-none">{fmtMs(ms)}</p>
      <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", bar)} style={{ width: `${Math.max(pct, 3)}%` }} />
      </div>
    </div>
  );
}

// Barra comparativa de volumen (proporcional al máximo del período).
function VolBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-[11px] font-medium text-muted-foreground">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-action-gradient transition-all" style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
      <span className="w-12 shrink-0 text-right text-xs font-semibold tabular-nums">{fmtNum(value)}</span>
    </div>
  );
}

// Pill de estado con conteo (listos / fallidos / etc.).
function StatusPill({ tone, label, value }: { tone: "neutral" | "success" | "warn" | "danger"; label: string; value: number }) {
  const cls =
    tone === "success" ? "bg-success/10 text-success" :
    tone === "warn"    ? "bg-warning/10 text-warning" :
    tone === "danger"  ? "bg-destructive/10 text-destructive" :
                         "bg-muted text-muted-foreground";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", cls)}>
      <span className="tabular-nums font-semibold">{fmtNum(value)}</span> {label}
    </span>
  );
}

// Fila de almacenamiento (label a la izquierda, valor a la derecha).
function StorageRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-muted-foreground truncate">
        {label}{hint && <span className="text-[11px] text-muted-foreground/60"> · {hint}</span>}
      </span>
      <span className="text-sm font-semibold tabular-nums shrink-0">{value}</span>
    </div>
  );
}

function SectionTitle({ icon: Icon, label, sublabel }: { icon: any; label: string; sublabel?: string }) {
  return (
    <div className="flex items-center gap-2.5 pt-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-action-gradient-soft shrink-0">
        <Icon className="h-4 w-4 text-action" />
      </span>
      <span className="text-sm font-semibold">{label}</span>
      {sublabel && <span className="text-xs text-muted-foreground">{sublabel}</span>}
    </div>
  );
}

function QuotaBar({ label, used, limit, pct }: { label: string; used: number; limit: number; pct: number | null }) {
  const unlimited = limit === -1;
  const danger = !unlimited && (pct ?? 0) >= 90;
  const warn   = !unlimited && (pct ?? 0) >= 70;

  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {unlimited
          ? <span className="text-xs text-muted-foreground font-medium">Ilimitado</span>
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

function latencyTone(ms: number | null | undefined): "neutral" | "success" | "warn" | "danger" {
  if (ms == null) return "neutral";
  if (ms > 5000)  return "danger";
  if (ms > 3000)  return "warn";
  return "success";
}

function LoadingState() {
  return (
    <div className="h-full flex flex-col overflow-hidden bg-muted/20">
      <div className="shrink-0 bg-background border-b px-4 sm:px-6 py-3 h-14" />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-4 space-y-4">
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
  const [confirmOff, setConfirmOff] = useState(false);

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
    <>
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
            onClick={() => setConfirmOff(true)}
            className="text-xs text-muted-foreground hover:text-destructive transition-colors shrink-0 flex items-center gap-1"
          >
            <X className="h-3 w-3" />
            Volver a estándar
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

    {confirmOff && activeBot && (
      <Dialog open onOpenChange={v => !v && setConfirmOff(false)}>
        <DialogContent className="w-full max-w-md mx-4 sm:mx-auto">
          <DialogHeader>
            <div className="flex items-start gap-3 text-left">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning/10">
                <Bot className="h-5 w-5 text-warning" />
              </div>
              <div className="min-w-0 space-y-1.5 pt-0.5">
                <DialogTitle>Volver a modo estándar</DialogTitle>
                <p className="text-sm text-muted-foreground">
                  El asistente va a dejar de usar la personalidad{" "}
                  <span className="font-medium text-foreground">{activeBot.nombre}</span> y va a responder
                  con el comportamiento estándar. Lo podés reactivar cuando quieras.
                </p>
              </div>
            </div>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => setConfirmOff(false)}>Cancelar</Button>
            <Button
              className="w-full sm:w-auto bg-warning text-warning-foreground hover:bg-warning/90"
              disabled={deactivateBotM.isPending}
              onClick={() => deactivateBotM.mutate(undefined, { onSettled: () => setConfirmOff(false) })}
            >
              {deactivateBotM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Volver a estándar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )}
    </>
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
    <FormSheet
      open
      onOpenChange={v => !v && onClose()}
      icon={Settings2}
      title="Editar usuario"
      description={user.email}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => saveM.mutate()} disabled={saveM.isPending || !name.trim()}>
            {saveM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
            Guardar
          </Button>
        </>
      }
    >
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

    </FormSheet>
  );
}


// ── Modal crear admin ─────────────────────────────────────────────────────────
function CreateAdminModal({ tenantId, tenantName, onClose, onCreated }: {
  tenantId: string; tenantName: string; onClose: () => void; onCreated: () => void;
}) {
  const [form, setForm] = useState({ email: "", name: "", password: "" });
  const [inviteMode, setInviteMode] = useState(true);
  const [error, setError] = useState("");
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const createM = useMutation({
    mutationFn: () => api.tenants.createAdmin(tenantId, {
      email: form.email, name: form.name,
      ...(inviteMode ? {} : { password: form.password }),
    }),
    onSuccess: (data: any) => {
      onCreated(); onClose();
      if (data?.invitation_sent === true) {
        toast({ title: "Invitación enviada", description: `${form.email} va a recibir un email para definir su contraseña.`, variant: "success" });
      } else if (data?.invitation_sent === false) {
        toast({ title: "Admin creado, pero el email no salió", description: "Puede usar «¿Olvidaste tu contraseña?» en el login.", variant: "destructive" });
      } else {
        toast({ title: "Admin creado", description: `${form.email} puede iniciar sesión en '${tenantId}'.`, variant: "success" });
      }
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail ?? "Error al crear admin.";
      setError(typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  return (
    <FormSheet
      open
      onOpenChange={v => !v && onClose()}
      icon={UserPlus}
      title="Nuevo usuario"
      description={<>Para <span className="font-medium text-foreground">{tenantName}</span></>}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button
            disabled={createM.isPending || !form.email || (!inviteMode && form.password.length < 8)}
            onClick={() => { setError(""); createM.mutate(); }}
          >
            {createM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            {inviteMode ? "Crear e invitar" : "Crear admin"}
          </Button>
        </>
      }
    >
        <div className="space-y-3 py-1">
          {([
            { key: "email", label: "Email",  placeholder: "admin@empresa.com", type: "email" },
            { key: "name",  label: "Nombre", placeholder: "Nombre Apellido",   type: "text" },
          ] as const).map(f => (
            <div key={f.key} className="space-y-1">
              <Label className="text-xs font-medium">{f.label}</Label>
              <Input type={f.type} placeholder={f.placeholder} value={(form as any)[f.key]} onChange={set(f.key)} className="h-9" />
            </div>
          ))}

          {/* Acceso: invitación por email (default) o contraseña manual */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Acceso</Label>
            <label className="flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer transition-colors has-[:checked]:border-action/40 has-[:checked]:bg-action/[0.04]">
              <input type="radio" name="adm-access" checked={inviteMode} onChange={() => setInviteMode(true)} className="mt-0.5" />
              <span className="text-xs">
                <span className="font-medium text-sm">Enviar invitación por email</span>
                <span className="block text-muted-foreground mt-0.5">Define su contraseña desde el enlace (72 hs). Verifica el email.</span>
              </span>
            </label>
            <label className="flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer transition-colors has-[:checked]:border-action/40 has-[:checked]:bg-action/[0.04]">
              <input type="radio" name="adm-access" checked={!inviteMode} onChange={() => setInviteMode(false)} className="mt-0.5" />
              <span className="text-xs">
                <span className="font-medium text-sm">Definir contraseña ahora</span>
              </span>
            </label>
            {!inviteMode && (
              <Input type="password" placeholder="Mínimo 8 caracteres" value={form.password} onChange={set("password")} className="h-9 animate-fade-in" />
            )}
          </div>

          {error && (
            <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2">
              <p className="text-xs text-destructive">{error}</p>
            </div>
          )}
        </div>

    </FormSheet>
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
