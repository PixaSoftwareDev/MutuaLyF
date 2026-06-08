"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Edit2, Loader2, Star, MoreVertical, Users, Folder, UserX, Trash2, AlertTriangle } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { api, type SectorRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { EmptyState } from "@/components/ui/empty-state";
import { PageShell } from "@/components/layout/page-shell";

export default function SectorsPage() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["sectors"] });

  const [showCreate, setShowCreate]   = useState(false);
  const [newNombre, setNewNombre]     = useState("");
  const [newDesc, setNewDesc]         = useState("");

  const [editing, setEditing]         = useState<SectorRow | null>(null);
  const [editNombre, setEditNombre]   = useState("");
  const [editDesc, setEditDesc]       = useState("");

  const [deleting, setDeleting]       = useState<SectorRow | null>(null);

  const { data: sectors = [], isLoading } = useQuery({
    queryKey: ["sectors"],
    queryFn: api.sectors.list,
    staleTime: 30_000,
  });

  const createM = useMutation({
    mutationFn: () => api.sectors.create(newNombre.trim(), newDesc.trim() || undefined),
    onSuccess: () => {
      inv();
      setNewNombre(""); setNewDesc(""); setShowCreate(false);
      toast({ title: "Sector creado", variant: "success" });
    },
    onError: () => toast({ title: "Error al crear", variant: "destructive" }),
  });

  const updateM = useMutation({
    mutationFn: ({ id }: { id: string }) => api.sectors.update(id, editNombre.trim(), editDesc.trim() || undefined),
    onSuccess: () => { inv(); setEditing(null); toast({ title: "Sector actualizado", variant: "success" }); },
    onError: () => toast({ title: "Error al actualizar", variant: "destructive" }),
  });

  const defaultM = useMutation({
    mutationFn: (id: string) => api.sectors.setDefault(id),
    onSuccess: () => { inv(); toast({ title: "Sector default actualizado", variant: "success" }); },
    onError: () => toast({ title: "Error al cambiar el default", variant: "destructive" }),
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => api.sectors.delete(id),
    onSuccess: () => {
      inv();
      setDeleting(null);
      toast({ title: "Sector eliminado", description: "Se desactivó del listado.", variant: "success" });
    },
    onError: () => toast({ title: "Error al eliminar", variant: "destructive" }),
  });

  const startEdit = (s: SectorRow) => {
    setEditing(s);
    setEditNombre(s.nombre);
    setEditDesc(s.descripcion || "");
  };

  const activeSectors = sectors.filter(s => s.is_active);
  const totalOperators = activeSectors.reduce((sum, s) => sum + s.operator_count, 0);
  const defaultSector = activeSectors.find(s => s.is_default);

  return (
    <PageShell>
      {/* Header */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[26px] sm:text-[30px] font-bold tracking-tight text-foreground leading-tight">
            Sectores de atención
          </h1>
          <p className="text-[15px] text-muted-foreground mt-2 max-w-xl leading-relaxed">
            Las áreas que el afiliado elige al consultar. El sector{" "}
            <span className="font-semibold text-foreground">predeterminado</span> se asigna cuando no elige ninguno.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="shadow-sm shrink-0">
          <Plus className="h-[18px] w-[18px] mr-1.5" /> Nuevo sector
        </Button>
      </div>

      {/* Resumen */}
      {!isLoading && activeSectors.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatCard icon={Folder} label="Sectores activos" value={String(activeSectors.length)} />
          <StatCard icon={Users} label="Operadores asignados" value={String(totalOperators)} />
          <StatCard icon={Star} label="Predeterminado" value={defaultSector?.nombre ?? "—"} small />
        </div>
      )}

      {/* Grid de sectores */}
      {isLoading ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-40 rounded-2xl" />)}
        </div>
      ) : activeSectors.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Folder}
              title="No hay sectores activos"
              description="Creá el primero para que los usuarios puedan elegir un área al consultar."
              action={
                <Button size="sm" onClick={() => setShowCreate(true)}>
                  <Plus className="h-4 w-4 mr-1" />
                  Nuevo sector
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {activeSectors.map(s => (
            <SectorCard
              key={s.id}
              sector={s}
              onEdit={() => startEdit(s)}
              onSetDefault={() => defaultM.mutate(s.id)}
              onDelete={() => setDeleting(s)}
              defaultBusy={defaultM.isPending}
            />
          ))}
        </div>
      )}

      {/* Modal crear */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Nuevo sector</DialogTitle>
            <DialogDescription>
              Áreas que el usuario puede elegir en el chat.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-nombre">Nombre</Label>
              <Input
                id="new-nombre"
                placeholder="Ej. Ventas"
                value={newNombre}
                onChange={e => setNewNombre(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-desc">Descripción</Label>
              <Input
                id="new-desc"
                placeholder="Breve descripción (opcional)"
                value={newDesc}
                onChange={e => setNewDesc(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button
              onClick={() => createM.mutate()}
              disabled={!newNombre.trim() || createM.isPending}
            >
              {createM.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Crear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal editar */}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Editar sector</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-nombre">Nombre</Label>
              <Input
                id="edit-nombre"
                value={editNombre}
                onChange={e => setEditNombre(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-desc">Descripción</Label>
              <Input
                id="edit-desc"
                value={editDesc}
                onChange={e => setEditDesc(e.target.value)}
                placeholder="Opcional"
              />
            </div>

            {/* Operadores asignados — read-only, link a /admin/operators para gestionar */}
            {editing && <AssignedOperators sectorId={editing.id} />}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
            <Button
              onClick={() => editing && updateM.mutate({ id: editing.id })}
              disabled={!editNombre.trim() || updateM.isPending}
            >
              {updateM.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal eliminar */}
      <Dialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Eliminar sector
            </DialogTitle>
            <DialogDescription>
              {deleting && (
                <>
                  Vas a desactivar el sector <span className="font-semibold text-foreground">{deleting.nombre}</span>.
                  {deleting.operator_count > 0 && (
                    <span className="block mt-2 text-warning">
                      ⚠️ {deleting.operator_count} {deleting.operator_count === 1 ? "operador tiene" : "operadores tienen"} este sector asignado.
                      Sus asignaciones quedarán activas pero el sector dejará de aparecer en el listado.
                    </span>
                  )}
                  <span className="block mt-2 text-xs">
                    El borrado es reversible (soft-delete). Si te equivocás, podemos reactivarlo desde la base de datos.
                  </span>
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancelar</Button>
            <Button
              variant="destructive"
              onClick={() => deleting && deleteM.mutate(deleting.id)}
              disabled={deleteM.isPending}
            >
              {deleteM.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

// ── Lista de operadores asignados al sector (read-only) ──────────────────────

function AssignedOperators({ sectorId }: { sectorId: string }) {
  const { data: operators = [], isLoading } = useQuery({
    queryKey: ["sector-operators", sectorId],
    queryFn: () => api.sectors.getSectorOperators(sectorId),
    staleTime: 30_000,
  });

  return (
    <div className="space-y-2 pt-2 border-t">
      <Label className="text-xs">Operadores asignados</Label>

      {isLoading ? (
        <div className="space-y-1.5">
          <Skeleton className="h-10 rounded-md" />
          <Skeleton className="h-10 rounded-md" />
        </div>
      ) : operators.length === 0 ? (
        <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
          <UserX className="h-4 w-4 shrink-0" />
          Ningún operador atiende este sector todavía.
        </div>
      ) : (
        <div className="space-y-1 max-h-44 overflow-y-auto pr-1">
          {operators.map(op => (
            <div
              key={op.id}
              className="flex items-center gap-2.5 rounded-md border bg-card px-3 py-2"
            >
              <div className="w-7 h-7 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-xs font-bold shrink-0">
                {op.name.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate leading-tight">{op.name}</p>
                <p className="text-[11px] text-muted-foreground truncate">{op.email}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Para asignar o quitar operadores, andá a{" "}
        <span className="font-medium">Operadores</span> y editá cada uno.
      </p>
    </div>
  );
}

// ── Stat card (resumen) ──────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, small }: {
  icon: typeof Folder; label: string; value: string; small?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border bg-card px-4 py-3.5 shadow-xs">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-action/10 text-action shrink-0">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={`font-bold text-foreground truncate ${small ? "text-base" : "text-xl tabular-nums"}`}>{value}</p>
      </div>
    </div>
  );
}

// ── Sector card ──────────────────────────────────────────────────────────────

function SectorCard({
  sector, onEdit, onSetDefault, onDelete, defaultBusy,
}: {
  sector: SectorRow;
  onEdit: () => void;
  onSetDefault: () => void;
  onDelete: () => void;
  defaultBusy: boolean;
}) {
  return (
    <div className="group relative flex flex-col rounded-2xl border bg-card p-5 shadow-sm transition-all duration-200 hover:shadow-md hover:border-action/40 hover:-translate-y-0.5">
      {/* Cabecera: icono en contenedor de acento + menú */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-action/10 text-action shrink-0 ring-1 ring-action/10">
          <Folder className="h-[22px] w-[22px]" />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="h-8 w-8 -mr-1 text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 transition-opacity" aria-label="Acciones">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={onEdit}>
              <Edit2 className="h-4 w-4 mr-2" />
              Editar
            </DropdownMenuItem>
            {!sector.is_default && (
              <DropdownMenuItem onSelect={onSetDefault} disabled={defaultBusy}>
                <Star className="h-4 w-4 mr-2" />
                Marcar como default
              </DropdownMenuItem>
            )}
            {!sector.is_default && (
              <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">
                <Trash2 className="h-4 w-4 mr-2" />
                Eliminar
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Nombre + badge + descripción */}
      <div className="mt-4 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-[15px] text-foreground truncate">{sector.nombre}</h3>
          {sector.is_default && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-action/10 text-action px-2.5 py-0.5 text-[11px] font-semibold shrink-0">
              <span className="h-1.5 w-1.5 rounded-full bg-action" /> Por defecto
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-1 line-clamp-2 min-h-[2.5rem]">
          {sector.descripcion || "Sin descripción"}
        </p>
      </div>

      {/* Footer: operadores asignados */}
      <div className="mt-auto pt-4 border-t border-border/70 flex items-center gap-2 text-xs text-muted-foreground">
        <Users className="h-4 w-4 text-action/70" />
        <span className="font-medium text-foreground/80">{sector.operator_count}</span>
        {sector.operator_count === 1 ? "operador asignado" : "operadores asignados"}
      </div>
    </div>
  );
}
