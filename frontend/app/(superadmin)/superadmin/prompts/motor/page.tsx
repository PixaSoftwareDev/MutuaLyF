"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { catColor } from "@/components/superadmin/prompt-meta";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { FormSheet } from "@/components/layout/form-sheet";
import { ListToolbar } from "@/components/admin/list-toolbar";
import { ListDetailShell, DetailPanelHeader, PanelIconButton } from "@/components/admin/list-detail-shell";
import { useTableSort, applySort, SortHeader } from "@/components/admin/sortable";
import { Skeleton } from "@/components/ui/skeleton";
import { Cpu, Loader2, Pencil, PanelRight, SearchX } from "lucide-react";
import { cn } from "@/lib/utils";

// Etiqueta y color de los componentes del motor (categorías internas fijas).
function sysLabel(k: string): string {
  return k === "anti_alucinacion" ? "Anti-alucinación"
    : k === "calidad" ? "Ingesta" : k === "intenciones" ? "Clustering"
    : k === "asistente" ? "Asistente" : k === "sistema" ? "Sistema"
    : k.charAt(0).toUpperCase() + k.slice(1).replace(/[_-]/g, " ");
}
function sysColor(k: string): string {
  return k === "anti_alucinacion" ? "bg-warning/10 text-warning"
    : k === "calidad" ? "bg-info/10 text-info"
    : k === "intenciones" ? "bg-muted text-muted-foreground"
    : k === "sistema" ? "bg-muted text-muted-foreground" : catColor(k);
}

type SystemComponent = {
  id: string; nombre: string; descripcion: string | null; categoria: string;
  contenido: string; updated_at: string | null;
};

type SortKey = "nombre" | "tamano";

