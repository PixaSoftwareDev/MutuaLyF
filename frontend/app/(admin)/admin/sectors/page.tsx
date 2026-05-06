"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, Plus, Trash2, Edit2, Check, X, Loader2 } from "lucide-react";
import { api, type SectorRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";

export default function SectorsPage() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["sectors"] });

  const [newNombre, setNewNombre]     = useState("");
  const [newDesc, setNewDesc]         = useState("");
  const [editingId, setEditingId]     = useState<string | null>(null);
  const [editNombre, setEditNombre]   = useState("");
  const [editDesc, setEditDesc]       = useState("");

  const { data: sectors = [], isLoading } = useQuery({
    queryKey: ["sectors"],
    queryFn: api.sectors.list,
  });

  const createM = useMutation({
    mutationFn: () => api.sectors.create(newNombre.trim(), newDesc.trim() || undefined),
    onSuccess: () => { inv(); setNewNombre(""); setNewDesc(""); toast({ title: "Sector creado", variant: "success" }); },
    onError: () => toast({ title: "Error al crear", variant: "destructive" }),
  });

  const updateM = useMutation({
    mutationFn: ({ id }: { id: string }) => api.sectors.update(id, editNombre.trim(), editDesc.trim() || undefined),
    onSuccess: () => { inv(); setEditingId(null); toast({ title: "Sector actualizado", variant: "success" }); },
  });

  const deleteM = useMutation({
    mutationFn: api.sectors.delete,
    onSuccess: () => { inv(); toast({ title: "Sector desactivado" }); },
  });

  const startEdit = (s: SectorRow) => {
    setEditingId(s.id);
    setEditNombre(s.nombre);
    setEditDesc(s.descripcion || "");
  };

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Building2 className="h-6 w-6 text-primary" />
          Sectores de atención
        </h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Gestioná los sectores y asigná operadores a cada uno.
        </p>
      </div>

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
          <h2 className="font-semibold text-sm">Sectores ({sectors.filter(s => s.is_active).length} activos)</h2>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
          ) : sectors.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No hay sectores. Creá el primero.</p>
          ) : (
            <div className="space-y-2">
              {sectors.map(s => (
                <div key={s.id} className="flex items-center gap-3 p-3 rounded-lg border">
                  {editingId === s.id ? (
                    <div className="flex-1 flex items-center gap-2">
                      <Input value={editNombre} onChange={e => setEditNombre(e.target.value)} className="h-8" />
                      <Input value={editDesc} onChange={e => setEditDesc(e.target.value)} placeholder="Descripción" className="h-8" />
                      <Button size="icon" className="h-8 w-8" onClick={() => updateM.mutate({ id: s.id })} disabled={!editNombre.trim()}>
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditingId(null)}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{s.nombre}</span>
                          {!s.is_active && <Badge variant="secondary" className="text-xs">Inactivo</Badge>}
                        </div>
                        {s.descripcion && <p className="text-xs text-muted-foreground truncate">{s.descripcion}</p>}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                        <span>{s.operator_count} operadores</span>
                        <span>{s.open_conversations} conv. abiertas</span>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => startEdit(s)}>
                          <Edit2 className="h-3.5 w-3.5" />
                        </Button>
                        {s.nombre !== "Consultas Generales" && (
                          <Button
                            size="icon" variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={() => deleteM.mutate(s.id)}
                            disabled={deleteM.isPending}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
