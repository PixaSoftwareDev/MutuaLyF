"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PLANS, PLAN_COLORS, catColor, catLabel } from "@/components/superadmin/prompt-meta";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { FormSheet } from "@/components/layout/form-sheet";
import { ListToolbar } from "@/components/admin/list-toolbar";
import { ListDetailShell, DetailPanelHeader, PanelIconButton } from "@/components/admin/list-detail-shell";
import { useTableSort, applySort, SortHeader } from "@/components/admin/sortable";
import { Skeleton } from "@/components/ui/skeleton";
import { Bot, Plus, Pencil, Trash2, Users, Loader2, X, FlaskConical, Send, PanelRight, SearchX } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Constants ──────────────────────────────────────────────────────────────────

// ── Types ──────────────────────────────────────────────────────────────────────

type Template = {
  id: string; nombre: string; descripcion: string | null; categoria: string;
  plan_minimo: string; is_active: boolean; assigned_count: number; active_count: number;
  created_at: string;
};

type TemplateDetail = {
  id: string; nombre: string; descripcion: string | null; categoria: string;
  plan_minimo: string; is_active: boolean; contenido: string;
  assignments: { id: string; tenant_id: string; tenant_name: string; is_active: boolean; assigned_at: string }[];
};

type SortKey = "nombre" | "asignaciones";

const emptyForm = { nombre: "", descripcion: "", contenido: "", categoria: "general", plan_minimo: "starter" };

// ── Main page ──────────────────────────────────────────────────────────────────

