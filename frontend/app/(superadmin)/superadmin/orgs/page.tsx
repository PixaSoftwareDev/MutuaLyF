"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  Plus, Loader2, Building2, AlertTriangle, ArrowRight, Bot,
} from "lucide-react";
import { api, apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { FormSheet } from "@/components/layout/form-sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { StatePill, type StatePillTone } from "@/components/ui/state-pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ListToolbar } from "@/components/admin/list-toolbar";
import { useTableSort, applySort, SortHeader } from "@/components/admin/sortable";
import { fmtNum } from "@/components/superadmin/shared";
import { toast } from "@/components/ui/toast";
import { cn, toSlug } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────
interface TenantRow {
  id: string; name: string; plan: string; status: string;
  admin_email: string; created_at: string;
  limits: { users: number; documents: number; queries_month: number };
  usage_30d: { queries: number; ingests: number };
  queries_this_month: number;
  last_activity_at: string | null;
}

type SortKey = "nombre" | "plan" | "estado" | "consultas" | "actividad";

// Última actividad relativa. >14 días sin uso = tenant "dormido" (riesgo de baja).
function relActivity(iso: string | null): string {
  if (!iso) return "sin actividad aún";
  const ms  = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  const h   = Math.floor(min / 60);
  const d   = Math.floor(h / 24);
  if (d >= 14)  return `sin uso hace ${d} d`;
  if (min < 1)  return "activo recién";
  if (min < 60) return `activo hace ${min} min`;
  if (h < 24)   return `activo hace ${h} h`;
  return `activo hace ${d} d`;
}

// Plan → tono de pastilla (reservamos color para estados; el plan queda sobrio).
const PLAN_TONE: Record<string, StatePillTone> = {
  starter:      "muted",
  professional: "info",
  enterprise:   "muted",
};
// Estado → etiqueta ES + tono. Cualquier estado desconocido cae en "muted".
const STATUS_META: Record<string, { label: string; tone: StatePillTone }> = {
  active:     { label: "Activa",     tone: "success" },
  onboarding: { label: "Onboarding", tone: "info" },
  suspended:  { label: "Suspendida", tone: "destructive" },
};

const PLAN_ORDER: Record<string, number> = { starter: 0, professional: 1, enterprise: 2 };

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
  const { sort, toggle } = useTableSort<SortKey>({ consultas: "desc", actividad: "desc" });

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

  const anomalyByTenant = useMemo(() => {
    const map: Record<string, { pct: number; detail: string }> = {};
    for (const a of health?.anomalies ?? []) map[a.tenant_id] = { pct: a.pct, detail: a.detail };
    return map;
  }, [health]);

  const filtered = tenants.filter(t =>
    !search ||
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    t.id.toLowerCase().includes(search.toLowerCase()) ||
    t.admin_email.toLowerCase().includes(search.toLowerCase())
  );

  const sorted = useMemo(() => applySort(filtered, sort, (a, b, key) =>
    key === "nombre"    ? a.name.localeCompare(b.name, "es") :
    key === "plan"      ? (PLAN_ORDER[a.plan] ?? -1) - (PLAN_ORDER[b.plan] ?? -1) :
    key === "estado"    ? a.status.localeCompare(b.status, "es") :
    key === "consultas" ? (a.queries_this_month ?? 0) - (b.queries_this_month ?? 0) :
                          new Date(a.last_activity_at ?? 0).getTime() - new Date(b.last_activity_at ?? 0).getTime(),
  ), [filtered, sort]);

  const hasAnomalies = (health?.anomalies?.length ?? 0) > 0;

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        {/* Header bar */}
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4 sm:px-6">
          <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-foreground">Organizaciones</h1>
          <Button size="sm" className="shrink-0 group" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 transition-transform group-hover:rotate-90 sm:mr-1.5" />
            <span className="hidden sm:inline">Nueva organización</span>
          </Button>
        </div>

        {/* Contenido scrolleable */}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim p-4 sm:p-6">
          {isLoading ? (
            <Skeleton className="h-72 rounded-2xl" />
          ) : (
            <div className="space-y-4">
              {/* Anomalías de cuota — atajos clickeables al detalle */}
              {hasAnomalies && (
                <div className="rounded-xl border border-warning/20 bg-warning/10 px-4 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm">
                  <span className="flex items-center gap-1.5 font-medium">
                    <AlertTriangle className="h-4 w-4 text-warning" /> Cerca del límite del plan:
                  </span>
                  {health!.anomalies.map(a => (
                    <span
                      key={a.tenant_id}
                      role="button"
                      tabIndex={0}
                      className="inline-flex items-center gap-1 text-xs text-warning bg-warning/10 px-2 py-0.5 rounded-full cursor-pointer hover:bg-warning/20 transition-colors"
                      onClick={() => router.push(`/superadmin/tenants/${a.tenant_id}`)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push(`/superadmin/tenants/${a.tenant_id}`); } }}
                    >
                      {a.tenant_name} {a.pct}% cuota
                    </span>
                  ))}
                </div>
              )}

              {tenants.length > 0 && (
                <ListToolbar search={search} onSearch={setSearch} placeholder="Buscar por nombre, ID o email…" />
              )}

              {tenants.length === 0 ? (
                <EmptyState
                  icon={Building2}
                  title="No hay organizaciones"
                  description="Creá la primera organización para empezar."
                />
              ) : sorted.length === 0 ? (
                <EmptyState
                  icon={Building2}
                  title="Sin resultados"
                  description={`Ninguna organización coincide con "${search}".`}
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead><SortHeader label="Organización" sortKey="nombre" sort={sort} onToggle={toggle} /></TableHead>
                      <TableHead className="hidden md:table-cell w-[140px]">
                        <SortHeader label="Plan" sortKey="plan" sort={sort} onToggle={toggle} />
                      </TableHead>
                      <TableHead className="hidden sm:table-cell w-[140px]">
                        <SortHeader label="Estado" sortKey="estado" sort={sort} onToggle={toggle} />
                      </TableHead>
                      <TableHead className="hidden lg:table-cell w-[200px]">
                        <SortHeader label="Consultas 30d" sortKey="consultas" sort={sort} onToggle={toggle} />
                      </TableHead>
                      <TableHead className="hidden xl:table-cell w-[150px] whitespace-nowrap">
                        <SortHeader label="Actividad" sortKey="actividad" sort={sort} onToggle={toggle} />
                      </TableHead>
                      <TableHead className="w-[40px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map(t => (
                      <TenantTableRow
                        key={t.id}
                        tenant={t}
                        anomaly={anomalyByTenant[t.id]}
                        onSelect={() => router.push(`/superadmin/tenants/${t.id}`)}
                        onPrefetch={() => router.prefetch(`/superadmin/tenants/${t.id}`)}
                      />
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
        </div>
      </div>

      <CreateTenantModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={inv} />
    </>
  );
}