export default function MotorSistemaPage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen]   = useState(false);
  const [search, setSearch]         = useState("");
  const { sort, toggle } = useTableSort<SortKey>({ nombre: "asc" });

  const [editing, setEditing]   = useState<SystemComponent | null>(null);
  const [editContent, setEditContent] = useState("");

  const { data: components = [], isLoading } = useQuery({
    queryKey: ["system-components"],
    queryFn: api.promptTemplates.listSystemComponents,
    staleTime: 300_000,
  });

  const updateM = useMutation({
    mutationFn: ({ id, contenido }: { id: string; contenido: string }) =>
      api.promptTemplates.update(id, { contenido } as any),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["system-components"] });
      setEditing(null);
      toast({ title: "Componente actualizado", variant: "success" });
    },
    onError: (e: any) => toast({ title: e?.response?.data?.detail ?? "Error al guardar", variant: "destructive" }),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return components;
    return components.filter((c: SystemComponent) =>
      c.nombre.toLowerCase().includes(q) || (c.descripcion ?? "").toLowerCase().includes(q));
  }, [components, search]);

  const sorted = useMemo(() => applySort(filtered, sort, (a: SystemComponent, b: SystemComponent, key) =>
    key === "nombre" ? a.nombre.localeCompare(b.nombre, "es") : a.contenido.length - b.contenido.length,
  ), [filtered, sort]);

  const selected = components.find((c: SystemComponent) => c.id === selectedId) ?? null;

  function openEdit(c: SystemComponent) { setEditing(c); setEditContent(c.contenido); }

  return (
    <>
      <ListDetailShell
        title="Motor del sistema"
        panelTitle="componente"
        open={panelOpen}
        hasSelection={!!selected}
        onExpand={() => setPanelOpen(true)}
        panel={selected ? (
          <div className="w-full bg-card">
            <DetailPanelHeader label="Componente">
              <PanelIconButton onClick={() => openEdit(selected)} label="Editar"><Pencil className="h-4 w-4" /></PanelIconButton>
              <PanelIconButton onClick={() => setPanelOpen(false)} label="Ocultar panel"><PanelRight className="h-4 w-4" /></PanelIconButton>
            </DetailPanelHeader>

            <div className="border-b px-4 py-4">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted">
                  <Cpu className="h-5 w-5 text-muted-foreground" />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="break-words text-[15px] font-semibold leading-tight text-foreground">{selected.nombre}</h3>
                  {selected.descripcion && <p className="mt-0.5 text-xs text-muted-foreground">{selected.descripcion}</p>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", sysColor(selected.categoria))}>{sysLabel(selected.categoria)}</span>
                    <span className="rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">Infraestructura</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="border-b px-4 py-4">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Prompt</p>
                <span className="text-[11px] tabular-nums text-muted-foreground/60">{selected.contenido.length} car.</span>
              </div>
              <pre className="mt-2 max-h-80 overflow-y-auto scrollbar-slim whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">{selected.contenido}</pre>
            </div>

            <div className="p-4">
              <Button size="sm" className="w-full gap-1.5" onClick={() => openEdit(selected)}>
                <Pencil className="h-4 w-4" /> Editar prompt
              </Button>
              {selected.updated_at && (
                <p className="mt-3 text-center text-[11px] text-muted-foreground">
                  Actualizado el {new Date(selected.updated_at).toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric" })}
                </p>
              )}
            </div>
          </div>
        ) : null}
      >
        {isLoading ? (
          <Skeleton className="h-72 rounded-2xl" />
        ) : (
          <div className="space-y-4">
            {components.length > 0 && (
              <ListToolbar search={search} onSearch={setSearch} placeholder="Buscar componente…" />
            )}

            {components.length === 0 ? (
              <EmptyState icon={Cpu} title="No hay componentes del motor" />
            ) : filtered.length === 0 ? (
              <EmptyState icon={SearchX} title="Sin resultados" description={`Ninguno coincide con "${search}".`} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead><SortHeader label="Componente" sortKey="nombre" sort={sort} onToggle={toggle} /></TableHead>
                    <TableHead className="hidden md:table-cell">Categoría</TableHead>
                    <TableHead className="whitespace-nowrap text-right">
                      <SortHeader label="Tamaño" sortKey="tamano" sort={sort} onToggle={toggle} />
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((c: SystemComponent) => (
                    <TableRow
                      key={c.id}
                      onClick={() => { setSelectedId(c.id); setPanelOpen(true); }}
                      aria-selected={c.id === selectedId}
                      className={cn("cursor-pointer", c.id === selectedId && "bg-muted/60")}
                    >
                      <TableCell className="w-full max-w-0">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                            <Cpu className="h-4 w-4 text-muted-foreground" />
                          </span>
                          <div className="min-w-0">
                            <span className="block truncate font-medium text-foreground">{c.nombre}</span>
                            {c.descripcion && <p className="truncate text-xs text-muted-foreground">{c.descripcion}</p>}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", sysColor(c.categoria))}>{sysLabel(c.categoria)}</span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-xs text-muted-foreground tabular-nums">
                        {c.contenido.length.toLocaleString("es-AR")} car.
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </ListDetailShell>

      {/* Editar prompt — FormSheet roomy */}
      <FormSheet
        open={!!editing}
        onOpenChange={(v) => !v && setEditing(null)}
        icon={Cpu}
        title={editing ? `Editar · ${editing.nombre}` : "Editar componente"}
        description="Prompt interno del motor. Afecta cómo procesa el sistema — editá con cuidado."
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
            <Button disabled={!editing || !editContent.trim() || updateM.isPending}
              onClick={() => editing && updateM.mutate({ id: editing.id, contenido: editContent })}>
              {updateM.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Guardar
            </Button>
          </>
        }
      >
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Prompt</Label>
          <Textarea value={editContent} onChange={e => setEditContent(e.target.value)}
            className="min-h-[420px] font-mono text-sm leading-relaxed" placeholder="Contenido del prompt…" />
        </div>
      </FormSheet>
    </>
  );
}
