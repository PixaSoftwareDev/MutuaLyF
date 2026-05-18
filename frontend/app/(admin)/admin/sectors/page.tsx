"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Edit2, Loader2, Star, MoreVertical } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { api, type SectorRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";

export default function SectorsPage() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["sectors"] });

  const [newNombre, setNewNombre]   = useState("");
  const [newDesc, setNewDesc]       = useState("");
  const [editing, setEditing]       = useState<SectorRow | null>(null);
  const [editNombre, setEditNombre] = useState("");
  const [editDesc, setEditDesc]     = useState("");

  const { data: sectors = [], isLoading } = useQuery({
    queryKey: ["sectors"],
    queryFn: api.sectors.list,
    staleTime: 30_000,
  });

  const createM = useMutation({
    mutationFn: () => api.sectors.create(newNombre.trim(), newDesc.trim() || undefined),
    onSuccess: () => { inv(); setNewNombre(""); setNewDesc(""); toast({ title: "Sector creado", variant: "success" }); },
    onError: () => toast({ title: "Error al crear", variant: "destructive" }),
  });

  const updateM = useMutation({
    mutationFn: ({ id }: { id: string }) => api.sectors.update(id, editNombre.trim(), editDesc.trim() || undefined),
    onSuccess: () => { inv(); setEditing(null); toast({ title: "Sector actualizado", variant: "success" }); },
    onError: () => toast({ title: "Error al actualizar", variant: "destructive" }),
  });

  const deleteM = useMutation({
    mutationFn: api.sectors.delete,
    onSuccess: () => { inv(); toast({ title: "Sector desactivado" }); },
  });

  const defaultM = useMutation({
    mutationFn: (id: string) => api.sectors.setDefault(id),
    onSuccess: () => { inv(); toast({ title: "Sector default actualizado", variant: "success" }); },
    onError: () => toast({ title: "Error al cambiar el default", variant: "destructive" }),
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
      />

      {/* Crear sector */}
      <Card>
        <CardHeader className="pb-3">
          <h2 className="font-semibold text-sm">Nuevo sector</h2>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            placeholder="Nombre del sector (ej: RRHH, Prestaciones, Finanzas)"
            value={newNombre}
            onChange={e => setNewNombre(e.target.value)}
          />
          <Input
            placeholder="Descripción (opcional)"
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
          />
          <Button
            disabled={!newNombre.trim() || createM.isPending}
            onClick={() => createM.mutate()}
            size="sm"
          >
            {createM.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
            Crear sector
          </Button>
        </CardContent>
      </Card>

      {/* Lista */}
      <Card>
        <CardHeader className="pb-3">
          <h2 className="text-base font-semibold">Sectores ({activeSectors.length} activos)</h2>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
          ) : sectors.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No hay sectores. Creá el primero.</p>
          ) : (
            <div className="space-y-2">
              {sectors.map(s => (
                <div
                  key={s.id}
                  className="flex items-center gap-3 p-3 rounded-lg border transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{s.nombre}</span>
                      {s.is_default && (
                        <Badge className="text-xs bg-amber-200 text-amber-900 border border-amber-400 hover:bg-amber-200">
                          Default
                        </Badge>
                      )}
                      {!s.is_active && <Badge variant="secondary" className="text-xs">Inactivo</Badge>}
                    </div>
                    {s.descripcion && <p className="text-xs text-muted-foreground truncate">{s.descripcion}</p>}
                  </div>

                  <div className="text-xs text-muted-foreground shrink-0">
                    {s.operator_count} {s.operator_count === 1 ? "operador" : "operadores"}
                  </div>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label="Acciones">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem onSelect={() => startEdit(s)}>
                        <Edit2 className="h-4 w-4 mr-2" />
                        Editar
                      </DropdownMenuItem>
                      {!s.is_default && s.is_active && (
                        <DropdownMenuItem
                          onSelect={() => defaultM.mutate(s.id)}
                          disabled={defaultM.isPending}
                        >
                          <Star className="h-4 w-4 mr-2" />
                          Marcar como default
                        </DropdownMenuItem>
                      )}
                      {!s.is_default && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => deleteM.mutate(s.id)}
                            disabled={deleteM.isPending}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Desactivar
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Editar sector</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
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
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
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
    </PageShell>
  );
}
