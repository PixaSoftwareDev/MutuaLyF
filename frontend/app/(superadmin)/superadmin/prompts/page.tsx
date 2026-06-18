"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";
import { Bot, Plus, Pencil, Trash2, Users, Loader2, X, Save, Cpu, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Constants ──────────────────────────────────────────────────────────────────

const PLANS = [
  { value: "starter",      label: "Starter" },
  { value: "professional", label: "Professional" },
  { value: "enterprise",   label: "Enterprise" },
] as const;

const PLAN_COLORS: Record<string, string> = {
  starter:      "bg-muted text-muted-foreground",
  professional: "bg-info/10 text-info",
  enterprise:   "bg-action-gradient-soft text-action",
};

// Paleta sobria sobre tokens del sistema (no colores tailwind -100 sueltos).
const CAT_PALETTE = [
  "bg-muted text-muted-foreground",
  "bg-action-gradient-soft text-action",
  "bg-info/10 text-info",
  "bg-success/10 text-success",
  "bg-warning/10 text-warning",
];

function catColor(cat: string): string {
  let hash = 0;
  for (let i = 0; i < cat.length; i++) hash = (hash * 31 + cat.charCodeAt(i)) & 0xffffffff;
  return CAT_PALETTE[Math.abs(hash) % CAT_PALETTE.length];
}

function catLabel(cat: string): string {
  return cat.charAt(0).toUpperCase() + cat.slice(1).replace(/[_-]/g, " ");
}

// Etiqueta y color de los componentes del motor (categorías internas fijas).
function sysLabel(catKey: string): string {
  return catKey === "anti_alucinacion" ? "Anti-alucinación"
    : catKey === "calidad" ? "Ingesta"
    : catKey === "intenciones" ? "Clustering"
    : catKey === "asistente" ? "Asistente"
    : catKey === "sistema" ? "Sistema"
    : catLabel(catKey);
}

function sysColor(catKey: string): string {
  return catKey === "anti_alucinacion" ? "bg-warning/10 text-warning"
    : catKey === "calidad" ? "bg-info/10 text-info"
    : catKey === "intenciones" ? "bg-action-gradient-soft text-action"
    : catKey === "sistema" ? "bg-muted text-muted-foreground"
    : catColor(catKey);
}

// ── Types ──────────────────────────────────────────────────────────────────────

type Template = {
  id: string; nombre: string; descripcion: string | null; categoria: string;
  plan_minimo: string; is_active: boolean; assigned_count: number; active_count: number;
  created_at: string;
};

type TemplateDetail = Template & {
  contenido: string;
  assigned_count: number;
  active_count: number;
  assignments: { id: string; tenant_id: string; tenant_name: string; is_active: boolean; assigned_at: string }[];
};

type SystemComponent = {
  id: string; nombre: string; descripcion: string | null; categoria: string;
  contenido: string; updated_at: string | null;
};

const emptyForm = { nombre: "", descripcion: "", contenido: "", categoria: "general", plan_minimo: "starter" };

// ── Main page ──────────────────────────────────────────────────────────────────

export default function PromptsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"personalidades" | "motor">("personalidades");

  // Personalidades tab state
  const [selected, setSelected] = useState<TemplateDetail | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formErr, setFormErr] = useState("");
  const [assignTenantId, setAssignTenantId] = useState("none");
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; nombre: string } | null>(null);

  // Motor tab state
  const [selectedSystem, setSelectedSystem] = useState<SystemComponent | null>(null);
  const [editingSystem, setEditingSystem] = useState(false);
  const [systemContent, setSystemContent] = useState("");

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: allTemplates = [], isLoading } = useQuery({
    queryKey: ["prompt-templates"],
    queryFn: api.promptTemplates.list,
  });

  const { data: systemComponents = [] } = useQuery({
    queryKey: ["system-components"],
    queryFn: api.promptTemplates.listSystemComponents,
    staleTime: 300_000,
  });

  const { data: categories = [] } = useQuery({
    queryKey: ["prompt-categories"],
    queryFn: api.promptTemplates.listCategories,
    staleTime: 60_000,
  });

  const { data: trafficData } = useQuery({
    queryKey: ["platform-traffic"],
    queryFn: api.tenants.platformTraffic,
    staleTime: 120_000,
  });
  const allTenants = trafficData?.per_tenant ?? [];

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ["prompt-template", selected?.id],
    queryFn: () => api.promptTemplates.get(selected!.id),
    enabled: !!selected,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["prompt-templates"] });
    qc.invalidateQueries({ queryKey: ["prompt-template", selected?.id] });
    qc.invalidateQueries({ queryKey: ["prompt-categories"] });
  };

  const createM = useMutation({
    mutationFn: () => api.promptTemplates.create(form as any),
    onSuccess: () => { invalidate(); setShowForm(false); setForm(emptyForm); toast({ title: "Template creado", variant: "success" }); },
    onError: (e: any) => setFormErr(e?.response?.data?.detail ?? "Error al crear"),
  });

  const updateM = useMutation({
    mutationFn: () => api.promptTemplates.update(editing!.id, form as any),
    onSuccess: () => { invalidate(); setEditing(null); setForm(emptyForm); toast({ title: "Template actualizado", variant: "success" }); },
    onError: (e: any) => setFormErr(e?.response?.data?.detail ?? "Error al actualizar"),
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => api.promptTemplates.delete(id),
    onSuccess: () => { invalidate(); setSelected(null); setDeleteTarget(null); toast({ title: "Template eliminado" }); },
  });

  const assignM = useMutation({
    mutationFn: ({ id, tid }: { id: string; tid: string }) => api.promptTemplates.assignToTenants(id, [tid]),
    onSuccess: (data) => {
      invalidate();
      if (data.errors.length > 0) toast({ title: data.errors[0].error, variant: "destructive" });
      else toast({ title: "Asignado correctamente", variant: "success" });
      setAssignTenantId("none");
    },
  });

  const unassignM = useMutation({
    mutationFn: ({ tenant_id, template_id }: { tenant_id: string; template_id: string }) =>
      api.promptTemplates.unassign(tenant_id, template_id),
    onSuccess: () => { invalidate(); toast({ title: "Asignación removida" }); },
  });

  const systemUpdateM = useMutation({
    mutationFn: ({ id, contenido }: { id: string; contenido: string }) =>
      api.promptTemplates.update(id, { contenido } as any),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["system-components"] });
      setEditingSystem(false);
      if (selectedSystem) setSelectedSystem({ ...selectedSystem, contenido: systemContent });
      toast({ title: "Componente actualizado", variant: "success" });
    },
    onError: (e: any) => toast({ title: e?.response?.data?.detail ?? "Error al guardar", variant: "destructive" }),
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function openCreate() { setForm(emptyForm); setFormErr(""); setEditing(null); setSelected(null); setShowForm(true); }
  function openEdit(t: Pick<Template, "id" | "nombre" | "descripcion" | "categoria" | "plan_minimo">) {
    setEditing(t as Template);
    setForm({ nombre: t.nombre, descripcion: t.descripcion ?? "", contenido: "", categoria: t.categoria, plan_minimo: t.plan_minimo });
    setFormErr("");
    setShowForm(true);
  }

  const systemSaveDisabled = !editingSystem || !selectedSystem || systemUpdateM.isPending;

  const formSaveDisabled = !form.nombre || !form.contenido || createM.isPending || updateM.isPending;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <PageShell>
      {/* Cabecera estándar — misma identidad que el resto del back-office */}
      <PageHeader
        eyebrow="Plataforma"
        title="Bots y prompts"
        description="Las personalidades que los admins pueden activar y los prompts internos del motor."
        actions={tab === "personalidades" ? (
          <Button size="sm" className="h-9 gap-1.5 group" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5 transition-transform group-hover:rotate-90" />
            <span className="hidden sm:inline">Nueva personalidad</span>
          </Button>
        ) : undefined}
      />

      {/* Tabs estándar */}
      <Tabs value={tab} onValueChange={v => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="personalidades" className="gap-1.5">
            <Bot className="h-3.5 w-3.5" /> Personalidades
            {allTemplates.length > 0 && (
              <span className="ml-0.5 text-[10px] font-bold bg-muted px-1.5 py-0.5 rounded-full tabular-nums">{allTemplates.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="motor" className="gap-1.5">
            <Cpu className="h-3.5 w-3.5" /> Motor del sistema
            {systemComponents.length > 0 && (
              <span className="ml-0.5 text-[10px] font-bold bg-muted px-1.5 py-0.5 rounded-full tabular-nums">{systemComponents.length}</span>
            )}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* ═══════════════════════════════════════════════════════════
          TAB: PERSONALIDADES — grid de cards; detalle en panel lateral
      ═══════════════════════════════════════════════════════════ */}
      {tab === "personalidades" && (
        showForm ? (
          /* ── Crear / editar personalidad — vista a pantalla completa ── */
          <div className="animate-fade-in space-y-5 max-w-3xl">
            <Button variant="ghost" size="sm" className="gap-1.5 -ml-2 text-muted-foreground" onClick={() => { setShowForm(false); setEditing(null); }}>
              <ArrowLeft className="h-4 w-4" /> {editing ? "Volver al detalle" : "Volver al listado"}
            </Button>
            <h2 className="text-xl font-bold tracking-tight">{editing ? "Editar personalidad" : "Nueva personalidad"}</h2>

            <div className="rounded-2xl border bg-card shadow-sm p-5 space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Nombre</Label>
                <Input value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} placeholder="Bot de ventas" className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Descripción <span className="font-normal text-muted-foreground">· opcional</span></Label>
                <Input value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} placeholder="Asistente para el equipo comercial" className="h-9" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Categoría</Label>
                  <input
                    list="cat-options"
                    value={form.categoria}
                    onChange={e => setForm(f => ({ ...f, categoria: e.target.value.toLowerCase().replace(/\s+/g, "_") }))}
                    placeholder="general, ventas, rrhh…"
                    className="w-full h-9 text-sm border rounded-md px-3 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <datalist id="cat-options">{categories.map((c: string) => <option key={c} value={c} />)}</datalist>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Plan mínimo</Label>
                  <Select value={form.plan_minimo} onValueChange={v => setForm(f => ({ ...f, plan_minimo: v }))}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>{PLANS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">
                  Prompt del sistema <span className="font-normal text-muted-foreground">· {form.contenido.length}/4000</span>
                </Label>
                <Textarea
                  value={form.contenido}
                  onChange={e => setForm(f => ({ ...f, contenido: e.target.value }))}
                  placeholder={"Sos un asistente comercial...\nRespondés siempre en tono profesional...\nSolo respondés sobre productos y precios..."}
                  maxLength={4000}
                  className="text-sm font-mono leading-relaxed min-h-[320px]"
                />
              </div>
              {formErr && <p className="text-xs text-destructive">{formErr}</p>}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setShowForm(false); setEditing(null); }}>Cancelar</Button>
              <Button disabled={formSaveDisabled} onClick={() => { setFormErr(""); editing ? updateM.mutate() : createM.mutate(); }}>
                {(createM.isPending || updateM.isPending) && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                {editing ? "Guardar cambios" : "Crear personalidad"}
              </Button>
            </div>
          </div>
        ) : selected ? (
          /* ── Detalle de personalidad — vista a pantalla completa ── */
          <div className="animate-fade-in space-y-5">
            <Button variant="ghost" size="sm" className="gap-1.5 -ml-2 text-muted-foreground" onClick={() => setSelected(null)}>
              <ArrowLeft className="h-4 w-4" /> Volver al listado
            </Button>

            {detailLoading || !detail ? (
              <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex items-start gap-3 min-w-0">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-action-gradient-soft">
                      <Bot className="h-5 w-5 text-action" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h2 className="text-xl font-bold tracking-tight">{detail.nombre}</h2>
                        {!detail.is_active && (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Inactivo</span>
                        )}
                      </div>
                      {detail.descripcion && <p className="mt-0.5 text-sm text-muted-foreground">{detail.descripcion}</p>}
                      <div className="mt-2 flex gap-1.5 flex-wrap">
                        <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", catColor(detail.categoria))}>{catLabel(detail.categoria)}</span>
                        <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", PLAN_COLORS[detail.plan_minimo])}>Plan mínimo: {detail.plan_minimo}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button variant="outline" size="sm" className="gap-1.5" onClick={() => openEdit(detail)}>
                      <Pencil className="h-3.5 w-3.5" /> Editar
                    </Button>
                    <Button variant="outline" size="sm" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => setDeleteTarget({ id: detail.id, nombre: detail.nombre })}>
                      <Trash2 className="h-3.5 w-3.5" /> Eliminar
                    </Button>
                  </div>
                </div>

                {/* Prompt */}
                <div className="rounded-2xl border bg-card overflow-hidden">
                  <div className="flex items-center justify-between gap-2 px-4 py-3 border-b bg-muted/20">
                    <span className="text-sm font-semibold">Prompt del sistema</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{detail.contenido.length} caracteres</span>
                  </div>
                  <pre className="text-xs bg-muted/40 p-4 whitespace-pre-wrap break-words font-mono leading-relaxed">{detail.contenido}</pre>
                </div>

                {/* Asignaciones */}
                <div className="rounded-2xl border bg-card overflow-hidden">
                  <div className="flex items-center gap-2.5 px-4 py-3 border-b bg-muted/20">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-action-gradient-soft shrink-0">
                      <Users className="h-3.5 w-3.5 text-action" />
                    </span>
                    <span className="text-sm font-semibold">Asignaciones</span>
                    <span className="text-xs text-muted-foreground">
                      {detail.assignments.length} {detail.assignments.length === 1 ? "organización" : "organizaciones"}
                    </span>
                  </div>
                  <div className="p-4 space-y-3">
                    {(() => {
                      const assignedIds = new Set(detail.assignments.map((a: any) => a.tenant_id));
                      const available = allTenants.filter((t: any) => !assignedIds.has(t.id));
                      return (
                        <div className="flex gap-2">
                          <Select value={assignTenantId} onValueChange={setAssignTenantId}>
                            <SelectTrigger className="flex-1 h-9 text-sm"><SelectValue placeholder="Elegir organización…" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">Elegir organización…</SelectItem>
                              {available.map((t: any) => <SelectItem key={t.id} value={t.id}>{t.name} ({t.id})</SelectItem>)}
                              {available.length === 0 && <SelectItem value="__none__" disabled>Todas ya tienen esta personalidad</SelectItem>}
                            </SelectContent>
                          </Select>
                          <Button size="sm" className="h-9 shrink-0" disabled={!assignTenantId || assignTenantId === "none" || assignM.isPending} onClick={() => assignM.mutate({ id: detail.id, tid: assignTenantId })}>
                            {assignM.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Asignar"}
                          </Button>
                        </div>
                      );
                    })()}
                    {detail.assignments.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Sin asignaciones aún.</p>
                    ) : (
                      <div className="divide-y rounded-lg border overflow-hidden">
                        {detail.assignments.map((a: any) => (
                          <div key={a.id} className="flex items-center justify-between gap-2 px-3 py-2">
                            <div className="min-w-0">
                              <span className="text-sm font-medium">{a.tenant_name}</span>
                              <span className="ml-2 text-xs text-muted-foreground font-mono">{a.tenant_id}</span>
                              {a.is_active && <Badge className="ml-2 text-xs bg-success/10 text-success">activo</Badge>}
                            </div>
                            <button onClick={() => unassignM.mutate({ tenant_id: a.tenant_id, template_id: detail.id })} className="text-muted-foreground hover:text-destructive transition-colors shrink-0">
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          /* ── Grid de personalidades ── */
          <div className="animate-fade-in">
            {isLoading ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {[1, 2, 3].map(i => <div key={i} className="h-36 rounded-2xl border bg-card animate-pulse" />)}
              </div>
            ) : allTemplates.length === 0 ? (
              <EmptyState icon={Bot} title="No hay personalidades creadas" description="Creá la primera para empezar." className="rounded-2xl border bg-card" />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {allTemplates.map((t: Template) => (
                  <button
                    key={t.id}
                    onClick={() => setSelected(t as any)}
                    className="group text-left rounded-2xl border bg-card shadow-sm p-4 transition-shadow hover:shadow-md card-interactive"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-action-gradient-soft">
                          <Bot className="h-4 w-4 text-action" />
                        </span>
                        <div className="min-w-0">
                          <p className="font-semibold truncate leading-tight">{t.nombre}</p>
                          {t.descripcion && <p className="mt-0.5 text-xs text-muted-foreground truncate">{t.descripcion}</p>}
                        </div>
                      </div>
                      {!t.is_active && (
                        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Inactivo</span>
                      )}
                    </div>
                    <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                      <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", catColor(t.categoria))}>{catLabel(t.categoria)}</span>
                      <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", PLAN_COLORS[t.plan_minimo])}>{t.plan_minimo}</span>
                    </div>
                    <div className="mt-3 flex items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
                      <Users className="h-3.5 w-3.5 shrink-0" />
                      {t.assigned_count === 0 ? "Sin asignar" : `${t.assigned_count} ${t.assigned_count === 1 ? "organización" : "organizaciones"}`}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      )}

      {/* ═══════════════════════════════════════════════════════════
          TAB: MOTOR DEL SISTEMA — master-detail (editar prompts internos)
      ═══════════════════════════════════════════════════════════ */}
      {tab === "motor" && (
        selectedSystem ? (
          /* ── Detalle / edición de componente del motor — pantalla completa ── */
          <div className="animate-fade-in space-y-5">
            <Button variant="ghost" size="sm" className="gap-1.5 -ml-2 text-muted-foreground" onClick={() => { setSelectedSystem(null); setEditingSystem(false); }}>
              <ArrowLeft className="h-4 w-4" /> Volver al listado
            </Button>

            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-start gap-3 min-w-0">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-action-gradient-soft">
                  <Cpu className="h-5 w-5 text-action" />
                </span>
                <div className="min-w-0">
                  <h2 className="text-xl font-bold tracking-tight">{selectedSystem.nombre}</h2>
                  {selectedSystem.descripcion && <p className="mt-0.5 text-sm text-muted-foreground">{selectedSystem.descripcion}</p>}
                  <div className="mt-2 flex gap-1.5 flex-wrap">
                    <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", sysColor(selectedSystem.categoria))}>{sysLabel(selectedSystem.categoria)}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-success/10 text-success">Infraestructura del sistema</span>
                  </div>
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                {!editingSystem ? (
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { setSystemContent(selectedSystem.contenido); setEditingSystem(true); }}>
                    <Pencil className="h-3.5 w-3.5" /> Editar
                  </Button>
                ) : (
                  <>
                    <Button variant="outline" size="sm" onClick={() => setEditingSystem(false)}>Cancelar</Button>
                    <Button size="sm" className="gap-1.5" disabled={systemSaveDisabled} onClick={() => systemUpdateM.mutate({ id: selectedSystem.id, contenido: systemContent })}>
                      {systemUpdateM.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Guardar
                    </Button>
                  </>
                )}
              </div>
            </div>

            <div className="rounded-2xl border bg-card overflow-hidden">
              <div className="px-4 py-3 border-b bg-muted/20 text-sm font-semibold">Prompt</div>
              {editingSystem ? (
                <div className="p-4">
                  <Textarea value={systemContent} onChange={e => setSystemContent(e.target.value)} className="font-mono text-sm leading-relaxed min-h-[420px]" placeholder="Contenido del prompt…" />
                </div>
              ) : (
                <pre className="text-sm bg-muted/40 p-4 whitespace-pre-wrap break-words font-mono leading-relaxed">{selectedSystem.contenido}</pre>
              )}
            </div>

            {selectedSystem.updated_at && !editingSystem && (
              <p className="text-xs text-muted-foreground">
                Última actualización: {new Date(selectedSystem.updated_at).toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric" })}
              </p>
            )}
          </div>
        ) : (
          /* ── Grid del motor ── */
          <div className="animate-fade-in space-y-3">
            <p className="text-xs text-muted-foreground">
              Prompts de infraestructura interna (ingesta, consultas, clustering). No son visibles para los clientes.
            </p>
            {systemComponents.length === 0 ? (
              <EmptyState icon={Cpu} title="No hay componentes del motor" className="rounded-2xl border bg-card" />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {systemComponents.map((s: SystemComponent) => (
                  <button
                    key={s.id}
                    onClick={() => { setSelectedSystem(s); setEditingSystem(false); }}
                    className="group text-left rounded-2xl border bg-card shadow-sm p-4 transition-shadow hover:shadow-md card-interactive"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-action-gradient-soft">
                          <Cpu className="h-4 w-4 text-action" />
                        </span>
                        <div className="min-w-0">
                          <p className="font-semibold truncate leading-tight">{s.nombre}</p>
                          {s.descripcion && <p className="mt-0.5 text-xs text-muted-foreground truncate">{s.descripcion}</p>}
                        </div>
                      </div>
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-success" title="Activo" />
                    </div>
                    <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                      <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", sysColor(s.categoria))}>{sysLabel(s.categoria)}</span>
                    </div>
                    <div className="mt-3 flex items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
                      <Cpu className="h-3.5 w-3.5 shrink-0" /> {s.contenido.length} caracteres
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      )}

      {/* ── Confirmación de borrado ── */}
      <Dialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)}>
        <DialogContent className="w-full max-w-sm mx-4 sm:mx-auto">
          <DialogHeader>
            <div className="flex items-start gap-3 text-left">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
                <Trash2 className="h-5 w-5 text-destructive" />
              </div>
              <div className="min-w-0 space-y-1.5 pt-0.5">
                <DialogTitle>Eliminar personalidad</DialogTitle>
                <p className="text-sm text-muted-foreground">
                  ¿Seguro que querés eliminar{" "}
                  <span className="font-medium text-foreground">{deleteTarget?.nombre}</span>?
                  Esta acción no se puede deshacer.
                </p>
              </div>
            </div>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => setDeleteTarget(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive" className="w-full sm:w-auto"
              disabled={deleteM.isPending}
              onClick={() => { if (deleteTarget) deleteM.mutate(deleteTarget.id); }}
            >
              {deleteM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Sí, eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
