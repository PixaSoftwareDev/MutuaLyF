"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Edit2, Loader2, Star, MoreVertical, Users, Folder, Trash2, AlertTriangle } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { api, type SectorRow } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { EmptyState } from "@/components/ui/empty-state";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader, CountChip } from "@/components/layout/page-header";
import { FormSheet } from "@/components/layout/form-sheet";

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
    onSuccess: () => { inv(); toast({ title: "Sector predeterminado actualizado", variant: "success" }); },
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
        badge={!isLoading ? <CountChip>{activeSectors.length} {activeSectors.length === 1 ? "activo" : "activos"}</CountChip> : undefined}
        description={
          <>Las áreas que el afiliado elige al consultar. El sector{" "}
          <span className="font-semibold text-foreground">predeterminado</span> se asigna cuando no elige ninguno.</>
        }
        actions={
          <Button onClick={() => setShowCreate(true)} className="shrink-0">
            <Plus className="h-[18px] w-[18px] mr-1.5" /> Nuevo sector
          </Button>
        }
      />

      {/* Grid de sectores */}
      {isLoading ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-44 rounded-2xl" />)}
        </div>
      ) : activeSectors.length === 0 ? (
        <EmptyState
          icon={Folder}
          title="No hay sectores activos"
          description="Creá el primero con 'Nuevo sector' (arriba) para que los usuarios puedan elegir un área al consultar."
        />
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

      {/* Panel crear */}
      <FormSheet
        open={showCreate}
        onOpenChange={setShowCreate}
        icon={Folder}
        title="Nuevo sector"
        description="Áreas que el usuario puede elegir en el chat."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button
              onClick={() => createM.mutate()}
              disabled={!newNombre.trim() || createM.isPending}
            >
              {createM.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Crear sector
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="new-nombre">Nombre</Label>
            <Input
              id="new-nombre"
              placeholder="Ej. Ventas"
              value={newNombre}
              onChange={e => setNewNombre(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-desc">
              Descripción <span className="font-normal text-muted-foreground">(opcional)</span>
            </Label>
            <Input
              id="new-desc"
              placeholder="Breve descripción del área"
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
            />
          </div>
        </div>
      </FormSheet>

      {/* Panel editar */}
      <FormSheet
        open={!!editing}
        onOpenChange={(open) => !open && setEditing(null)}
        icon={Edit2}
        title="Editar sector"
        description="Renombrá el sector o ajustá su descripción."
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
            <Button
              onClick={() => editing && updateM.mutate({ id: editing.id })}
              disabled={!editNombre.trim() || updateM.isPending}
            >
              {updateM.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Guardar cambios
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="edit-nombre">Nombre</Label>
            <Input
              id="edit-nombre"
              value={editNombre}
              onChange={e => setEditNombre(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-desc">
              Descripción <span className="font-normal text-muted-foreground">(opcional)</span>
            </Label>
            <Input
              id="edit-desc"
              value={editDesc}
              onChange={e => setEditDesc(e.target.value)}
              placeholder="Breve descripción del área"
            />
          </div>

          {/* Quién atiende — solo el conteo + acceso a Operadores (gestionar
              asignaciones vive allá). El panel queda en lo suyo: renombrar. */}
          {editing && (
            <div className="flex items-center justify-between gap-2 rounded-xl border bg-muted/30 px-3.5 py-3 text-sm">
              <span className="flex items-center gap-2 text-muted-foreground min-w-0">
                <Users className="h-4 w-4 shrink-0" />
                <span className="truncate">
                  <span className="font-semibold text-foreground tabular-nums">{editing.operator_count}</span>{" "}
                  {editing.operator_count === 1 ? "operador atiende" : "operadores atienden"} este sector
                </span>
              </span>
              <Link href="/admin/operators" className="text-action hover:underline text-xs font-medium shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded px-0.5">
                Gestionar
              </Link>
            </div>
          )}
        </div>
      </FormSheet>

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
                        <p>
                          Vas a desactivar el sector <span className="font-semibold text-foreground">{deleting.nombre}</span>.
                        </p>
                        {deleting.operator_count > 0 && (
                          <p className="mt-2 text-warning">
                            {deleting.operator_count} {deleting.operator_count === 1 ? "operador tiene" : "operadores tienen"} este sector asignado.
                            Sus asignaciones quedarán activas pero el sector dejará de aparecer en el listado.
                          </p>
                        )}
                        <p className="mt-2 text-xs">
                          El borrado es reversible (soft-delete). Si te equivocás, podemos reactivarlo desde la base de datos.
                        </p>
                      </>
                    )}
                  </div>
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <DialogFooter className="mt-2">
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
    <div className={cn(
      "group flex flex-col rounded-2xl border bg-card p-5 shadow-sm transition-all duration-200 hover:shadow-md hover:-translate-y-0.5",
      // El predeterminado se reconoce de un vistazo: encuadre con el acento de marca.
      sector.is_default
        ? "border-action/40 ring-1 ring-action/20"
        : "hover:border-action/25",
    )}>
      {/* Nombre al lado del tile (misma estructura que la card de Operadores) + menú */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-action-gradient-soft">
            <Folder className="h-5 w-5 text-action" />
          </div>
          <div className="min-w-0 flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-[15px] tracking-tight text-foreground truncate">{sector.nombre}</h3>
            {sector.is_default && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-action/30 bg-action/[0.06] px-2 py-0.5 text-[11px] font-semibold text-action shrink-0">
                <span className="h-1.5 w-1.5 rounded-full bg-action-gradient" /> Predeterminado
              </span>
            )}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="h-8 w-8 max-sm:h-10 max-sm:w-10 -mt-0.5 shrink-0 text-muted-foreground" aria-label="Acciones">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={onEdit}>
              <Edit2 className="h-4 w-4 mr-2" />
              Editar
            </DropdownMenuItem>
            {!sector.is_default && (
              <DropdownMenuItem onSelect={onSetDefault} disabled={defaultBusy}>
                <Star className="h-4 w-4 mr-2" />
                Predeterminado
              </DropdownMenuItem>
            )}
            {!sector.is_default && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">
                  <Trash2 className="h-4 w-4 mr-2" />
                  Eliminar
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Descripción — placeholder tenue si no hay, para que el divisor del footer
          no quede flotando sobre un hueco vacío. El mt-auto alinea los pies. */}
      {sector.descripcion ? (
        <p className="text-sm text-muted-foreground mt-3 line-clamp-2">
          {sector.descripcion}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground/50 italic mt-3">Sin descripción</p>
      )}

      {/* Footer: operadores asignados */}
      <div className="mt-auto pt-4 border-t border-border/70 flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <Users className="h-4 w-4 text-muted-foreground/70" />
        <span className="font-semibold text-foreground tabular-nums">{sector.operator_count}</span>
        {sector.operator_count === 1 ? "operador" : "operadores"}
      </div>
    </div>
  );
}
