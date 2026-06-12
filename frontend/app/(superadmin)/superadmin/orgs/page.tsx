"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  Plus, Loader2, RefreshCw, Building2, AlertTriangle,
  ChevronRight, CheckCircle2, Search, Bot,
} from "lucide-react";
import { api, apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader, CountChip } from "@/components/layout/page-header";
import { fmtNum, HeaderKpi } from "@/components/superadmin/shared";
import { toast } from "@/components/ui/toast";
import { cn, toSlug } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────
interface TenantRow {
  id: string; name: string; plan: string; status: string;
  admin_email: string; created_at: string;
  limits: { users: number; documents: number; queries_month: number };
  usage_30d: { queries: number; ingests: number };
}

const PLAN_COLORS: Record<string, string> = {
  starter:      "bg-muted text-muted-foreground",
  professional: "bg-info/10 text-info",
  enterprise:   "bg-action-gradient-soft text-action",
};
// Estado en español, pill suave — el color queda reservado para estados.
const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  active:     { label: "Activa",     cls: "bg-success/10 text-success" },
  onboarding: { label: "Onboarding", cls: "bg-info/10 text-info" },
  suspended:  { label: "Suspendida", cls: "bg-destructive/10 text-destructive" },
};

const tenantsApi = {
  list:   () => apiClient.get("/tenants").then(r => r.data as TenantRow[]),
  create: (p: any) => apiClient.post("/tenants", p).then(r => r.data),
};

