"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Edit2, Loader2, Star, Users, Headset, Trash2, AlertTriangle, SearchX, PanelRight } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type SectorRow } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import { toast } from "@/components/ui/toast";
import { EmptyState } from "@/components/ui/empty-state";
import { ListToolbar } from "@/components/admin/list-toolbar";
import { ListDetailShell, DetailPanelHeader, PanelIconButton } from "@/components/admin/list-detail-shell";
import { useTableSort, applySort, SortHeader } from "@/components/admin/sortable";

type SortKey = "nombre" | "operadores";

export default function SectorsPage() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["sectors"] });

  const [showCreate, setShowCreate] = useState(false);
  const [newNombre, setNewNombre]   = useState("");
  const [newDesc, setNewDesc]       = useState("");

  const [editing, setEditing]       = useState<SectorRow | null>(null);
  const [editNombre, setEditNombre] = useState("");
  const [editDesc, setEditDesc]     = useState("");

  const [deleting, setDeleting]     = useState<SectorRow | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen]   = useState(false);

  const [search, setSearch]         = useState("");
  const { sort, toggle } = useTableSort<SortKey>({ operadores: "desc" });

  const { data: sectors = [], isLoading } = useQuery({
    queryKey: ["sectors"],
    queryFn: api.sectors.list,
    staleTime: 30_000,
  });

  const createM = useMutation({
    mutationFn: () => api.sectors.create(newNombre.trim(), newDesc.trim() || undefined),
    onSuccess: () => { inv(); setNewNombre(""); setNewDesc(""); setShowCreate(false); toast({ title: "Sector creado", variant: "success" }); },
    onError: () => toast({ title: "Error al crear", variant: "destructive" }),
  });

  const updateM = useMutation({
    mutationFn: ({ id }: { id: string }) => api.sectors.update(id, editNombre.trim(), editDesc.trim() || undefined),
    onSuccess: () => { inv(); setEditing(null); toast({ title: "Sector actualizado", variant: "success" }); },
    onError: () => toast({ title: "Error al actualizar", variant: "destructive" }),
  });

  const defaultM = useMutation({
    mutationFn: (id: string) => api.sectors.setDefault(id),
    onSuccess: () => { inv(); toast({ title: "Sector predeterminado actualizado", variant: "success" }); },
    onError: () => toast({ title: "Error al cambiar el default", variant: "destructive" }),
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => api.sectors.delete(id),
    onSuccess: () => { inv(); setDeleting(null); toast({ title: "Sector eliminado", description: "Se desactivó del listado.", variant: "success" }); },
    onError: () => toast({ title: "Error al eliminar", variant: "destructive" }),
  });

  const startEdit = (s: SectorRow) => { setEditing(s); setEditNombre(s.nombre); setEditDesc(s.descripcion || ""); };

  const activeSectors = sectors.filter(s => s.is_active);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return activeSectors;
    return activeSectors.filter(s => s.nombre.toLowerCase().includes(q) || (s.descripcion ?? "").toLowerCase().includes(q));
  }, [activeSectors, search]);

  const sorted = useMemo(() => applySort(filtered, sort, (a, b, key) =>
    key === "nombre" ? a.nombre.localeCompare(b.nombre, "es") : a.operator_count - b.operator_count,
  ), [filtered, sort]);

  // Se recalcula desde la lista fresca: al eliminar deja de estar activo → el
  // panel se cierra solo; al editarlo, refleja el cambio.
  const selectedSector = activeSectors.find(s => s.id === selectedId) ?? null;

  return (
    <>
      <ListDetailShell
        title="Sectores de atención"
        actions={
          <Button size="sm" className="shrink-0" onClick={() => setShowCreate(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> Nuevo sector
          </Button>
        }
        panelTitle="sector"
        open={panelOpen}
        hasSelection={!!selectedSector}
        onExpand={() => setPanelOpen(true)}
        panel={selectedSector ? (
          <SectorDetailPanel
            sector={selectedSector}
            onCollapse={() => setPanelOpen(false)}
            onEdit={() => startEdit(selectedSector)}
            onSetDefault={() => defaultM.mutate(selectedSector.id)}
            onDelete={() => setDeleting(selectedSector)}
            defaultBusy={defaultM.isPending}
          />
        ) : null}
      >
        {isLoading ? (
          <Skeleton className="h-72 rounded-2xl" />
        ) : (
          <div className="space-y-4">
            {activeSectors.length > 0 && (
              <ListToolbar search={search} onSearch={setSearch} placeholder="Buscar sector…" />
            )}

            {activeSectors.length === 0 ? (
              <EmptyState icon={Headset} title="No hay sectores activos"
                description="Creá el primero para que los usuarios puedan elegir un área al consultar." />
            ) : filtered.length === 0 ? (
              <EmptyState icon={SearchX} title="Sin resultados" description={`Ningún sector coincide con "${search}".`} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {/* Reparto proporcional: ni el nombre acapara todo el ancho
                        ni queda ahogado — la descripción recibe el resto. */}
                    <TableHead className="md:w-[45%]"><SortHeader label="Sector" sortKey="nombre" sort={sort} onToggle={toggle} /></TableHead>
                    <TableHead className="hidden md:table-cell">Descripción</TableHead>
                    <TableHead className="whitespace-nowrap text-right">
                      <SortHeader label="Operadores" sortKey="operadores" sort={sort} onToggle={toggle} />
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map(s => (
                    <SectorRowItem
                      key={s.id}
                      sector={s}
                      selected={s.id === selectedId}
                      onSelect={() => { setSelectedId(s.id); setPanelOpen(true); }}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </ListDetailShell>

      {/* Crear sector */}
      <FormDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        icon={Headset}
        title="Nuevo sector"
        description="Las áreas que el afiliado puede elegir al consultar."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button onClick={() => createM.mutate()} disabled={!newNombre.trim() || createM.isPending}>
              {createM.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Crear sector
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <Label htmlFor="new-nombre">Nombre</Label>
          <Input id="new-nombre" placeholder="Ej. Ventas" value={newNombre} onChange={e => setNewNombre(e.target.value)} autoFocus />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-desc">Descripción <span className="font-normal text-muted-foreground">(opcional)</span></Label>
          <Input id="new-desc" placeholder="Breve descripción del área" value={newDesc} onChange={e => setNewDesc(e.target.value)} />
        </div>
      </FormDialog>

      {/* Editar sector */}
      <FormDialog
        open={!!editing}
        onOpenChange={(open) => !open && setEditing(null)}
        icon={Edit2}
        title="Editar sector"
        description="Renombrá el sector o ajustá su descripción."
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
            <Button onClick={() => editing && updateM.mutate({ id: editing.id })} disabled={!editNombre.trim() || updateM.isPending}>
              {updateM.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Guardar cambios
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <Label htmlFor="edit-nombre">Nombre</Label>
          <Input id="edit-nombre" value={editNombre} onChange={e => setEditNombre(e.target.value)} autoFocus />
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-desc">Descripción <span className="font-normal text-muted-foreground">(opcional)</span></Label>
          <Input id="edit-desc" value={editDesc} onChange={e => setEditDesc(e.target.value)} placeholder="Breve descripción del área" />
        </div>
      </FormDialog>

      {/* Confirmación eliminar */}
      <Dialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-start gap-3 text-left">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
                <AlertTriangle className="h-5 w-5 text-destructive" />
              </div>
              <div className="min-w-0 space-y-1.5 pt-0.5">
                <DialogTitle>Eliminar sector</DialogTitle>
                <DialogDescription asChild>
                  <div>
                    {deleting && (
                      <>
                        <p>Vas a desactivar el sector <span className="font-semibold text-foreground">{deleting.nombre}</span>.</p>
                        {deleting.operator_count > 0 && (
                          <p className="mt-2 text-warning">
                            {deleting.operator_count} {deleting.operator_count === 1 ? "operador tiene" : "operadores tienen"} este sector asignado.
                            Sus asignaciones quedarán activas pero el sector dejará de aparecer en el listado.
                          </p>
                        )}
                        <p className="mt-2 text-xs">El borrado es reversible (soft-delete). Si te equivocás, podemos reactivarlo desde la base de datos.</p>
                      </>
                    )}
                  </div>
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancelar</Button>
            <Button variant="destructive" onClick={() => deleting && deleteM.mutate(deleting.id)} disabled={deleteM.isPending}>
              {deleteM.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Fila de la tabla ──────────────────────────────────────────────────────────

function SectorRowItem({ sector, selected, onSelect }: {
  sector: SectorRow;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <TableRow
      onClick={onSelect}
      aria-selected={selected}
      className={cn("cursor-pointer", selected ? "bg-muted/60" : sector.is_default && "bg-action/[0.03]")}
    >
      {/* w-full + max-w-0: la columna toma el espacio restante y el nombre trunca
          (sin esto, en mobile los nombres largos ensanchaban la tabla). */}
      <TableCell className="max-w-0 w-full md:w-[45%]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-foreground">{sector.nombre}</span>
          {sector.is_default && <DefaultBadge />}
        </div>
      </TableCell>
      <TableCell className="hidden w-full max-w-0 md:table-cell">
        {sector.descripcion
          ? <span className="text-muted-foreground line-clamp-1">{sector.descripcion}</span>
          : <span className="italic text-muted-foreground/50">Sin descripción</span>}
      </TableCell>
      <TableCell className="whitespace-nowrap text-right">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Users className="h-4 w-4 text-muted-foreground/70" />
          <span className="font-semibold tabular-nums text-foreground">{sector.operator_count}</span>
        </span>
      </TableCell>
    </TableRow>
  );
}

// ── Panel de detalle ──────────────────────────────────────────────────────────

function SectorDetailPanel({ sector, onCollapse, onEdit, onSetDefault, onDelete, defaultBusy }: {
  sector: SectorRow;
  onCollapse: () => void;
  onEdit: () => void;
  onSetDefault: () => void;
  onDelete: () => void;
  defaultBusy: boolean;
}) {
  const { data: operators, isLoading: opsLoading } = useQuery({
    queryKey: ["sector-operators", sector.id],
    queryFn: () => api.sectors.getSectorOperators(sector.id),
    staleTime: 30_000,
  });

  return (
    <div className="w-full bg-card">
      <DetailPanelHeader label="Sector">
        <PanelIconButton onClick={onEdit} label="Editar sector"><Edit2 className="h-4 w-4" /></PanelIconButton>
        <PanelIconButton onClick={onCollapse} label="Ocultar panel"><PanelRight className="h-4 w-4" /></PanelIconButton>
      </DetailPanelHeader>

      {/* Identidad */}
      <div className="border-b px-4 py-4">
        <div className="flex items-start gap-3">
          <span className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            sector.is_default ? "bg-action/10 text-action" : "bg-muted text-muted-foreground",
          )}>
            <Headset className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="break-words text-[15px] font-semibold leading-tight text-foreground">{sector.nombre}</h3>
            <div className="mt-1.5">
              {sector.is_default ? <DefaultBadge /> : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/[0.08] px-2 py-0.5 text-[11px] font-semibold text-success">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" /> Activo
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="space-y-5 p-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Descripción</p>
          <p className={cn("mt-1.5 text-sm leading-relaxed", sector.descripcion ? "text-foreground" : "italic text-muted-foreground/50")}>
            {sector.descripcion || "Sin descripción"}
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              Operadores <span className="tabular-nums text-muted-foreground/50">{sector.operator_count}</span>
            </p>
            <Link href="/admin/operators" className="shrink-0 rounded px-0.5 text-xs font-medium text-action hover:underline">Gestionar</Link>
          </div>
          <div className="mt-2 space-y-1.5">
            {opsLoading ? (
              <><Skeleton className="h-11 w-full rounded-lg" /><Skeleton className="h-11 w-full rounded-lg" /></>
            ) : (operators?.length ?? 0) === 0 ? (
              <p className="rounded-lg border border-dashed bg-muted/20 px-3 py-3 text-center text-xs text-muted-foreground">Sin operadores asignados</p>
            ) : (
              operators!.map(op => (
                <div key={op.id} className="flex items-center gap-2.5 rounded-lg border bg-muted/30 px-3 py-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
                    {op.name?.trim()?.[0]?.toUpperCase() ?? op.email?.[0]?.toUpperCase() ?? "?"}
                  </span>
                  <div className="min-w-0 leading-tight">
                    <p className="truncate text-[13px] font-medium text-foreground">{op.name || op.email}</p>
                    {op.name && <p className="truncate text-[11px] text-muted-foreground">{op.email}</p>}
                  </div>
                  {!op.is_active && <span className="ml-auto shrink-0 text-[10px] font-medium text-muted-foreground/60">inactivo</span>}
                </div>
              ))
            )}
          </div>
        </div>

        {sector.is_default && (
          <p className="rounded-lg bg-action/[0.06] px-3 py-2 text-xs leading-relaxed text-action">
            Se asigna automáticamente cuando el afiliado no elige un área al consultar.
          </p>
        )}
      </div>

      {/* Acciones (para el predeterminado no hay: editar está arriba) */}
      {!sector.is_default && (
        <div className="space-y-2 border-t p-4">
          <Button variant="outline" size="sm" className="w-full" onClick={onSetDefault} disabled={defaultBusy}>
            {defaultBusy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Star className="mr-1.5 h-4 w-4" />}
            Marcar predeterminado
          </Button>
          <Button variant="ghost" size="sm" className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={onDelete}>
            <Trash2 className="mr-1.5 h-4 w-4" /> Eliminar
          </Button>
        </div>
      )}
    </div>
  );
}

function DefaultBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-action/30 bg-action/[0.06] px-2 py-0.5 text-[11px] font-semibold text-action">
      <span className="h-1.5 w-1.5 rounded-full bg-action-gradient" /> Predeterminado
    </span>
  );
}