export default function PersonalidadesPage() {
  const qc = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen]   = useState(false);
  const [search, setSearch]         = useState("");
  const { sort, toggle } = useTableSort<SortKey>({ nombre: "asc" });

  const [showForm, setShowForm]     = useState(false);
  const [editing, setEditing]       = useState<{ id: string } | null>(null);
  const [form, setForm]             = useState(emptyForm);
  const [formErr, setFormErr]       = useState("");
  const [assignTenantId, setAssignTenantId] = useState("none");
  const [deleteTarget, setDeleteTarget]     = useState<{ id: string; nombre: string } | null>(null);
  const [testTarget, setTestTarget]         = useState<{ nombre: string; contenido: string } | null>(null);

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: allTemplates = [], isLoading } = useQuery({
    queryKey: ["prompt-templates"],
    queryFn: api.promptTemplates.list,
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
    queryKey: ["prompt-template", selectedId],
    queryFn: () => api.promptTemplates.get(selectedId!),
    enabled: !!selectedId,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["prompt-templates"] });
    qc.invalidateQueries({ queryKey: ["prompt-template", selectedId] });
    qc.invalidateQueries({ queryKey: ["prompt-categories"] });
  };

  const createM = useMutation({
    mutationFn: () => api.promptTemplates.create(form as any),
    onSuccess: () => { invalidate(); setShowForm(false); setForm(emptyForm); toast({ title: "Personalidad creada", variant: "success" }); },
    onError: (e: any) => setFormErr(e?.response?.data?.detail ?? "Error al crear"),
  });
  const updateM = useMutation({
    mutationFn: () => api.promptTemplates.update(editing!.id, form as any),
    onSuccess: () => { invalidate(); setShowForm(false); setEditing(null); setForm(emptyForm); toast({ title: "Personalidad actualizada", variant: "success" }); },
    onError: (e: any) => setFormErr(e?.response?.data?.detail ?? "Error al actualizar"),
  });
  const deleteM = useMutation({
    mutationFn: (id: string) => api.promptTemplates.delete(id),
    onSuccess: () => { invalidate(); setSelectedId(null); setDeleteTarget(null); toast({ title: "Personalidad eliminada" }); },
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

  // ── Helpers ────────────────────────────────────────────────────────────────

  function openCreate() { setForm(emptyForm); setFormErr(""); setEditing(null); setShowForm(true); }
  function openEdit(t: TemplateDetail) {
    setEditing(t);
    setForm({ nombre: t.nombre, descripcion: t.descripcion ?? "", contenido: t.contenido, categoria: t.categoria, plan_minimo: t.plan_minimo });
    setFormErr("");
    setShowForm(true);
  }

  const formSaveDisabled = !form.nombre || !form.contenido || createM.isPending || updateM.isPending;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allTemplates;
    return allTemplates.filter((t: Template) =>
      t.nombre.toLowerCase().includes(q) || (t.descripcion ?? "").toLowerCase().includes(q) || t.categoria.toLowerCase().includes(q));
  }, [allTemplates, search]);

  const sorted = useMemo(() => applySort(filtered, sort, (a: Template, b: Template, key) =>
    key === "nombre" ? a.nombre.localeCompare(b.nombre, "es") : a.assigned_count - b.assigned_count,
  ), [filtered, sort]);

  const selected = allTemplates.find((t: Template) => t.id === selectedId) ?? null;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <ListDetailShell
        title="Personalidades"
        actions={
          <Button size="sm" className="shrink-0" onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" /> Nueva personalidad
          </Button>
        }
        panelTitle="personalidad"
        open={panelOpen}
        hasSelection={!!selected}
        onExpand={() => setPanelOpen(true)}
        panel={selected ? (
          <PersonalityDetailPanel
            detail={detail && detail.id === selected.id ? detail : null}
            loading={detailLoading}
            allTenants={allTenants}
            assignTenantId={assignTenantId}
            onAssignTenantChange={setAssignTenantId}
            onAssign={() => detail && assignM.mutate({ id: detail.id, tid: assignTenantId })}
            assignBusy={assignM.isPending}
            onUnassign={(tid) => detail && unassignM.mutate({ tenant_id: tid, template_id: detail.id })}
            onCollapse={() => setPanelOpen(false)}
            onEdit={() => detail && openEdit(detail)}
            onTest={() => detail && setTestTarget({ nombre: detail.nombre, contenido: detail.contenido })}
            onDelete={() => detail && setDeleteTarget({ id: detail.id, nombre: detail.nombre })}
          />
        ) : null}
      >
        {isLoading ? (
          <Skeleton className="h-72 rounded-2xl" />
        ) : (
          <div className="space-y-4">
            {allTemplates.length > 0 && (
              <ListToolbar search={search} onSearch={setSearch} placeholder="Buscar personalidad…" />
            )}

            {allTemplates.length === 0 ? (
              <EmptyState icon={Bot} title="No hay personalidades creadas"
                description="Creá la primera para que los admins puedan activarla en su bot." />
            ) : filtered.length === 0 ? (
              <EmptyState icon={SearchX} title="Sin resultados" description={`Ninguna coincide con "${search}".`} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead><SortHeader label="Personalidad" sortKey="nombre" sort={sort} onToggle={toggle} /></TableHead>
                    <TableHead className="hidden md:table-cell">Categoría</TableHead>
                    <TableHead className="hidden sm:table-cell">Plan mín.</TableHead>
                    <TableHead className="whitespace-nowrap text-right">
                      <SortHeader label="Asignaciones" sortKey="asignaciones" sort={sort} onToggle={toggle} />
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((t: Template) => (
                    <TableRow
                      key={t.id}
                      onClick={() => { setSelectedId(t.id); setPanelOpen(true); }}
                      aria-selected={t.id === selectedId}
                      className={cn("cursor-pointer", t.id === selectedId && "bg-muted/60")}
                    >
                      <TableCell className="w-full max-w-0">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                            <Bot className="h-4 w-4 text-muted-foreground" />
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate font-medium text-foreground">{t.nombre}</span>
                              {!t.is_active && <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">Inactivo</span>}
                            </div>
                            {t.descripcion && <p className="truncate text-xs text-muted-foreground">{t.descripcion}</p>}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", catColor(t.categoria))}>{catLabel(t.categoria)}</span>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium capitalize", PLAN_COLORS[t.plan_minimo] || "bg-muted")}>{t.plan_minimo}</span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                          <Users className="h-4 w-4 text-muted-foreground/70" />
                          <span className="font-semibold tabular-nums text-foreground">{t.assigned_count}</span>
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </ListDetailShell>

      {/* Crear / editar — FormSheet roomy (soporta el prompt grande sin descompaginar) */}
      <FormSheet
        open={showForm}
        onOpenChange={(v) => { if (!v) { setShowForm(false); setEditing(null); } }}
        icon={Bot}
        title={editing ? "Editar personalidad" : "Nueva personalidad"}
        description="Nombre, categoría, plan mínimo y el prompt del sistema."
        footer={
          <>
            <Button
              variant="outline" className="mr-auto gap-1.5"
              disabled={form.contenido.trim().length < 10}
              onClick={() => setTestTarget({ nombre: form.nombre || "Borrador", contenido: form.contenido })}
            >
              <FlaskConical className="h-4 w-4" /> Probar
            </Button>
            <Button variant="outline" onClick={() => { setShowForm(false); setEditing(null); }}>Cancelar</Button>
            <Button disabled={formSaveDisabled} onClick={() => { setFormErr(""); editing ? updateM.mutate() : createM.mutate(); }}>
              {(createM.isPending || updateM.isPending) && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {editing ? "Guardar" : "Crear"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
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
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
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
              className="min-h-[300px] font-mono text-sm leading-relaxed"
            />
          </div>
          {formErr && <p className="text-xs text-destructive">{formErr}</p>}
        </div>
      </FormSheet>

      {/* Sandbox de prueba */}
      {testTarget && (
        <TestChatDialog key={testTarget.nombre + testTarget.contenido.length} target={testTarget} onClose={() => setTestTarget(null)} />
      )}

      {/* Confirmación de borrado */}
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
                  ¿Seguro que querés eliminar <span className="font-medium text-foreground">{deleteTarget?.nombre}</span>? Esta acción no se puede deshacer.
                </p>
              </div>
            </div>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => setDeleteTarget(null)}>Cancelar</Button>
            <Button variant="destructive" className="w-full sm:w-auto" disabled={deleteM.isPending}
              onClick={() => { if (deleteTarget) deleteM.mutate(deleteTarget.id); }}>
              {deleteM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Sí, eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Panel de detalle ──────────────────────────────────────────────────────────

function PersonalityDetailPanel({
  detail, loading, allTenants, assignTenantId, onAssignTenantChange, onAssign, assignBusy, onUnassign,
  onCollapse, onEdit, onTest, onDelete,
}: {
  detail: TemplateDetail | null;
  loading: boolean;
  allTenants: { id: string; name: string }[];
  assignTenantId: string;
  onAssignTenantChange: (v: string) => void;
  onAssign: () => void;
  assignBusy: boolean;
  onUnassign: (tenantId: string) => void;
  onCollapse: () => void;
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="w-full bg-card">
      <DetailPanelHeader label="Personalidad">
        <PanelIconButton onClick={onEdit} label="Editar"><Pencil className="h-4 w-4" /></PanelIconButton>
        <PanelIconButton onClick={onCollapse} label="Ocultar panel"><PanelRight className="h-4 w-4" /></PanelIconButton>
      </DetailPanelHeader>

      {loading || !detail ? (
        <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {/* Identidad */}
          <div className="border-b px-4 py-4">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted">
                <Bot className="h-5 w-5 text-muted-foreground" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="break-words text-[15px] font-semibold leading-tight text-foreground">{detail.nombre}</h3>
                {detail.descripcion && <p className="mt-0.5 text-xs text-muted-foreground">{detail.descripcion}</p>}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", catColor(detail.categoria))}>{catLabel(detail.categoria)}</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", PLAN_COLORS[detail.plan_minimo] || "bg-muted")}>Plan {detail.plan_minimo}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Prompt */}
          <div className="border-b px-4 py-4">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Prompt del sistema</p>
              <span className="text-[11px] tabular-nums text-muted-foreground/60">{detail.contenido.length} car.</span>
            </div>
            <pre className="mt-2 max-h-56 overflow-y-auto scrollbar-slim whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">{detail.contenido}</pre>
          </div>

          {/* Asignaciones */}
          <div className="space-y-3 border-b px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              Asignaciones <span className="tabular-nums text-muted-foreground/50">{detail.assignments.length}</span>
            </p>
            {(() => {
              const assignedIds = new Set(detail.assignments.map(a => a.tenant_id));
              const available = allTenants.filter(t => !assignedIds.has(t.id));
              return (
                <div className="flex gap-2">
                  <Select value={assignTenantId} onValueChange={onAssignTenantChange}>
                    <SelectTrigger className="h-9 flex-1 text-sm"><SelectValue placeholder="Elegir organización…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Elegir organización…</SelectItem>
                      {available.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                      {available.length === 0 && <SelectItem value="__none__" disabled>Todas ya la tienen</SelectItem>}
                    </SelectContent>
                  </Select>
                  <Button size="sm" className="h-9 shrink-0" disabled={assignTenantId === "none" || assignBusy} onClick={onAssign}>
                    {assignBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Asignar"}
                  </Button>
                </div>
              );
            })()}
            {detail.assignments.length === 0 ? (
              <p className="rounded-lg border border-dashed bg-muted/20 px-3 py-3 text-center text-xs text-muted-foreground">Sin asignaciones aún</p>
            ) : (
              <div className="space-y-1.5">
                {detail.assignments.map(a => (
                  <div key={a.id} className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
                    <div className="min-w-0 flex-1 leading-tight">
                      <p className="truncate text-[13px] font-medium text-foreground">{a.tenant_name}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">{a.tenant_id}</p>
                    </div>
                    {a.is_active && <Badge className="shrink-0 bg-success/10 text-[10px] text-success">activo</Badge>}
                    <button onClick={() => onUnassign(a.tenant_id)} aria-label="Quitar" className="shrink-0 text-muted-foreground transition-colors hover:text-destructive">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Acciones */}
          <div className="space-y-2 p-4">
            <Button size="sm" className="w-full gap-1.5" onClick={onTest}>
              <FlaskConical className="h-4 w-4" /> Probar personalidad
            </Button>
            <Button variant="ghost" size="sm" className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={onDelete}>
              <Trash2 className="mr-1.5 h-4 w-4" /> Eliminar
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Sandbox de prueba ───────────────────────────────────────────────────────────
// Mini-chat contra el LLM real con la personalidad elegida + contexto demo ficticio.

type TestMsg = { role: "user" | "bot"; content: string };

function TestChatDialog({ target, onClose }: { target: { nombre: string; contenido: string }; onClose: () => void }) {
  const [messages, setMessages] = useState<TestMsg[]>([]);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const testM = useMutation({
    mutationFn: (msgs: TestMsg[]) => api.promptTemplates.test(target.contenido, msgs),
    onSuccess: (d) => setMessages(m => [...m, { role: "bot", content: d.answer }]),
    onError: (e: any) => {
      toast({ title: e?.response?.data?.detail ?? "No se pudo obtener respuesta", variant: "destructive" });
      setMessages(m => m[m.length - 1]?.role === "user" ? m.slice(0, -1) : m);
    },
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, testM.isPending]);

  function send() {
    const content = input.trim();
    if (!content || testM.isPending) return;
    const next = [...messages, { role: "user" as const, content }];
    setMessages(next);
    setInput("");
    testM.mutate(next.slice(-20));
  }

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="w-full max-w-lg mx-4 sm:mx-auto p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 py-3 border-b space-y-0.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
              <FlaskConical className="h-4 w-4 text-muted-foreground" />
            </span>
            <div className="min-w-0 text-left">
              <DialogTitle className="text-sm truncate">Probar · {target.nombre}</DialogTitle>
              <p className="text-[11px] text-muted-foreground leading-tight">
                Sandbox con documentos ficticios (trámites, horarios, reintegros). No afecta a ningún tenant.
              </p>
            </div>
          </div>
        </DialogHeader>

        <div ref={scrollRef} className="h-[380px] overflow-y-auto px-4 py-3 space-y-3 bg-muted/20">
          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
              <Bot className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">
                Escribí una consulta para ver cómo responde esta personalidad.
                Probá por ejemplo: <span className="italic">&quot;hola&quot;</span>, <span className="italic">&quot;¿cómo saco la credencial?&quot;</span> o <span className="italic">&quot;¿hasta cuándo puedo pedir un reintegro?&quot;</span>
              </p>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div className={cn(
                "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words leading-relaxed",
                m.role === "user" ? "bg-primary text-primary-foreground rounded-br-sm" : "bg-card border rounded-bl-sm",
              )}>
                {m.content}
              </div>
            </div>
          ))}
          {testM.isPending && (
            <div className="flex justify-start">
              <div className="rounded-2xl rounded-bl-sm bg-card border px-3.5 py-2.5">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t px-3 py-2.5">
          <Input
            autoFocus
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Escribí tu consulta…"
            maxLength={2000}
            className="h-9 flex-1"
          />
          <Button size="sm" className="h-9 w-9 p-0 shrink-0" disabled={!input.trim() || testM.isPending} onClick={send}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
