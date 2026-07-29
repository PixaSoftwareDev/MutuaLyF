"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type SystemComponent } from "@/lib/api";
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
import { Cpu, Loader2, Pencil, PanelRight, SearchX, RotateCcw, FileCode2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Los prompts del motor viven en el CÓDIGO (services/prompt_registry.py) y se
// versionan con git. Esta pantalla los muestra todos; los módulos editables
// admiten un override guardado en DB que pisa el default — "Restaurar" lo
// borra y vuelve al código.

type SortKey = "nombre" | "tamano";

// Estado de cada prompt: default del código, override activo, o interno
// (solo lectura, vive junto a su consumidor).
function EstadoPill({ c }: { c: SystemComponent }) {
  if (c.contenido === null) return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">En código</span>
  );
  if (c.has_override) return (
    <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">Override activo</span>
  );
  return (
    <span className="rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">Default</span>
  );
}

export default function MotorSistemaPage() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["system-components"] });
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [panelOpen, setPanelOpen]       = useState(false);
  const [search, setSearch]             = useState("");
  const { sort, toggle } = useTableSort<SortKey>({ nombre: "asc" });

  const [editing, setEditing]         = useState<SystemComponent | null>(null);
  const [editContent, setEditContent] = useState("");

  const { data: components = [], isLoading } = useQuery({
    queryKey: ["system-components"],
    queryFn: api.promptTemplates.listSystemComponents,
    staleTime: 300_000,
  });

  const saveM = useMutation({
    mutationFn: ({ slug, contenido }: { slug: string; contenido: string }) =>
      api.promptTemplates.saveComponentOverride(slug, contenido),
    onSuccess: () => {
      inv(); setEditing(null);
      toast({ title: "Override guardado", description: "Este texto pisa al default del código hasta que lo restaures.", variant: "success" });
    },
    onError: (e: any) => toast({ title: e?.response?.data?.detail ?? "Error al guardar", variant: "destructive" }),
  });

  const restoreM = useMutation({
    mutationFn: (slug: string) => api.promptTemplates.deleteComponentOverride(slug),
    onSuccess: () => {
      inv(); setEditing(null);
      toast({ title: "Default restaurado", description: "Vuelve a regir el texto versionado en el código.", variant: "success" });
    },
    onError: (e: any) => toast({ title: e?.response?.data?.detail ?? "Error al restaurar", variant: "destructive" }),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return components;
    return components.filter((c) =>
      c.nombre.toLowerCase().includes(q) || (c.descripcion ?? "").toLowerCase().includes(q)
      || c.consumer.toLowerCase().includes(q));
  }, [components, search]);

  const sorted = useMemo(() => applySort(filtered, sort, (a: SystemComponent, b: SystemComponent, key) =>
    key === "nombre" ? a.nombre.localeCompare(b.nombre, "es")
      : (a.contenido?.length ?? 0) - (b.contenido?.length ?? 0),
  ), [filtered, sort]);

  const selected = components.find((c) => c.slug === selectedSlug) ?? null;

  function openEdit(c: SystemComponent) { setEditing(c); setEditContent(c.contenido ?? ""); }

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
              {selected.editable && (
                <PanelIconButton onClick={() => openEdit(selected)} label="Editar"><Pencil className="h-4 w-4" /></PanelIconButton>
              )}
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
                    <EstadoPill c={selected} />
                    {!selected.editable && selected.contenido !== null && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">Cambia con deploy</span>
                    )}
                  </div>
                  <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground/70">{selected.consumer}</p>
                </div>
              </div>
            </div>

            {selected.contenido !== null ? (
              <div className="border-b px-4 py-4">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    {selected.has_override ? "Texto efectivo (override)" : "Texto (default del código)"}
                  </p>
                  <span className="text-[11px] tabular-nums text-muted-foreground/60">{selected.contenido.length} car.</span>
                </div>
                <pre className="mt-2 max-h-80 overflow-y-auto scrollbar-slim whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">{selected.contenido}</pre>
              </div>
            ) : (
              <div className="border-b px-4 py-4">
                <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                  <FileCode2 className="mt-0.5 h-4 w-4 shrink-0" />
                  Prompt interno de un pipeline: su texto vive en el archivo indicado arriba
                  y se modifica con un deploy, no desde el panel.
                </p>
              </div>
            )}

            {selected.editable && (
              <div className="space-y-2 p-4">
                <Button size="sm" className="w-full gap-1.5" onClick={() => openEdit(selected)}>
                  <Pencil className="h-4 w-4" /> {selected.has_override ? "Editar override" : "Crear override"}
                </Button>
                {selected.has_override && (
                  <Button size="sm" variant="outline" className="w-full gap-1.5" disabled={restoreM.isPending}
                          onClick={() => restoreM.mutate(selected.slug)}>
                    {restoreM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                    Restaurar default del código
                  </Button>
                )}
              </div>
            )}
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
                    <TableHead className="hidden md:table-cell">Estado</TableHead>
                    <TableHead className="whitespace-nowrap text-right">
                      <SortHeader label="Tamaño" sortKey="tamano" sort={sort} onToggle={toggle} />
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((c) => (
                    <TableRow
                      key={c.slug}
                      onClick={() => { setSelectedSlug(c.slug); setPanelOpen(true); }}
                      aria-selected={c.slug === selectedSlug}
                      className={cn("cursor-pointer", c.slug === selectedSlug && "bg-muted/60")}
                    >
                      <TableCell className="w-full max-w-0">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                            {c.contenido === null
                              ? <FileCode2 className="h-4 w-4 text-muted-foreground" />
                              : <Cpu className="h-4 w-4 text-muted-foreground" />}
                          </span>
                          <div className="min-w-0">
                            <span className="block truncate font-medium text-foreground">{c.nombre}</span>
                            {c.descripcion && <p className="truncate text-xs text-muted-foreground">{c.descripcion}</p>}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell"><EstadoPill c={c} /></TableCell>
                      <TableCell className="whitespace-nowrap text-right text-xs text-muted-foreground tabular-nums">
                        {c.contenido === null ? "—" : `${c.contenido.length.toLocaleString("es-AR")} car.`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </ListDetailShell>

      {/* Crear/editar override — FormSheet roomy */}
      <FormSheet
        open={!!editing}
        onOpenChange={(v) => !v && setEditing(null)}
        icon={Cpu}
        title={editing ? `Override · ${editing.nombre}` : "Override"}
        description="Este texto pisa al default versionado en el código. Afecta cómo responde el sistema — editá con cuidado; 'Restaurar default' lo revierte."
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
            <Button disabled={!editing || !editContent.trim() || saveM.isPending}
              onClick={() => editing && saveM.mutate({ slug: editing.slug, contenido: editContent })}>
              {saveM.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Guardar override
            </Button>
          </>
        }
      >
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Prompt</Label>
          <Textarea value={editContent} onChange={e => setEditContent(e.target.value)}
            className="min-h-[420px] font-mono text-sm leading-relaxed" placeholder="Contenido del prompt…" />
          {editing?.has_override && editing.default_text && (
            <p className="text-[11px] leading-snug text-muted-foreground">
              Hay un override activo. El default del código sigue disponible con &quot;Restaurar default&quot;.
            </p>
          )}
        </div>
      </FormSheet>
    </>
  );
}
