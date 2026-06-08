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
import { PageHeader } from "@/components/layout/page-header";

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

  return (
    <PageShell>
      <PageHeader
        title="Sectores de atención"
        description={
          <>
            Gestioná los sectores. El sector <span className="font-medium">default</span> se asigna automáticamente cuando el usuario no elige ninguno.
          </>
        }
        actions={
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Nuevo sector
          </Button>
        }
      />

      {/* Lista de sectores */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-24 rounded-lg" />)}
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
        <div className="space-y-4">
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
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {/* Icono — neutral, mismo patrón que avatar de operador */}
            <div className="w-9 h-9 rounded-full flex items-center justify-center bg-muted text-muted-foreground shrink-0">
              <Folder className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="font-semibold text-sm truncate">{sector.nombre}</p>
                {sector.is_default && (
                  <Badge className="text-xs bg-warning/10 text-warning border border-warning/20 hover:bg-warning/10">
                    Default
                  </Badge>
                )}
              </div>
              {sector.descripcion && (
                <p className="text-xs text-muted-foreground truncate">{sector.descripcion}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Acciones">
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
                  <DropdownMenuItem
                    onSelect={onDelete}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Eliminar
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="h-3.5 w-3.5" />
          {sector.operator_count} {sector.operator_count === 1 ? "operador asignado" : "operadores asignados"}
        </div>
      </CardContent>
    </Card>
  );
}