// ── Fila de la tabla ──────────────────────────────────────────────────────────
function TenantTableRow({ tenant: t, anomaly, onSelect, onPrefetch }: {
  tenant: TenantRow;
  anomaly?: { pct: number; detail: string };
  onSelect: () => void;
  onPrefetch: () => void;
}) {
  const dormant = !t.last_activity_at || (Date.now() - new Date(t.last_activity_at).getTime()) > 14 * 86_400_000;

  // Consumo del mes vs cuota del plan — de un vistazo, quién está cerca del límite.
  const used  = t.queries_this_month ?? 0;
  const limit = t.limits?.queries_month ?? 0;
  const pct   = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const quotaTone =
    pct === null ? "bg-muted-foreground/40" :
    pct >= 90    ? "bg-destructive" :
    pct >= 70    ? "bg-warning" :
                   "bg-success";

  const statusMeta = STATUS_META[t.status] ?? { label: t.status, tone: "muted" as StatePillTone };

  return (
    <TableRow
      className="cursor-pointer group"
      onClick={onSelect}
      onMouseEnter={onPrefetch}
    >
      {/* w-full + max-w-0: la columna toma el espacio restante y el nombre trunca. */}
      <TableCell className="w-full max-w-0 py-2.5">
        <div className="flex items-center gap-3 min-w-0">
          <div className="shrink-0 w-9 h-9 rounded-lg bg-action-gradient-soft flex items-center justify-center">
            <span className="text-sm font-bold text-action uppercase">{t.name[0]}</span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-foreground truncate group-hover:text-action transition-colors">{t.name}</p>
              {anomaly && (
                <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-warning font-medium">
                  <AlertTriangle className="h-3 w-3" /> {anomaly.pct}% cuota
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {t.admin_email}
              <code className="ml-1.5 text-[10px] text-muted-foreground/50 font-mono hidden sm:inline">{t.id}</code>
            </p>
            {/* Estado/plan en mobile, donde las columnas se ocultan. */}
            <div className="flex items-center gap-2 mt-1 sm:hidden">
              <StatePill tone={statusMeta.tone}>{statusMeta.label}</StatePill>
              <span className="text-[11px] text-muted-foreground capitalize">{t.plan}</span>
            </div>
          </div>
        </div>
      </TableCell>

      <TableCell className="hidden md:table-cell">
        <StatePill tone={PLAN_TONE[t.plan] ?? "muted"} className="capitalize">{t.plan}</StatePill>
      </TableCell>

      <TableCell className="hidden sm:table-cell">
        <StatePill tone={statusMeta.tone}>{statusMeta.label}</StatePill>
      </TableCell>

      <TableCell className="hidden lg:table-cell">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground tabular-nums leading-none">
            {fmtNum(used)}{limit > 0 ? ` / ${fmtNum(limit)}` : ""} consultas
          </span>
          <div className="h-1.5 w-full max-w-[160px] rounded-full bg-muted overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all", quotaTone)}
              style={{ width: `${pct ?? (used > 0 ? 100 : 0)}%` }}
            />
          </div>
        </div>
      </TableCell>

      <TableCell className="hidden xl:table-cell text-sm whitespace-nowrap">
        <span className={cn("text-muted-foreground", dormant && "text-warning font-medium")}>
          {relActivity(t.last_activity_at)}
        </span>
      </TableCell>

      <TableCell className="text-right">
        <ArrowRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-action group-hover:translate-x-0.5 transition-all inline-block" />
      </TableCell>
    </TableRow>
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

  const availablePersonalities = personalities.filter(
    (p: any) => PLAN_ORDER[p.plan_minimo] <= PLAN_ORDER[form.plan]
  );

  const canSubmit = !createM.isPending && form.id && form.name && form.admin_email && form.admin_password && form.personality_id;

  const selectedPersonality = availablePersonalities.find((x: any) => x.id === form.personality_id);

  return (
    <FormSheet
      open={open}
      onOpenChange={v => !v && handleClose()}
      icon={Building2}
      title="Nueva organización"
      description="Datos de la organización y su admin inicial."
      footer={
        <>
          <Button variant="outline" onClick={handleClose}>Cancelar</Button>
          <Button disabled={!canSubmit} onClick={() => { setError(""); createM.mutate(); }}>
            {createM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Crear organización
          </Button>
        </>
      }
    >
        <div className="space-y-4">

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

    </FormSheet>
  );
}
