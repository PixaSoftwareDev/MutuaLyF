"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  Shield, Plus, Loader2, RefreshCw, Building2, AlertTriangle,
  ChevronRight, TrendingUp, CheckCircle2, Database, Server,
  Zap, Activity, Cpu, HardDrive, Wifi, AlertCircle, Bot,
  BarChart3, FileStack,
} from "lucide-react";
import { api, apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────
interface TenantRow {
  id: string; name: string; plan: string; status: string;
  admin_email: string; created_at: string;
  limits: { users: number; documents: number; queries_month: number };
  usage_30d: { queries: number; ingests: number };
}

const PLAN_COLORS: Record<string, string> = {
  starter:      "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  professional: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  enterprise:   "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
};
const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  active: "default", onboarding: "secondary", suspended: "destructive",
};

const tenantsApi = {
  list:   () => apiClient.get("/tenants").then(r => r.data as TenantRow[]),
  create: (p: any) => apiClient.post("/tenants", p).then(r => r.data),
};

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return String(n);
}
function fmtBytes(b: number): string {
  if (b >= 1_073_741_824) return (b / 1_073_741_824).toFixed(1) + " GB";
  if (b >= 1_048_576)     return (b / 1_048_576).toFixed(1) + " MB";
  if (b >= 1_024)         return (b / 1_024).toFixed(1) + " KB";
  return b + " B";
}

type Tab = "orgs" | "sistema";

