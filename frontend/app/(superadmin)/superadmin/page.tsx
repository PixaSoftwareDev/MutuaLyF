"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Shield, Plus, Loader2, RefreshCw, Users, FileText, TrendingUp, Activity,
  ChevronDown, ChevronRight, PauseCircle, PlayCircle, Settings2, UserPlus,
  BarChart3, Zap, Database,
} from "lucide-react";
import { api, apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

// ── Types ─────────────────────────────────────────────────────────────────────
interface TenantRow {
  id: string; name: string; plan: string; status: string;
  admin_email: string; created_at: string;
  limits: { users: number; documents: number; queries_month: number };
  usage_30d: { queries: number; ingests: number };
}

const PLAN_COLORS: Record<string, string> = {
  starter:      "bg-slate-100 text-slate-700",
  professional: "bg-blue-100 text-blue-700",
  enterprise:   "bg-purple-100 text-purple-700",
};

// ── API helpers ───────────────────────────────────────────────────────────────
const tenantsApi = {
  list:     () => apiClient.get("/tenants").then(r => r.data as TenantRow[]),
  create:   (p: any) => apiClient.post("/tenants", p).then(r => r.data),
  update:   (id: string, p: any) => apiClient.patch(`/tenants/${id}`, p).then(r => r.data),
  suspend:  (id: string) => apiClient.post(`/tenants/${id}/suspend`).then(r => r.data),
  activate: (id: string) => apiClient.post(`/tenants/${id}/activate`).then(r => r.data),
};

// ── Page ──────────────────────────────────────────────────────────────────────
export default function SuperAdminPage() {
  const qc = useQueryClient();
  const inv = () => { qc.invalidateQueries({ queryKey: ["tenants"] }); qc.invalidateQueries({ queryKey: ["platform-traffic"] }); };
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateAdmin, setShowCreateAdmin] = useState<string | null>(null);

  const { data: tenants = [], isLoading } = useQuery({
    queryKey: ["tenants"],
    queryFn: tenantsApi.list,
    refetchInterval: 30_000,
  });

  const { data: traffic } = useQuery({
    queryKey: ["platform-traffic"],
    queryFn: api.tenants.platformTraffic,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const suspendM  = useMutation({ mutationFn: tenantsApi.suspend,  onSuccess: () => { inv(); toast({ title: "Tenant suspendido" }); }, onError: () => toast({ title: "Error", variant: "destructive" }) });
  const activateM = useMutation({ mutationFn: tenantsApi.activate, onSuccess: () => { inv(); toast({ title: "Tenant reactivado", variant: "success" }); }, onError: () => toast({ title: "Error", variant: "destructive" }) });
  const updateM   = useMutation({ mutationFn: ({ id, data }: { id: string; data: any }) => tenantsApi.update(id, data), onSuccess: () => { inv(); toast({ title: "Plan actualizado", variant: "success" }); }, onError: () => toast({ title: "Error", variant: "destructive" }) });

  const activeCount  = tenants.filter(t => t.status === "active").length;
  const totalQ30     = traffic?.per_tenant.reduce((s, t) => s + t.queries_30d, 0) ?? tenants.reduce((s, t) => s + (t.usage_30d?.queries ?? 0), 0);
  const totalIngests = traffic?.per_tenant.reduce((s, t) => s + t.ingests_30d, 0) ?? 0;

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="max-w-6xl mx-auto p-6 space-y-6">

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Shield className="h-6 w-6 text-primary" />
              Plataforma
            </h1>
            <p className="text-muted-foreground text-sm mt-0.5">Gestión global de tenants, planes y tráfico</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={inv}>
              <RefreshCw className="h-4 w-4 mr-1" />Actualizar
            </Button>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-1" />Nuevo tenant
            </Button>
          </div>
        </div>

        {/* Stats globales */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard icon={Users}     label="Tenants activos"  value={activeCount} />
          <StatCard icon={FileText}  label="Total tenants"    value={tenants.length} />
          <StatCard icon={TrendingUp} label="Consultas 30d"   value={totalQ30.toLocaleString()} />
          <StatCard icon={Database}  label="Ingestas 30d"     value={totalIngests.toLocaleString()} />
        </div>

        {/* Traffic por tenant */}
        {traffic && traffic.per_tenant.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <h2 className="font-semibold text-sm flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                Tráfico por organización (últimos 30 días)
              </h2>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                {traffic.per_tenant.map(t => {
                  const maxQ = Math.max(...traffic.per_tenant.map(x => x.queries_30d), 1);
                  const pct  = Math.round((t.queries_30d / maxQ) * 100);
                  return (
                    <div key={t.id} className="px-6 py-3 flex items-center gap-4">
                      <div className="w-32 shrink-0">
                        <p className="text-sm font-medium truncate">{t.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">{t.id}</p>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs text-muted-foreground w-20 text-right shrink-0">
                            {t.queries_30d.toLocaleString()} q
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${PLAN_COLORS[t.plan] || "bg-muted"}`}>{t.plan}</span>
                        <Badge variant={t.status === "active" ? "default" : "secondary"} className="text-xs">{t.status}</Badge>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Lista de tenants */}
        <Card>
          <CardHeader className="pb-3">
            <h2 className="font-semibold text-sm">Organizaciones ({tenants.length})</h2>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}</div>
            ) : tenants.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-sm">No hay organizaciones. Creá la primera.</div>
            ) : (
              <div className="space-y-2">
                {tenants.map(t => (
                  <TenantCard
                    key={t.id}
                    tenant={t}
                    onSuspend={id => suspendM.mutate(id)}
                    onActivate={id => activateM.mutate(id)}
                    onChangePlan={(id, plan) => updateM.mutate({ id, data: { plan } })}
                    onCreateAdmin={id => setShowCreateAdmin(id)}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <CreateTenantModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={inv} />
      {showCreateAdmin && (
        <CreateAdminModal
          tenantId={showCreateAdmin}
          tenantName={tenants.find(t => t.id === showCreateAdmin)?.name ?? showCreateAdmin}
          onClose={() => setShowCreateAdmin(null)}
          onCreated={inv}
        />
      )}
    </div>
  );
}

// ── Tenant card ───────────────────────────────────────────────────────────────
function TenantCard({ tenant: t, onSuspend, onActivate, onChangePlan, onCreateAdmin }: {
  tenant: TenantRow;
  onSuspend: (id: string) => void;
  onActivate: (id: string) => void;
  onChangePlan: (id: string, plan: string) => void;
  onCreateAdmin: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editPlan, setEditPlan] = useState(false);
  const created = new Date(t.created_at).toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" });

  return (
    <div className="rounded-lg border overflow-hidden">
      <div className="flex items-center gap-3 p-3 hover:bg-accent/20 cursor-pointer transition-colors" onClick={() => setExpanded(v => !v)}>
        {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{t.name}</span>
            <code className="text-xs text-muted-foreground font-mono bg-muted px-1 rounded">{t.id}</code>
          </div>
          <p className="text-xs text-muted-foreground">{t.admin_email} · {created}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${PLAN_COLORS[t.plan] || "bg-muted"}`}>{t.plan}</span>
          <Badge variant={t.status === "active" ? "default" : t.status === "suspended" ? "destructive" : "secondary"} className="text-xs">{t.status}</Badge>
          <span className="text-xs text-muted-foreground hidden sm:block">{t.usage_30d.queries.toLocaleString()} q/30d</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t bg-muted/20 p-4 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <InfoField label="Consultas 30d"   value={t.usage_30d.queries.toLocaleString()} />
            <InfoField label="Ingestas 30d"    value={t.usage_30d.ingests.toLocaleString()} />
            <InfoField label="Límite usuarios" value={t.limits?.users === -1 ? "Ilimitado" : String(t.limits?.users ?? "—")} />
            <InfoField label="Límite docs"     value={t.limits?.documents === -1 ? "Ilimitado" : String(t.limits?.documents ?? "—")} />
          </div>
          <Separator />
          <div className="flex flex-wrap gap-2">
            {editPlan ? (
              <div className="flex items-center gap-2">
                <select className="text-sm border rounded px-2 py-1 bg-background" defaultValue={t.plan}
                  onChange={e => { onChangePlan(t.id, e.target.value); setEditPlan(false); }}>
                  <option value="starter">Starter</option>
                  <option value="professional">Professional</option>
                  <option value="enterprise">Enterprise</option>
                </select>
                <Button size="sm" variant="ghost" onClick={() => setEditPlan(false)}>Cancelar</Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setEditPlan(true)}>
                <Settings2 className="h-3.5 w-3.5 mr-1" />Cambiar plan
              </Button>
            )}

            <Button size="sm" variant="outline" onClick={() => onCreateAdmin(t.id)}>
              <UserPlus className="h-3.5 w-3.5 mr-1" />Crear admin
            </Button>

            {t.status === "active" || t.status === "onboarding" ? (
              <Button size="sm" variant="outline" className="text-amber-600 border-amber-300 hover:bg-amber-50" onClick={() => onSuspend(t.id)}>
                <PauseCircle className="h-3.5 w-3.5 mr-1" />Suspender
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="text-green-600 border-green-300 hover:bg-green-50" onClick={() => onActivate(t.id)}>
                <PlayCircle className="h-3.5 w-3.5 mr-1" />Activar
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Modal crear tenant ────────────────────────────────────────────────────────
function CreateTenantModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ id: "", name: "", plan: "starter", admin_email: "", admin_name: "", admin_password: "" });
  const [error, setError] = useState("");
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm(f => ({ ...f, [k]: e.target.value }));

  const createM = useMutation({
    mutationFn: () => tenantsApi.create(form),
    onSuccess: () => {
      onCreated(); onClose();
      setForm({ id: "", name: "", plan: "starter", admin_email: "", admin_name: "", admin_password: "" });
      toast({ title: "Organización creada", description: `'${form.id}' provisionada correctamente.`, variant: "success" });
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail ?? "Error al crear.";
      setError(typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Nueva organización</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          {[
            { key: "id",             label: "ID (slug)",                placeholder: "mi-empresa",          type: "text" },
            { key: "name",           label: "Nombre de la organización", placeholder: "Mi Empresa S.A.",     type: "text" },
            { key: "admin_email",    label: "Email del admin",           placeholder: "admin@mi-empresa.com",type: "email" },
            { key: "admin_name",     label: "Nombre del admin",          placeholder: "Admin User",           type: "text" },
            { key: "admin_password", label: "Contraseña inicial",        placeholder: "Mínimo 8 caracteres", type: "password" },
          ].map(f => (
            <div key={f.key} className="space-y-1">
              <Label className="text-xs">{f.label}</Label>
              <Input type={f.type} placeholder={f.placeholder} value={(form as any)[f.key]} onChange={set(f.key)} className="h-8 text-sm" />
            </div>
          ))}
          <div className="space-y-1">
            <Label className="text-xs">Plan</Label>
            <select className="w-full text-sm border rounded px-3 py-1.5 bg-background h-8" value={form.plan} onChange={set("plan")}>
              <option value="starter">Starter — 5 usuarios, 500 docs, 5K q/mes</option>
              <option value="professional">Professional — 50 usuarios, 10K docs, 100K q/mes</option>
              <option value="enterprise">Enterprise — Ilimitado</option>
            </select>
          </div>
          {error && <p className="text-xs text-destructive bg-destructive/10 rounded p-2">{error}</p>}
          <p className="text-xs text-muted-foreground">Solo minúsculas, números y guiones en el ID.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={createM.isPending || !form.id || !form.admin_email || !form.admin_password} onClick={() => { setError(""); createM.mutate(); }}>
            {createM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Crear organización
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Modal crear admin en tenant existente ─────────────────────────────────────
function CreateAdminModal({ tenantId, tenantName, onClose, onCreated }: {
  tenantId: string; tenantName: string; onClose: () => void; onCreated: () => void;
}) {
  const [form, setForm] = useState({ email: "", name: "", password: "" });
  const [error, setError] = useState("");
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }));

  const createM = useMutation({
    mutationFn: () => api.tenants.createAdmin(tenantId, form),
    onSuccess: () => {
      onCreated(); onClose();
      toast({ title: "Admin creado", description: `${form.email} puede iniciar sesión como admin de '${tenantId}'.`, variant: "success" });
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail ?? "Error al crear admin.";
      setError(typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Crear admin — {tenantName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {[
            { key: "email",    label: "Email",      placeholder: "admin@empresa.com", type: "email" },
            { key: "name",     label: "Nombre",     placeholder: "Admin Usuario",     type: "text" },
            { key: "password", label: "Contraseña", placeholder: "Mínimo 8 chars",   type: "password" },
          ].map(f => (
            <div key={f.key} className="space-y-1">
              <Label className="text-xs">{f.label}</Label>
              <Input type={f.type} placeholder={f.placeholder} value={(form as any)[f.key]} onChange={set(f.key)} className="h-8 text-sm" />
            </div>
          ))}
          {error && <p className="text-xs text-destructive bg-destructive/10 rounded p-2">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={createM.isPending || !form.email || !form.password} onClick={() => { setError(""); createM.mutate(); }}>
            {createM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Crear admin
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function StatCard({ icon: Icon, label, value }: { icon: any; label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Icon className="h-4 w-4 text-primary" />
          </div>
          <div>
            <p className="text-2xl font-bold leading-none">{value}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}