// ── Page ──────────────────────────────────────────────────────────────────────
export default function OrganizationsPage() {
  const router      = useRouter();
  const qc          = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch]         = useState("");

  const inv = () => {
    qc.invalidateQueries({ queryKey: ["tenants"] });
    qc.invalidateQueries({ queryKey: ["platform-health"] });
  };

  const { data: tenants = [], isLoading } = useQuery({
    queryKey: ["tenants"], queryFn: tenantsApi.list, refetchInterval: 30_000,
  });
  const { data: health } = useQuery({
    queryKey: ["platform-health"], queryFn: api.tenants.platformHealth,
    refetchInterval: 60_000, staleTime: 30_000,
  });

  const filtered = tenants.filter(t =>
    !search ||
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    t.id.toLowerCase().includes(search.toLowerCase()) ||
    t.admin_email.toLowerCase().includes(search.toLowerCase())
  );

  const hasAnomalies = (health?.anomalies?.length ?? 0) > 0;

  return (
    <>
      <PageShell>
        <PageHeader
          eyebrow="Plataforma"
          title="Organizaciones"
          badge={health
            ? <CountChip>{health.active_tenants} {health.active_tenants === 1 ? "activa" : "activas"}</CountChip>
            : undefined}
          description="Los clientes de la plataforma: planes, cuotas y acceso al detalle de cada uno."
          actions={
            <>
              <Button variant="ghost" size="icon" onClick={inv} className="h-9 w-9" title="Actualizar">
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button size="sm" onClick={() => setShowCreate(true)} className="h-9 gap-1.5 group">
                <Plus className="h-3.5 w-3.5 transition-transform group-hover:rotate-90" />
                <span className="hidden sm:inline">Nueva organización</span>
              </Button>
            </>
          }
        />

        {/* KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
          <HeaderKpi label="Organizaciones" value={health ? health.total_tenants : tenants.length} loading={!health && isLoading} />
          <HeaderKpi label="Activas" value={health?.active_tenants ?? 0} tone="success" loading={!health} />
          <HeaderKpi label="Consultas hoy" value={health?.queries_today ?? 0} loading={!health} />
          <HeaderKpi
            label="Cerca de cuota"
            value={health?.anomalies?.length ?? 0}
            tone={(health?.anomalies?.length ?? 0) > 0 ? "warn" : "neutral"}
            loading={!health}
          />
        </div>

        {/* Anomalías de cuota — clickeables al detalle */}
        {hasAnomalies && (
          <div className="rounded-xl border px-4 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm bg-warning/10 border-warning/20">
            <span className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="h-4 w-4 text-warning" /> Cerca del límite del plan:
            </span>
            {health!.anomalies.map(a => (
              <span
                key={a.tenant_id}
                className="inline-flex items-center gap-1 text-xs text-warning bg-warning/10 px-2 py-0.5 rounded-full cursor-pointer hover:bg-warning/20 transition-colors"
                onClick={() => router.push(`/superadmin/tenants/${a.tenant_id}`)}
              >
                {a.tenant_name} {a.pct}% cuota
              </span>
            ))}
          </div>
        )}

        {/* Búsqueda + lista */}
        <div className="space-y-4 animate-fade-in">
          <div className="flex items-center gap-3">
            <div className="relative max-w-sm flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Buscar por nombre, ID o email…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="h-9 text-sm pl-8"
              />
            </div>
            <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
              {filtered.length}{search ? ` de ${tenants.length}` : " organizaciones"}
            </span>
          </div>

          {isLoading ? (
            <div className="space-y-2">
              {[1,2,3].map(i => <Skeleton key={i} className="h-[72px] w-full rounded-2xl" />)}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Building2}
              title={search ? "Sin resultados" : "No hay organizaciones"}
              description={search ? undefined : "Creá la primera organización para empezar."}
            />
          ) : (
            <div className="space-y-2 pb-6 stagger-children">
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
        </div>
      </PageShell>

      <CreateTenantModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={inv} />
    </>
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

  // Consumo del mes vs cuota del plan — lo que el operador necesita de un
  // vistazo para detectar tenants cerca del límite sin entrar al detalle.
  const used  = t.usage_30d?.queries ?? 0;
  const limit = t.limits?.queries_month ?? 0;
  const pct   = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const quotaTone =
    pct === null ? "bg-muted-foreground/40" :
    pct >= 90    ? "bg-destructive" :
    pct >= 70    ? "bg-warning" :
                   "bg-success";

  return (
    <button
      onClick={onClick}
      className="w-full rounded-2xl border bg-card shadow text-left group card-interactive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center gap-3 px-4 py-3.5">
        <div className="shrink-0 w-10 h-10 rounded-xl bg-action-gradient-soft flex items-center justify-center">
          <span className="text-sm font-bold text-action uppercase">{t.name[0]}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{t.name}</span>
            <code className="text-xs text-muted-foreground font-mono bg-muted px-1.5 py-0.5 rounded hidden sm:inline">{t.id}</code>
            {anomaly && <span className="inline-flex items-center gap-1 text-xs text-warning font-medium"><AlertTriangle className="h-3 w-3" /> {anomaly.pct}% cuota</span>}
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">{t.admin_email} · desde {created}</p>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full hidden md:inline capitalize", PLAN_COLORS[t.plan] || "bg-muted")}>{t.plan}</span>
          <span className={cn(
            "text-xs font-medium px-2 py-0.5 rounded-full hidden sm:inline",
            (STATUS_PILL[t.status] ?? { cls: "bg-muted text-muted-foreground" }).cls
          )}>
            {(STATUS_PILL[t.status] ?? { label: t.status }).label}
          </span>

          {/* Cuota mensual de consultas — barra con umbral de color */}
          <div className="hidden lg:flex flex-col items-end gap-1 w-40">
            <span className="text-[11px] text-muted-foreground tabular-nums leading-none">
              {fmtNum(used)}{limit > 0 ? ` / ${fmtNum(limit)}` : ""} consultas 30d
            </span>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className={cn("h-full rounded-full transition-all", quotaTone)}
                style={{ width: `${pct ?? (used > 0 ? 100 : 0)}%` }}
              />
            </div>
          </div>

          <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-action transition-colors" />
        </div>
      </div>
    </button>
  );
}

// ── Modal crear tenant ────────────────────────────────────────────────────────
const EMPTY_FORM = { id: "", name: "", plan: "starter", admin_email: "", admin_name: "", admin_password: "", personality_id: "" };


function CreateTenantModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [slugLocked, setSlugLocked] = useState(false);
  const [error, setError] = useState("");

  const handleClose = () => { onClose(); setForm(EMPTY_FORM); setSlugLocked(false); setError(""); };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value;
    setForm(f => ({ ...f, name, ...(!slugLocked && { id: toSlug(name) }) }));
  };

  const handleSlugChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSlugLocked(true);
    setForm(f => ({ ...f, id: e.target.value }));
  };

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const { data: personalities = [], isLoading: loadingP } = useQuery({
    queryKey: ["prompt-templates"],
    queryFn: api.promptTemplates.list,
    enabled: open,
    staleTime: 60_000,
  });

  const createM = useMutation({
    mutationFn: () => tenantsApi.create(form),
    onSuccess: () => {
      onCreated(); handleClose();
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

  const canSubmit = !createM.isPending && form.id && form.name && form.admin_email && form.admin_password && form.personality_id;

  const selectedPersonality = availablePersonalities.find((x: any) => x.id === form.personality_id);

  return (
    <Dialog open={open} onOpenChange={v => !v && handleClose()}>
      <DialogContent className="flex flex-col p-0 gap-0 w-[calc(100%-2rem)] sm:w-full sm:max-w-lg">

        {/* Header */}
        <DialogHeader className="shrink-0 px-5 pt-5 pb-4 border-b">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-4 w-4 text-primary" />Nueva organización
          </DialogTitle>
        </DialogHeader>

        {/* Scrollable body */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-4 space-y-4">

          {/* Nombre + slug */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Nombre de la organización</Label>
            <Input placeholder="Mi Empresa S.A." value={form.name} onChange={handleNameChange} className="h-9" />
            {form.id && (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground shrink-0">ID:</span>
                <input
                  value={form.id}
                  onChange={handleSlugChange}
                  className="text-[11px] font-mono text-muted-foreground bg-muted/50 border border-transparent hover:border-border focus:border-ring focus:outline-none rounded px-1.5 py-0.5 flex-1 min-w-0"
                />
              </div>
            )}
          </div>

          {/* Admin — 2 cols en sm+ */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Email del admin</Label>
              <Input type="email" placeholder="admin@mi-empresa.com" value={form.admin_email} onChange={set("admin_email")} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Nombre del admin</Label>
              <Input type="text" placeholder="Nombre Apellido" value={form.admin_name} onChange={set("admin_name")} className="h-9" />
            </div>
          </div>

          {/* Contraseña + Plan — 2 cols en sm+ */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Contraseña inicial</Label>
              <Input type="password" placeholder="Mínimo 8 caracteres" value={form.admin_password} onChange={set("admin_password")} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Plan</Label>
              <Select
                value={form.plan}
                onValueChange={v => setForm(f => ({ ...f, plan: v, personality_id: "" }))}
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="starter">Starter</SelectItem>
                  <SelectItem value="professional">Professional</SelectItem>
                  <SelectItem value="enterprise">Enterprise</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground leading-tight">
                {form.plan === "starter" && "5 usuarios · 500 docs · 5K consultas/mes"}
                {form.plan === "professional" && "50 usuarios · 10K docs · 100K consultas/mes"}
                {form.plan === "enterprise" && "Sin límites"}
              </p>
            </div>
          </div>

          {/* Personalidad */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium flex items-center gap-1">
              <Bot className="h-3.5 w-3.5 text-primary" />
              Personalidad del bot <span className="text-destructive ml-0.5">*</span>
            </Label>
            {loadingP ? (
              <div className="h-9 border rounded-md flex items-center px-3 gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando…
              </div>
            ) : availablePersonalities.length === 0 ? (
              <div className="h-9 border rounded-md flex items-center px-3 text-sm text-muted-foreground bg-muted/40">
                No hay personalidades para este plan
              </div>
            ) : (
              <Select
                value={form.personality_id || undefined}
                onValueChange={v => setForm(f => ({ ...f, personality_id: v }))}
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Elegir personalidad…" />
                </SelectTrigger>
                <SelectContent>
                  {availablePersonalities.map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>{p.nombre}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {selectedPersonality?.descripcion && (
              <p className="text-[11px] text-muted-foreground leading-snug pl-0.5">{selectedPersonality.descripcion}</p>
            )}
          </div>

          {error && (
            <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2">
              <p className="text-xs text-destructive">{error}</p>
            </div>
          )}
        </div>

        {/* Footer pegado abajo */}
        <DialogFooter className="shrink-0 px-5 py-4 border-t flex-col sm:flex-row gap-2">
          <Button variant="outline" className="w-full sm:w-auto" onClick={handleClose}>Cancelar</Button>
          <Button className="w-full sm:w-auto" disabled={!canSubmit} onClick={() => { setError(""); createM.mutate(); }}>
            {createM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Crear organización
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