// ── Page ──────────────────────────────────────────────────────────────────────
export default function SuperAdminPage() {
  const router      = useRouter();
  const qc          = useQueryClient();
  const [tab, setTab]           = useState<Tab>("orgs");
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch]         = useState("");

  const inv = () => {
    qc.invalidateQueries({ queryKey: ["tenants"] });
    qc.invalidateQueries({ queryKey: ["platform-health"] });
    qc.invalidateQueries({ queryKey: ["platform-system"] });
  };

  const { data: tenants = [], isLoading } = useQuery({
    queryKey: ["tenants"], queryFn: tenantsApi.list, refetchInterval: 30_000,
  });
  const { data: health } = useQuery({
    queryKey: ["platform-health"], queryFn: api.tenants.platformHealth,
    refetchInterval: 60_000, staleTime: 30_000,
  });
  const { data: system, isLoading: sysLoading } = useQuery({
    queryKey: ["platform-system"], queryFn: api.tenants.platformSystem,
    refetchInterval: 30_000, staleTime: 15_000,
    enabled: tab === "sistema",
  });

  const filtered = tenants.filter(t =>
    !search ||
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    t.id.toLowerCase().includes(search.toLowerCase()) ||
    t.admin_email.toLowerCase().includes(search.toLowerCase())
  );

  const hasAnomalies = (health?.anomalies?.length ?? 0) > 0;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-muted/20">

      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <div className="shrink-0 bg-background border-b px-4 sm:px-6">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3 h-14">
          <div className="flex items-center gap-2 min-w-0">
            <Shield className="h-5 w-5 text-primary shrink-0" />
            <h1 className="font-semibold text-base sm:text-lg">Plataforma</h1>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="ghost" size="icon" onClick={inv} className="h-8 w-8" title="Actualizar">
              <RefreshCw className="h-4 w-4" />
            </Button>
            {tab === "orgs" && (
              <Button size="sm" onClick={() => setShowCreate(true)} className="h-8 gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Nueva org.</span>
              </Button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="max-w-5xl mx-auto flex gap-0 -mb-px">
          {([
            { id: "orgs",    label: "Organizaciones", icon: Building2 },
            { id: "sistema", label: "Sistema",         icon: Activity  },
          ] as { id: Tab; label: string; icon: any }[]).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors",
                tab === t.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <t.icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Scrollable body ───────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 space-y-4">

          {/* ── Health strip (always visible) ─────────────────────────── */}
          <div className={cn(
            "rounded-lg border px-4 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm",
            hasAnomalies
              ? "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800"
              : "bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-800"
          )}>
            {health ? (
              <>
                <span className="flex items-center gap-1.5 font-medium">
                  {hasAnomalies
                    ? <AlertTriangle className="h-4 w-4 text-amber-500" />
                    : <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                  {health.active_tenants} / {health.total_tenants} activas
                </span>
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <TrendingUp className="h-3.5 w-3.5" />
                  {fmtNum(health.queries_today)} consultas hoy
                </span>
                {system && (
                  <>
                    <span className={cn("flex items-center gap-1 text-xs", system.postgres.up ? "text-emerald-600" : "text-destructive")}>
                      <Database className="h-3 w-3" /> PG {system.postgres.up ? "OK" : "DOWN"}
                    </span>
                    <span className={cn("flex items-center gap-1 text-xs", system.redis.up ? "text-emerald-600" : "text-destructive")}>
                      <Zap className="h-3 w-3" /> Redis {system.redis.up ? "OK" : "DOWN"}
                    </span>
                    {system.backend.error_rate_5m > 0.01 && (
                      <span className="text-xs text-destructive flex items-center gap-1">
                        <AlertCircle className="h-3 w-3" /> {(system.backend.error_rate_5m * 100).toFixed(1)}% errores HTTP
                      </span>
                    )}
                  </>
                )}
                {health.anomalies.map(a => (
                  <span
                    key={a.tenant_id}
                    className="text-xs text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 rounded-full cursor-pointer hover:bg-amber-200 transition-colors"
                    onClick={() => { setTab("orgs"); router.push(`/superadmin/tenants/${a.tenant_id}`); }}
                  >
                    ⚠ {a.tenant_name} {a.pct}% cuota
                  </span>
                ))}
              </>
            ) : (
              <Skeleton className="h-4 w-64" />
            )}
          </div>

          {/* ══ TAB: ORGANIZACIONES ══════════════════════════════════════ */}
          {tab === "orgs" && (
            <>
              <div className="flex items-center gap-3">
                <Input
                  placeholder="Buscar por nombre, ID o email..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="h-9 text-sm max-w-sm"
                />
                <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                  {filtered.length}{search ? ` de ${tenants.length}` : " organizaciones"}
                </span>
              </div>

              {isLoading ? (
                <div className="space-y-2">
                  {[1,2,3].map(i => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
                </div>
              ) : filtered.length === 0 ? (
                <div className="text-center py-20 text-muted-foreground text-sm">
                  <Building2 className="h-10 w-10 mx-auto mb-3 opacity-20" />
                  {search ? "Sin resultados." : "No hay organizaciones. Creá la primera."}
                </div>
              ) : (
                <div className="space-y-2 pb-6">
                  {filtered.map(t => (
                    <TenantRowCard
                      key={t.id}
                      tenant={t}
                      anomaly={health?.anomalies.find(a => a.tenant_id === t.id)}
                      onClick={() => router.push(`/superadmin/tenants/${t.id}`)}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {/* ══ TAB: SISTEMA ═════════════════════════════════════════════ */}
          {tab === "sistema" && (
            <SystemTab system={system} loading={sysLoading} />
          )}

        </div>
      </div>

      <CreateTenantModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={inv} />
    </div>
  );
}

// ── System tab ────────────────────────────────────────────────────────────────
function SystemTab({ system, loading }: { system: any; loading: boolean }) {
  if (loading) return (
    <div className="space-y-4">
      {[1,2,3,4].map(i => <Skeleton key={i} className="h-32 rounded-xl" />)}
    </div>
  );
  if (!system) return null;

  return (
    <div className="space-y-5 pb-6">

      {/* Application counters */}
      <Section icon={BarChart3} label="Aplicación" sublabel="métricas acumuladas desde inicio">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
          <SysKPI label="Tenants activos"   value={String(system.app.active_tenants)} color="text-primary" />
          <SysKPI label="Consultas totales" value={fmtNum(system.app.total_queries)} color="text-primary" />
          <SysKPI label="Cache hits"        value={fmtNum(system.app.total_cache_hits)} color="text-blue-600" />
          <SysKPI label="Ingestas totales"  value={fmtNum(system.app.total_ingests)} color="text-violet-600" />
          <SysKPI label="HTTP requests"     value={fmtNum(system.backend.total_requests)} color="text-slate-600" />
        </div>
        {Object.keys(system.app.quality).length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-2 text-xs">
            <span className="text-muted-foreground">Quality gate:</span>
            {Object.entries(system.app.quality as Record<string, number>).map(([k, v]) => (
              <span key={k} className={cn("px-2 py-0.5 rounded-full font-medium",
                k === "passed"  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" :
                k === "skipped" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" :
                                  "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
              )}>
                {k}: {fmtNum(v)}
              </span>
            ))}
          </div>
        )}
      </Section>

      {/* Backend HTTP */}
      <Section icon={Server} label="Backend API" sublabel="últimos 10 min">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          <SysKPI
            label="Estado"
            value={system.backend.up ? "OK" : "DOWN"}
            color={system.backend.up ? "text-emerald-600" : "text-destructive"}
          />
          <SysKPI
            label="Latencia p95"
            value={system.backend.latency_p95_ms != null ? system.backend.latency_p95_ms.toFixed(0) + "ms" : "—"}
            color={
              system.backend.latency_p95_ms == null ? "text-muted-foreground" :
              system.backend.latency_p95_ms > 2000 ? "text-destructive" :
              system.backend.latency_p95_ms > 1000 ? "text-amber-600" : "text-emerald-600"
            }
          />
          <SysKPI
            label="Error rate 5m"
            value={system.backend.error_rate_5m > 0 ? (system.backend.error_rate_5m * 100).toFixed(2) + "%" : "0%"}
            color={system.backend.error_rate_5m > 0.01 ? "text-destructive" : "text-emerald-600"}
          />
        </div>
      </Section>

      {/* PostgreSQL */}
      <Section icon={Database} label="PostgreSQL" sublabel={`${fmtBytes(system.postgres.db_size_bytes)} · plataforma`}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <SysKPI
            label="Estado"
            value={system.postgres.up ? "OK" : "DOWN"}
            color={system.postgres.up ? "text-emerald-600" : "text-destructive"}
          />
          <SysKPI label="Conexiones activas" value={String(system.postgres.connections)} color="text-foreground" />
          <SysKPI
            label="Cache hit rate"
            value={system.postgres.cache_hit_rate != null ? (system.postgres.cache_hit_rate * 100).toFixed(1) + "%" : "—"}
            color={
              system.postgres.cache_hit_rate == null ? "text-muted-foreground" :
              system.postgres.cache_hit_rate < 0.9 ? "text-amber-600" : "text-emerald-600"
            }
            sublabel="buffer pool"
          />
          <SysKPI
            label="Deadlocks"
            value={String(system.postgres.deadlocks_total)}
            color={system.postgres.deadlocks_total > 0 ? "text-destructive" : "text-emerald-600"}
            sublabel="acumulados"
          />
        </div>
      </Section>

      {/* Redis */}
      <Section icon={Zap} label="Redis" sublabel="broker DB0 · cache DB1 · rate-limit DB2">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
          <SysKPI
            label="Estado"
            value={system.redis.up ? "OK" : "DOWN"}
            color={system.redis.up ? "text-emerald-600" : "text-destructive"}
          />
          <SysKPI
            label="Memoria usada"
            value={fmtBytes(system.redis.memory_used_bytes)}
            sublabel={system.redis.memory_max_bytes > 0 ? `/ ${fmtBytes(system.redis.memory_max_bytes)}` : "sin límite"}
            color="text-foreground"
          />
          <SysKPI
            label="Hit rate keyspace"
            value={system.redis.keyspace_hit_rate != null ? (system.redis.keyspace_hit_rate * 100).toFixed(1) + "%" : "—"}
            color={
              system.redis.keyspace_hit_rate == null ? "text-muted-foreground" :
              system.redis.keyspace_hit_rate < 0.3 ? "text-amber-600" : "text-emerald-600"
            }
          />
          <SysKPI label="Clientes conectados" value={String(system.redis.connected_clients)} color="text-foreground" />
          <SysKPI
            label="Claves broker (DB0)"
            value={String(system.redis.keys_by_db?.db0 ?? 0)}
            sublabel="jobs pendientes"
            color="text-foreground"
          />
          <SysKPI
            label="Cache entries (DB1)"
            value={String(system.redis.keys_by_db?.db1 ?? 0)}
            color="text-foreground"
          />
          <SysKPI
            label="Evictions"
            value={String(system.redis.evicted_keys)}
            color={system.redis.evicted_keys > 0 ? "text-destructive" : "text-emerald-600"}
            sublabel={system.redis.evicted_keys > 0 ? "⚠ memoria insuficiente" : "OK"}
          />
          <SysKPI
            label="Fragmentación"
            value={system.redis.fragmentation_ratio.toFixed(2) + "x"}
            color={
              system.redis.fragmentation_ratio > 1.5 ? "text-amber-600" :
              system.redis.fragmentation_ratio < 0.7 ? "text-amber-600" : "text-emerald-600"
            }
            sublabel={system.redis.slowlog_length > 0 ? `slowlog: ${system.redis.slowlog_length}` : undefined}
          />
        </div>
      </Section>

      {/* Groq */}
      <Section icon={Bot} label="Groq API" sublabel="llamadas acumuladas desde inicio del proceso">
        {system.groq.total_calls === 0 ? (
          <p className="text-sm text-muted-foreground py-2">Sin llamadas registradas aún. Los contadores se resetean al reiniciar el backend.</p>
        ) : (
          <div className="space-y-2">
            {system.groq.by_model.map((m: any) => (
              <div key={m.model} className="rounded-lg border bg-muted/30 px-4 py-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <code className="text-xs font-mono text-foreground">{m.model}</code>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="tabular-nums">{fmtNum(m.total)} llamadas</span>
                    {m.errors > 0 && (
                      <span className="text-destructive font-medium">{m.errors} errores</span>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(m.calls as Record<string, number>).map(([status, count]) => (
                    <span key={status} className={cn("text-xs px-2 py-0.5 rounded-full",
                      status === "success"    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" :
                      status === "error"      ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" :
                      status === "timeout"    ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" :
                      status === "rate_limit" ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400" :
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
      </Section>

    </div>
  );
}

// ── Shared sub-components ──────────────────────────────────────────────────────
function Section({ icon: Icon, label, sublabel, children }: {
  icon: any; label: string; sublabel?: string; children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/30">
        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-semibold">{label}</span>
        {sublabel && <span className="text-xs text-muted-foreground">{sublabel}</span>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function SysKPI({ label, value, color, sublabel }: { label: string; value: string; color: string; sublabel?: string }) {
  return (
    <div className="rounded-lg border bg-background px-3 py-2.5">
      <p className={cn("text-lg font-bold tabular-nums leading-none", color)}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1.5 leading-tight">{label}</p>
      {sublabel && <p className="text-[10px] text-muted-foreground/70 mt-0.5">{sublabel}</p>}
    </div>
  );
}

// ── Tenant row card ───────────────────────────────────────────────────────────
function TenantRowCard({ tenant: t, anomaly, onClick }: {
  tenant: TenantRow;
  anomaly?: { pct: number; detail: string };
  onClick: () => void;
}) {
  const created = t.created_at
    ? new Date(t.created_at).toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" })
    : "—";

  return (
    <button
      onClick={onClick}
      className="w-full rounded-xl border bg-card shadow-sm hover:shadow-md hover:border-primary/30 transition-all text-left group"
    >
      <div className="flex items-center gap-3 px-4 py-3.5">
        <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
          <span className="text-sm font-bold text-primary uppercase">{t.name[0]}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{t.name}</span>
            <code className="text-xs text-muted-foreground font-mono bg-muted px-1.5 py-0.5 rounded hidden sm:inline">{t.id}</code>
            {anomaly && <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">⚠ {anomaly.pct}% cuota</span>}
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">{t.admin_email} · desde {created}</p>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full hidden md:inline", PLAN_COLORS[t.plan] || "bg-muted")}>{t.plan}</span>
          <Badge variant={STATUS_VARIANT[t.status] ?? "secondary"} className="text-xs capitalize hidden sm:flex">{t.status}</Badge>
          <span className="text-xs text-muted-foreground tabular-nums hidden md:inline">{fmtNum(t.usage_30d?.queries ?? 0)} q/30d</span>
          <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
        </div>
      </div>
    </button>
  );
}

// ── Modal crear tenant ────────────────────────────────────────────────────────
const EMPTY_FORM = { id: "", name: "", plan: "starter", admin_email: "", admin_name: "", admin_password: "", personality_id: "" };

function CreateTenantModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState("");
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  // Load available personalities
  const { data: personalities = [], isLoading: loadingP } = useQuery({
    queryKey: ["prompt-templates"],
    queryFn: api.promptTemplates.list,
    enabled: open,
    staleTime: 60_000,
  });

  const createM = useMutation({
    mutationFn: () => tenantsApi.create(form),
    onSuccess: () => {
      onCreated(); onClose();
      setForm(EMPTY_FORM);
      toast({ title: "Organización creada", description: `'${form.id}' provisionada correctamente.`, variant: "success" });
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail ?? "Error al crear.";
      setError(typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  const PLAN_ORDER: Record<string, number> = { starter: 0, professional: 1, enterprise: 2 };
  const availablePersonalities = personalities.filter(
    (p: any) => PLAN_ORDER[p.plan_minimo] <= PLAN_ORDER[form.plan]
  );

  const canSubmit = !createM.isPending && form.id && form.admin_email && form.admin_password && form.personality_id;

  const fields = [
    { key: "id",             label: "ID único (slug)",           placeholder: "mi-empresa",           type: "text",     hint: "Solo minúsculas, números y guiones." },
    { key: "name",           label: "Nombre de la organización", placeholder: "Mi Empresa S.A.",      type: "text" },
    { key: "admin_email",    label: "Email del admin",           placeholder: "admin@mi-empresa.com", type: "email" },
    { key: "admin_name",     label: "Nombre del admin",          placeholder: "Nombre Apellido",      type: "text" },
    { key: "admin_password", label: "Contraseña inicial",        placeholder: "Mínimo 8 caracteres",  type: "password" },
  ] as const;

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="w-full max-w-md mx-4 sm:mx-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-primary" />Nueva organización
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1">
          {fields.map(f => (
            <div key={f.key} className="space-y-1">
              <Label className="text-xs font-medium">{f.label}</Label>
              <Input type={f.type} placeholder={f.placeholder} value={(form as any)[f.key]} onChange={set(f.key)} className="h-9" />
              {"hint" in f && f.hint && <p className="text-[11px] text-muted-foreground">{f.hint}</p>}
            </div>
          ))}

          <div className="space-y-1">
            <Label className="text-xs font-medium">Plan</Label>
            <select className="w-full text-sm border rounded-md px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-ring" value={form.plan} onChange={e => { set("plan")(e); setForm(f => ({ ...f, plan: e.target.value, personality_id: "" })); }}>
              <option value="starter">Starter — 5 usuarios, 500 docs, 5K consultas/mes</option>
              <option value="professional">Professional — 50 usuarios, 10K docs, 100K consultas/mes</option>
              <option value="enterprise">Enterprise — Sin límites</option>
            </select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs font-medium flex items-center gap-1">
              <Bot className="h-3.5 w-3.5 text-primary" />
              Personalidad del bot <span className="text-destructive ml-0.5">*</span>
            </Label>
            {loadingP ? (
              <div className="h-9 border rounded-md flex items-center px-3 gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando personalidades…
              </div>
            ) : availablePersonalities.length === 0 ? (
              <div className="h-9 border rounded-md flex items-center px-3 text-sm text-muted-foreground bg-muted/40">
                No hay personalidades disponibles para este plan
              </div>
            ) : (
              <select
                className="w-full text-sm border rounded-md px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                value={form.personality_id}
                onChange={set("personality_id")}
              >
                <option value="">Elegir personalidad…</option>
                {availablePersonalities.map((p: any) => (
                  <option key={p.id} value={p.id}>{p.nombre}</option>
                ))}
              </select>
            )}
            {form.personality_id && (() => {
              const p = availablePersonalities.find((x: any) => x.id === form.personality_id);
              return p?.descripcion ? (
                <p className="text-[11px] text-muted-foreground pl-1">{p.descripcion}</p>
              ) : null;
            })()}
            <p className="text-[11px] text-muted-foreground">
              Se puede cambiar o agregar más personalidades desde el panel de la organización.
            </p>
          </div>

          {error && <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2"><p className="text-xs text-destructive">{error}</p></div>}
        </div>
        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button variant="outline" className="w-full sm:w-auto" onClick={onClose}>Cancelar</Button>
          <Button className="w-full sm:w-auto" disabled={!canSubmit} onClick={() => { setError(""); createM.mutate(); }}>
            {createM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Crear organización
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
