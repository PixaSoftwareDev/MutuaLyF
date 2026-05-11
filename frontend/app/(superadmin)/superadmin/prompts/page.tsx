"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { Bot, Plus, Pencil, Trash2, Users, Loader2, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";

const PLANS = [
  { value: "starter",      label: "Starter" },
  { value: "professional", label: "Professional" },
  { value: "enterprise",   label: "Enterprise" },
] as const;

const PLAN_COLORS: Record<string, string> = {
  starter:      "bg-slate-100 text-slate-600",
  professional: "bg-blue-100 text-blue-700",
  enterprise:   "bg-violet-100 text-violet-700",
};

const CAT_PALETTE = [
  "bg-slate-100 text-slate-700",
  "bg-blue-100 text-blue-700",
  "bg-green-100 text-green-700",
  "bg-amber-100 text-amber-700",
  "bg-violet-100 text-violet-700",
  "bg-teal-100 text-teal-700",
  "bg-rose-100 text-rose-700",
  "bg-orange-100 text-orange-700",
  "bg-pink-100 text-pink-700",
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

type Template = {
  id: string; nombre: string; descripcion: string | null; categoria: string;
  plan_minimo: string; is_active: boolean; assigned_count: number; active_count: number;
  created_at: string;
};

type TemplateDetail = Template & {
  contenido: string;
  assignments: { id: string; tenant_id: string; tenant_name: string; is_active: boolean; assigned_at: string }[];
};

const emptyForm = { nombre: "", descripcion: "", contenido: "", categoria: "general", plan_minimo: "starter" };

type SystemComponent = { id: string; nombre: string; descripcion: string | null; categoria: string; contenido: string; updated_at: string | null };

export default function PromptsPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<TemplateDetail | null>(null);
  const [selectedSystem, setSelectedSystem] = useState<SystemComponent | null>(null);
  const [showForm, setShowForm]   = useState(false);
  const [editing, setEditing]     = useState<Template | null>(null);
  const [form, setForm]           = useState(emptyForm);
  const [formErr, setFormErr]     = useState("");
  const [assignTenantId, setAssignTenantId] = useState("none");

  const { data: allTemplates = [], isLoading } = useQuery({
    queryKey: ["prompt-templates"],
    queryFn: api.promptTemplates.list,
  });
  const templates = allTemplates;

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
    onSuccess: () => { invalidate(); setSelected(null); toast({ title: "Template eliminado" }); },
  });

  const assignM = useMutation({
    mutationFn: ({ id, tid }: { id: string; tid: string }) =>
      api.promptTemplates.assignToTenants(id, [tid]),
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

  function openCreate() { setForm(emptyForm); setFormErr(""); setEditing(null); setShowForm(true); }
  function openEdit(t: Template) {
    setEditing(t);
    setForm({ nombre: t.nombre, descripcion: t.descripcion ?? "", contenido: "", categoria: t.categoria, plan_minimo: t.plan_minimo });
    setFormErr("");
    setShowForm(true);
  }

  return (
    <div className="h-full flex overflow-hidden">
      {/* ── List ── */}
      <div className="w-80 shrink-0 border-r flex flex-col">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            <h1 className="font-semibold text-base">Bots / Prompts</h1>
          </div>
          <Button size="sm" className="h-7 gap-1" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" /> Nuevo
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y">
          {isLoading && <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
          {templates.map(t => (
            <button
              key={t.id}
              onClick={() => setSelected(t as any)}
              className={cn(
                "w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors",
                selected?.id === t.id && "bg-primary/5 border-l-2 border-primary"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium truncate">{t.nombre}</span>
                {!t.is_active && <Badge variant="outline" className="text-xs text-muted-foreground shrink-0">inactivo</Badge>}
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
          {!isLoading && templates.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              <Bot className="h-8 w-8 mx-auto mb-2 opacity-20" />
              No hay bots creados. Creá el primero.
            </div>
          )}
        </div>

        {/* ── Componentes del sistema (solo lectura, clickeables) ── */}
        {systemComponents.length > 0 && (
          <div className="border-t bg-muted/30 px-4 py-3 space-y-0.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">
              Componentes del sistema
            </p>
            {systemComponents.map(s => {
              const isActive = selectedSystem?.id === s.id && !selected;
              return (
                <button
                  key={s.id}
                  onClick={() => { setSelectedSystem(s); setSelected(null); }}
                  className={cn(
                    "w-full flex items-start gap-2 text-xs rounded px-2 py-1.5 text-left transition-colors",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <span className="mt-1 h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                  <div>
                    <span className="font-medium">{s.nombre}</span>
                    {s.descripcion && <span className="ml-1 opacity-70">— {s.descripcion}</span>}
                  </div>
                </button>
              );
            })}
            <p className="text-[10px] text-muted-foreground/50 pt-1 px-2">
              Corren en background. No son bots de personalidad.
            </p>
          </div>
        )}
      </div>

      {/* ── Detail ── */}
      <div className="flex-1 overflow-y-auto p-6">
        {selectedSystem && !selected && (
          <div className="max-w-2xl space-y-6">
            <div className="flex items-start gap-3">
              <span className="mt-1 h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
              <div>
                <h2 className="text-xl font-bold">{selectedSystem.nombre}</h2>
                {selectedSystem.descripcion && (
                  <p className="text-sm text-muted-foreground mt-1">{selectedSystem.descripcion}</p>
                )}
                <span className="inline-block mt-2 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                  Infraestructura · Solo lectura
                </span>
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Prompt</p>
              <pre className="whitespace-pre-wrap text-sm bg-muted/60 border rounded-lg p-4 font-mono leading-relaxed">
                {selectedSystem.contenido}
              </pre>
            </div>
            {selectedSystem.updated_at && (
              <p className="text-xs text-muted-foreground">
                Última actualización: {new Date(selectedSystem.updated_at).toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric" })}
              </p>
            )}
          </div>
        )}

        {!selected && !selectedSystem && (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            <div className="text-center">
              <Bot className="h-10 w-10 mx-auto mb-3 opacity-20" />
              Seleccioná un template para ver su detalle
            </div>
          </div>
        )}

        {selected && (
          detailLoading ? (
            <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : detail && (
            <div className="max-w-2xl space-y-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-xl font-bold">{detail.nombre}</h2>
                  {detail.descripcion && <p className="text-sm text-muted-foreground mt-1">{detail.descripcion}</p>}
                  <div className="flex gap-2 mt-2">
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
                  <Button variant="outline" size="sm" className="text-destructive hover:text-destructive"
                    onClick={() => { if (confirm("¿Eliminar template?")) deleteM.mutate(detail.id); }}>
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
                  <pre className="text-xs bg-muted rounded-md p-3 whitespace-pre-wrap break-words font-mono leading-relaxed max-h-64 overflow-y-auto">
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
                        <select
                          value={assignTenantId}
                          onChange={e => setAssignTenantId(e.target.value)}
                          className="flex-1 h-8 text-sm border rounded-md px-2 bg-background"
                        >
                          <option value="none">Elegir organización…</option>
                          {available.map((t: any) => (
                            <option key={t.id} value={t.id}>
                              {t.name} ({t.id})
                            </option>
                          ))}
                          {available.length === 0 && (
                            <option disabled>Todas las organizaciones ya tienen este bot</option>
                          )}
                        </select>
                        <Button size="sm" className="h-8 shrink-0"
                          disabled={!assignTenantId || assignTenantId === "none" || assignM.isPending}
                          onClick={() => assignM.mutate({ id: detail.id, tid: assignTenantId })}>
                          {assignM.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Asignar"}
                        </Button>
                      </div>
                    );
                  })()}

                  {detail.assignments.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Sin asignaciones aún.</p>
                  ) : (
                    <div className="divide-y rounded-md border overflow-hidden">
                      {detail.assignments.map(a => (
                        <div key={a.id} className="flex items-center justify-between px-3 py-2">
                          <div>
                            <span className="text-sm font-medium">{a.tenant_name}</span>
                            <span className="ml-2 text-xs text-muted-foreground font-mono">{a.tenant_id}</span>
                            {a.is_active && <Badge className="ml-2 text-xs bg-green-100 text-green-700">activo</Badge>}
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
          )
        )}
      </div>

      {/* ── Create / Edit modal ── */}
      <Dialog open={showForm} onOpenChange={v => !v && setShowForm(false)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Editar template" : "Nuevo template"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1">
              <Label className="text-xs">Nombre</Label>
              <Input value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} placeholder="Bot psicólogo" className="h-9" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Descripción (opcional)</Label>
              <Input value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} placeholder="Asistente empático de apoyo emocional" className="h-9" />
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
                  {categories.map(c => <option key={c} value={c} />)}
                </datalist>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Plan mínimo</Label>
                <select value={form.plan_minimo} onChange={e => setForm(f => ({ ...f, plan_minimo: e.target.value }))}
                  className="w-full h-9 text-sm border rounded-md px-3 bg-background">
                  {PLANS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                Prompt del sistema
                <span className="text-muted-foreground ml-1">({form.contenido.length}/4000 chars)</span>
              </Label>
              <textarea
                value={form.contenido}
                onChange={e => setForm(f => ({ ...f, contenido: e.target.value }))}
                placeholder={"Sos un psicólogo profesional y empático...\nRespondés siempre en primera persona...\nNunca diagnosticás, siempre recomendás consulta profesional..."}
                rows={8}
                maxLength={4000}
                className="w-full text-sm border rounded-md px-3 py-2 bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring font-mono"
              />
            </div>
            {formErr && <p className="text-xs text-destructive">{formErr}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}>Cancelar</Button>
            <Button
              disabled={!form.nombre || !form.contenido || createM.isPending || updateM.isPending}
              onClick={() => { setFormErr(""); editing ? updateM.mutate() : createM.mutate(); }}
            >
              {(createM.isPending || updateM.isPending) && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {editing ? "Guardar cambios" : "Crear template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
