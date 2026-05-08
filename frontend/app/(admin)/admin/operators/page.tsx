"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Users, Check, Loader2, Plus, Trash2, X } from "lucide-react";
import { apiClient } from "@/lib/api";
import { api, type SectorRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

interface OperatorUser {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
}

async function listOperators(): Promise<OperatorUser[]> {
  const { data } = await apiClient.get("/admin/operators");
  return data;
}

export default function OperatorsPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName]             = useState("");
  const [email, setEmail]           = useState("");
  const [password, setPassword]     = useState("");

  const { data: operators = [], isLoading: loadingOps } = useQuery({
    queryKey: ["operators"],
    queryFn: listOperators,
    staleTime: 30_000,
  });

  const { data: sectors = [], isLoading: loadingSectors } = useQuery({
    queryKey: ["sectors"],
    queryFn: api.sectors.list,
    staleTime: 30_000,
  });

  const createM = useMutation({
    mutationFn: () => apiClient.post("/admin/operators", { name: name.trim(), email: email.trim(), password }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      toast({ title: "Operador creado", variant: "success" });
      setShowCreate(false);
      setName(""); setEmail(""); setPassword("");
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail;
      toast({ title: typeof detail === "string" ? detail : "Error al crear operador", variant: "destructive" });
    },
  });

  const operatorsFiltered = operators.filter(o => o.role === "operator" && o.is_active);

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="h-6 w-6 text-primary" />
            Operadores
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Creá operadores y asignales los sectores que pueden atender.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Nuevo operador
        </Button>
      </div>

      {/* List */}
      {loadingOps || loadingSectors ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-32 rounded-lg" />)}
        </div>
      ) : operatorsFiltered.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            No hay operadores activos. Creá el primero con el botón de arriba.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {operatorsFiltered.map(op => (
            <OperatorCard key={op.id} operator={op} sectors={sectors} onDeleted={() => qc.invalidateQueries({ queryKey: ["operators"] })} />
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Nuevo operador</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="op-name">Nombre</Label>
              <Input id="op-name" placeholder="María García" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="op-email">Email</Label>
              <Input id="op-email" type="email" placeholder="maria@empresa.com" value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="op-password">Contraseña</Label>
              <Input id="op-password" type="password" placeholder="Mínimo 8 caracteres" value={password} onChange={e => setPassword(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button
              onClick={() => createM.mutate()}
              disabled={!name.trim() || !email.trim() || password.length < 8 || createM.isPending}
            >
              {createM.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Crear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OperatorCard({ operator, sectors, onDeleted }: { operator: OperatorUser; sectors: SectorRow[]; onDeleted: () => void }) {
  const qc = useQueryClient();
  const activeSectors = sectors.filter(s => s.is_active);

  const { data: assignedSectors = [] } = useQuery({
    queryKey: ["operator-sectors", operator.id],
    queryFn: () => api.sectors.getOperatorSectors(operator.id),
    staleTime: 30_000,
  });

  const [selected, setSelected] = useState<Set<string>>(new Set(assignedSectors.map(s => s.id)));
  const [dirty, setDirty]       = useState(false);

  if (assignedSectors.length > 0 && !dirty && selected.size === 0) {
    setSelected(new Set(assignedSectors.map(s => s.id)));
  }

  const saveM = useMutation({
    mutationFn: () => api.sectors.assignOperatorSectors(operator.id, Array.from(selected)),
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["operator-sectors", operator.id] });
      toast({ title: `Sectores de ${operator.name} actualizados`, variant: "success" });
    },
    onError: () => toast({ title: "Error al guardar", variant: "destructive" }),
  });

  const deleteM = useMutation({
    mutationFn: () => apiClient.delete(`/admin/operators/${operator.id}`),
    onSuccess: () => {
      toast({ title: `${operator.name} desactivado`, variant: "success" });
      onDeleted();
    },
    onError: () => toast({ title: "Error al desactivar", variant: "destructive" }),
  });

  const toggle = (sectorId: string) => {
    const next = new Set(selected);
    if (next.has(sectorId)) next.delete(sectorId); else next.add(sectorId);
    setSelected(next);
    setDirty(true);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-semibold text-sm">{operator.name}</p>
            <p className="text-xs text-muted-foreground">{operator.email}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">operador</Badge>
            {dirty && (
              <Button size="sm" onClick={() => saveM.mutate()} disabled={saveM.isPending}>
                {saveM.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Check className="h-4 w-4 mr-1" />}
                Guardar
              </Button>
            )}
            <Button
              size="sm" variant="ghost"
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => deleteM.mutate()}
              disabled={deleteM.isPending}
              title="Desactivar operador"
            >
              {deleteM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      <Separator />
      <CardContent className="pt-4">
        <p className="text-xs text-muted-foreground mb-3">
          Sectores asignados — el operador solo ve conversaciones de estos sectores:
        </p>
        {activeSectors.length === 0 ? (
          <p className="text-xs text-muted-foreground">No hay sectores activos. Creá sectores primero.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {activeSectors.map(sector => {
              const isSelected = selected.has(sector.id);
              return (
                <button
                  key={sector.id}
                  onClick={() => toggle(sector.id)}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-sm border transition-colors",
                    isSelected
                      ? "bg-primary text-white border-primary"
                      : "bg-background text-muted-foreground border-border hover:border-primary/40 hover:text-foreground",
                  )}
                >
                  {sector.nombre}
                </button>
              );
            })}
          </div>
        )}
        {selected.size === 0 && activeSectors.length > 0 && (
          <p className="text-xs text-amber-600 mt-2">Sin sectores → solo ve "Consultas Generales"</p>
        )}
      </CardContent>
    </Card>
  );
}
