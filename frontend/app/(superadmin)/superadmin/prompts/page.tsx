"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader, CountChip } from "@/components/layout/page-header";
import { Bot, Plus, Pencil, Trash2, Users, Loader2, X, Save, Cpu, ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Constants ──────────────────────────────────────────────────────────────────

const PLANS = [
  { value: "starter",      label: "Starter" },
  { value: "professional", label: "Professional" },
  { value: "enterprise",   label: "Enterprise" },
] as const;

const PLAN_COLORS: Record<string, string> = {
  starter:      "bg-muted text-muted-foreground",
  professional: "bg-blue-100 text-blue-700",
  enterprise:   "bg-violet-100 text-violet-700",
};

const CAT_PALETTE = [
  "bg-slate-100 text-slate-700", "bg-blue-100 text-blue-700", "bg-green-100 text-green-700",
  "bg-amber-100 text-amber-700", "bg-violet-100 text-violet-700", "bg-teal-100 text-teal-700",
  "bg-rose-100 text-rose-700",  "bg-orange-100 text-orange-700", "bg-pink-100 text-pink-700",
  "bg-cyan-100 text-cyan-700",
];

function catColor(cat: string): string {
  let hash = 0;
  for (let i = 0; i < cat.length; i++) hash = (hash * 31 + cat.charCodeAt(i)) & 0xffffffff;
  return CAT_PALETTE[Math.abs(hash) % CAT_PALETTE.length];
}

function catLabel(cat: string): string {
  return cat.charAt(0).toUpperCase() + cat.slice(1).replace(/[_-]/g, " ");
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

  function openCreate() { setForm(emptyForm); setFormErr(""); setEditing(null); setShowForm(true); }
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
        badge={allTemplates.length > 0
          ? <CountChip>{allTemplates.length} {allTemplates.length === 1 ? "personalidad" : "personalidades"}</CountChip>
          : undefined}
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

      {/* ── Tab content — marco card con master-detail ── */}
      <div className="rounded-2xl border bg-card shadow overflow-hidden flex animate-fade-in sm:h-[calc(100dvh-16rem)] sm:min-h-[480px]">

        {/* ═══════════════════════════════════════════════════════════
            TAB: PERSONALIDADES
        ═══════════════════════════════════════════════════════════ */}
        {tab === "personalidades" && (
          <>
            {/* List — hidden on mobile when something is selected */}
            <div className={cn(
              "shrink-0 border-r flex flex-col",
              "w-full sm:w-72",
              selected ? "hidden sm:flex" : "flex"
            )}>
              <div className="px-4 py-3 border-b">
                <p className="text-xs text-muted-foreground leading-snug">
                  Bots que los admins pueden activar para su organización
                </p>
              </div>

              <div className="flex-1 overflow-y-auto divide-y">
                {isLoading && (
                  <div className="flex justify-center py-10">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                )}
                {allTemplates.map((t: Template) => (
                  <button
                    key={t.id}
                    onClick={() => setSelected(t as any)}
                    className={cn(
                      "w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors",
                      selected?.id === t.id && "bg-action/5 border-l-2 border-action"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate">{t.nombre}</span>
                      {!t.is_active && (
                        <Badge variant="outline" className="text-xs text-muted-foreground shrink-0">inactivo</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <span className={cn("text-xs px-1.5 py-0.5 rounded-full font-medium", catColor(t.categoria))}>
                        {catLabel(t.categoria)}
                      </span>
                      <span className={cn("text-xs px-1.5 py-0.5 rounded-full font-medium", PLAN_COLORS[t.plan_minimo])}>
                        {t.plan_minimo}
                      </span>
                      {t.assigned_count > 0 && (
                        <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                          <Users className="h-3 w-3" /> {t.assigned_count}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
                {!isLoading && allTemplates.length === 0 && (
                  <EmptyState
                    icon={Bot}
                    title="No hay personalidades creadas"
                    description="Creá la primera para empezar."
                  />
                )}
              </div>
            </div>

            {/* Detail — full-width on mobile, flex-1 on desktop */}
            <div className={cn(
              "flex-1 overflow-y-auto",
              !selected ? "hidden sm:flex sm:items-center sm:justify-center" : "flex flex-col"
            )}>
              {!selected ? (
                <EmptyState icon={Bot} title="Seleccioná una personalidad para ver su detalle" />
              ) : detailLoading ? (
                <div className="flex justify-center py-20">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : detail && (
                <div className="p-4 sm:p-6 lg:p-8 max-w-3xl w-full mx-auto space-y-6">
                  {/* Mobile back button */}
                  <button
                    onClick={() => setSelected(null)}
                    className="sm:hidden flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
                  >
                    <ChevronLeft className="h-4 w-4" /> Volver
                  </button>

                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-xl font-bold">{detail.nombre}</h2>
                      {detail.descripcion && (
                        <p className="text-sm text-muted-foreground mt-1">{detail.descripcion}</p>
                      )}
                      <div className="flex gap-2 mt-2 flex-wrap">
                        <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", catColor(detail.categoria))}>
                          {catLabel(detail.categoria)}
                        </span>
                        <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", PLAN_COLORS[detail.plan_minimo])}>
                          Plan mínimo: {detail.plan_minimo}
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <Button variant="outline" size="sm" onClick={() => openEdit(detail)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="outline" size="sm" className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget({ id: detail.id, nombre: detail.nombre })}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Prompt del sistema</CardTitle>
                      <CardDescription className="text-xs">{detail.contenido.length} caracteres</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <pre className="text-xs bg-muted rounded-lg p-4 whitespace-pre-wrap break-words font-mono leading-relaxed max-h-96 overflow-y-auto">
                        {detail.contenido}
                      </pre>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Users className="h-4 w-4" /> Asignaciones ({detail.assignments.length})
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {(() => {
                        const assignedIds = new Set(detail.assignments.map((a: any) => a.tenant_id));
                        const available = allTenants.filter((t: any) => !assignedIds.has(t.id));
                        return (
                          <div className="flex gap-2">
                            <Select value={assignTenantId} onValueChange={setAssignTenantId}>
                              <SelectTrigger className="flex-1 h-8 text-sm">
                                <SelectValue placeholder="Elegir organización…" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">Elegir organización…</SelectItem>
                                {available.map((t: any) => (
                                  <SelectItem key={t.id} value={t.id}>{t.name} ({t.id})</SelectItem>
                                ))}
                                {available.length === 0 && (
                                  <SelectItem value="__none__" disabled>Todas las organizaciones ya tienen esta personalidad</SelectItem>
                                )}
                              </SelectContent>
                            </Select>
                            <Button
                              size="sm" className="h-8 shrink-0"
                              disabled={!assignTenantId || assignTenantId === "none" || assignM.isPending}
                              onClick={() => assignM.mutate({ id: detail.id, tid: assignTenantId })}
                            >
                              {assignM.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Asignar"}
                            </Button>
                          </div>
                        );
                      })()}
                      {detail.assignments.length === 0 ? (
                        <p className="text-xs text-muted-foreground">Sin asignaciones aún.</p>
                      ) : (
                        <div className="divide-y rounded-md border overflow-hidden">
                          {detail.assignments.map((a: any) => (
                            <div key={a.id} className="flex items-center justify-between px-3 py-2">
                              <div>
                                <span className="text-sm font-medium">{a.tenant_name}</span>
                                <span className="ml-2 text-xs text-muted-foreground font-mono">{a.tenant_id}</span>
                                {a.is_active && (
                                  <Badge className="ml-2 text-xs bg-success/10 text-success">activo</Badge>
                                )}
                              </div>
                              <button
                                onClick={() => unassignM.mutate({ tenant_id: a.tenant_id, template_id: detail.id })}
                                className="text-muted-foreground hover:text-destructive transition-colors"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              )}
            </div>
          </>
        )}

        {/* ═══════════════════════════════════════════════════════════
            TAB: MOTOR DEL SISTEMA
        ═══════════════════════════════════════════════════════════ */}
        {tab === "motor" && (
          <>
            {/* List — hidden on mobile when something is selected */}
            <div className={cn(
              "shrink-0 border-r flex flex-col",
              "w-full sm:w-72",
              selectedSystem ? "hidden sm:flex" : "flex"
            )}>
              <div className="px-4 py-3 border-b">
                <p className="text-xs text-muted-foreground leading-snug">
                  Prompts de infraestructura interna. Se usan en ingesta, consultas y clustering. No son visibles para los tenants.
                </p>
              </div>

              <div className="flex-1 overflow-y-auto divide-y">
                {systemComponents.map((s: SystemComponent) => {
                  const isSelected = selectedSystem?.id === s.id;
                  const catKey = s.categoria;
                  const label = catKey === "anti_alucinacion" ? "Anti-alucinación"
                    : catKey === "calidad" ? "Ingesta"
                    : catKey === "intenciones" ? "Clustering"
                    : catKey === "asistente" ? "Asistente"
                    : catKey === "sistema" ? "Sistema"
                    : catLabel(catKey);
                  const color = catKey === "anti_alucinacion" ? "bg-warning/10 text-warning"
                    : catKey === "calidad" ? "bg-info/10 text-info"
                    : catKey === "intenciones" ? "bg-violet-100 text-violet-700"
                    : catKey === "sistema" ? "bg-muted text-muted-foreground"
                    : catColor(catKey);

                  return (
                    <button
                      key={s.id}
                      onClick={() => { setSelectedSystem(s); setEditingSystem(false); }}
                      className={cn(
                        "w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors",
                        isSelected && "bg-action/5 border-l-2 border-action"
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="h-1.5 w-1.5 rounded-full bg-success shrink-0" />
                        <span className="text-sm font-medium truncate">{s.nombre}</span>
                      </div>
                      <div className="mt-1 pl-3.5">
                        <span className={cn("text-xs px-1.5 py-0.5 rounded-full font-medium", color)}>
                          {label}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Detail — full-width on mobile, flex-1 on desktop */}
            <div className={cn(
              "flex-1 overflow-y-auto",
              !selectedSystem ? "hidden sm:flex sm:items-center sm:justify-center" : "flex flex-col"
            )}>
              {!selectedSystem ? (
                <EmptyState icon={Cpu} title="Seleccioná un componente para ver su contenido" />
              ) : (
                <div className="p-4 sm:p-6 lg:p-8 max-w-3xl w-full mx-auto space-y-5">
                  {/* Mobile back button */}
                  <button
                    onClick={() => setSelectedSystem(null)}
                    className="sm:hidden flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
                  >
                    <ChevronLeft className="h-4 w-4" /> Volver
                  </button>

                  {/* Header */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <span className="mt-1.5 h-2 w-2 rounded-full bg-success shrink-0" />
                      <div>
                        <h2 className="text-xl font-bold">{selectedSystem.nombre}</h2>
                        {selectedSystem.descripcion && (
                          <p className="text-sm text-muted-foreground mt-1">{selectedSystem.descripcion}</p>
                        )}
                        <span className="inline-block mt-2 text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-success/10 text-success">
                          Infraestructura del sistema
                        </span>
                      </div>
                    </div>
                    {!editingSystem ? (
                      <Button size="sm" variant="outline" className="gap-1.5 shrink-0"
                        onClick={() => { setSystemContent(selectedSystem.contenido); setEditingSystem(true); }}
                      >
                        <Pencil className="h-3.5 w-3.5" /> Editar
                      </Button>
                    ) : (
                      <div className="flex gap-2 shrink-0">
                        <Button size="sm" variant="outline" onClick={() => setEditingSystem(false)}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm" className="gap-1.5"
                          disabled={systemSaveDisabled}
                          onClick={() => systemUpdateM.mutate({ id: selectedSystem.id, contenido: systemContent })}
                        >
                          {systemUpdateM.isPending
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Save className="h-3.5 w-3.5" />}
                          Guardar
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Content */}
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Prompt</p>
                    {editingSystem ? (
                      <Textarea
                        value={systemContent}
                        onChange={e => setSystemContent(e.target.value)}
                        className="font-mono text-sm leading-relaxed min-h-[400px]"
                        placeholder="Contenido del prompt…"
                      />
                    ) : (
                      <pre className="whitespace-pre-wrap text-sm bg-muted/60 border rounded-lg p-4 font-mono leading-relaxed">
                        {selectedSystem.contenido}
                      </pre>
                    )}
                  </div>

                  {selectedSystem.updated_at && !editingSystem && (
                    <p className="text-xs text-muted-foreground">
                      Última actualización:{" "}
                      {new Date(selectedSystem.updated_at).toLocaleDateString("es-AR", {
                        day: "numeric", month: "long", year: "numeric",
                      })}
                    </p>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Create / Edit modal (Personalidades) ── */}
      <Dialog open={showForm} onOpenChange={v => !v && setShowForm(false)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Editar personalidad" : "Nueva personalidad"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1">
              <Label className="text-xs">Nombre</Label>
              <Input
                value={form.nombre}
                onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))}
                placeholder="Bot de ventas"
                className="h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Descripción (opcional)</Label>
              <Input
                value={form.descripcion}
                onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))}
                placeholder="Asistente para el equipo comercial"
                className="h-9"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Categoría</Label>
                <input
                  list="cat-options"
                  value={form.categoria}
                  onChange={e => setForm(f => ({ ...f, categoria: e.target.value.toLowerCase().replace(/\s+/g, "_") }))}
                  placeholder="general, ventas, rrhh…"
                  className="w-full h-9 text-sm border rounded-md px-3 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <datalist id="cat-options">
                  {categories.map((c: string) => <option key={c} value={c} />)}
                </datalist>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Plan mínimo</Label>
                <Select
                  value={form.plan_minimo}
                  onValueChange={v => setForm(f => ({ ...f, plan_minimo: v }))}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLANS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                Prompt del sistema
                <span className="text-muted-foreground ml-1">({form.contenido.length}/4000 chars)</span>
              </Label>
              <Textarea
                value={form.contenido}
                onChange={e => setForm(f => ({ ...f, contenido: e.target.value }))}
                placeholder={"Sos un asistente comercial...\nRespondés siempre en tono profesional...\nSolo respondés sobre productos y precios..."}
                rows={8}
                maxLength={4000}
                className="text-sm resize-none font-mono"
              />
            </div>
            {formErr && <p className="text-xs text-destructive">{formErr}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}>Cancelar</Button>
            <Button
              disabled={formSaveDisabled}
              onClick={() => { setFormErr(""); editing ? updateM.mutate() : createM.mutate(); }}
            >
              {(createM.isPending || updateM.isPending) && (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              )}
              {editing ? "Guardar cambios" : "Crear personalidad"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
