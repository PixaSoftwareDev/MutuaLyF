"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Plus, Trash2, MoreVertical, Pencil, AlertTriangle, Users } from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";
import { apiClient } from "@/lib/api";
import { api, type SectorRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { EmptyState } from "@/components/ui/empty-state";
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
  const [showCreate, setShowCreate]       = useState(false);
  const [name, setName]                   = useState("");
  const [email, setEmail]                 = useState("");
  const [password, setPassword]           = useState("");
  const [createSectors, setCreateSectors] = useState<Set<string>>(new Set());

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

  const { data: presenceData } = useQuery({
    queryKey: ["operator-presence"],
    queryFn: api.operator.presence,
    refetchInterval: 15_000,
  });
  const onlineIds = new Set((presenceData?.operators ?? []).map(o => o.user_id));

  const activeSectors = useMemo(() => sectors.filter(s => s.is_active), [sectors]);
  const defaultSectorId = useMemo(() => activeSectors.find(s => s.is_default)?.id ?? null, [activeSectors]);

  // Cuando se abre el modal, pre-seleccionar el sector default. Si el admin
  // no toca nada, el operador queda con "Consultas Generales".
  useEffect(() => {
    if (showCreate) {
      setCreateSectors(defaultSectorId ? new Set([defaultSectorId]) : new Set());
    }
  }, [showCreate, defaultSectorId]);

  const createM = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post("/admin/operators", { name: name.trim(), email: email.trim(), password });
      const newId = data?.id;
      // Si el admin seleccionó sectores distintos al default-único, reasignamos.
      // (El backend ya asigna el default automáticamente al crear, así que un
      // único sector === default lo dejamos pasar sin segunda llamada.)
      const selected = Array.from(createSectors);
      const isDefaultOnly = selected.length === 1 && selected[0] === defaultSectorId;
      if (newId && selected.length > 0 && !isDefaultOnly) {
        await api.sectors.assignOperatorSectors(newId, selected);
      }
      return data;
    },
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

  const toggleCreateSector = (id: string) => {
    setCreateSectors(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const operatorsFiltered = operators
    .filter(o => o.role === "operator" && o.is_active)
    .sort((a, b) => (onlineIds.has(b.id) ? 1 : 0) - (onlineIds.has(a.id) ? 1 : 0));

  return (
    <PageShell>
      <PageHeader
        eyebrow="Equipo"
        title="Operadores"
        description="Creá operadores y asignales los sectores que pueden atender."
        actions={
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Nuevo operador
          </Button>
        }
      />

      {/* List */}
      {loadingOps || loadingSectors ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-32 rounded-lg" />)}
        </div>
      ) : operatorsFiltered.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Users}
              title="No hay operadores activos"
              description="Creá el primero para empezar a asignar sectores y atender consultas."
              action={
                <Button size="sm" onClick={() => setShowCreate(true)}>
                  <Plus className="h-4 w-4 mr-1" />
                  Nuevo operador
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {operatorsFiltered.map(op => (
            <OperatorCard key={op.id} operator={op} sectors={sectors} isOnline={onlineIds.has(op.id)} onDeleted={() => qc.invalidateQueries({ queryKey: ["operators"] })} />
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
            <div className="space-y-1.5 pt-1">
              <Label>Sectores que puede atender</Label>
              {activeSectors.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No hay sectores activos. Creá sectores primero desde la sección "Sectores".
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {activeSectors.map(sector => {
                    const isSelected = createSectors.has(sector.id);
                    return (
                      <button
                        key={sector.id}
                        type="button"
                        onClick={() => toggleCreateSector(sector.id)}
                        className={cn(
                          "px-2.5 py-1 rounded-md text-xs border transition-colors",
                          isSelected
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background text-muted-foreground border-border hover:border-primary/40 hover:text-foreground",
                        )}
                      >
                        {sector.nombre}
                        {sector.is_default && <span className="ml-1 opacity-60">(default)</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              {createSectors.size === 0 && activeSectors.length > 0 && (
                <p className="text-xs text-warning">
                  Seleccioná al menos un sector. Sin sectores el operador no recibe consultas.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button
              onClick={() => createM.mutate()}
              disabled={
                !name.trim() ||
                !email.trim() ||
                password.length < 8 ||
                createSectors.size === 0 ||
                createM.isPending
              }
            >
              {createM.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Crear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function OperatorCard({
  operator, sectors, isOnline, onDeleted,
}: {
  operator: OperatorUser;
  sectors: SectorRow[];
  isOnline: boolean;
  onDeleted: () => void;
}) {
  const activeSectors = sectors.filter(s => s.is_active);
  const [showEdit, setShowEdit]       = useState(false);
  const [showDeactivate, setShowDeactivate] = useState(false);

  const { data: assignedSectors = [], isLoading: assignedLoading } = useQuery({
    queryKey: ["operator-sectors", operator.id],
    queryFn: () => api.sectors.getOperatorSectors(operator.id),
    staleTime: 30_000,
  });

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              {/* Avatar — neutral bg, status communicated by the dot only */}
              <div className="relative shrink-0">
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold bg-muted text-muted-foreground">
                  {operator.name.charAt(0).toUpperCase()}
                </div>
                <span className={cn(
                  "absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white",
                  isOnline ? "bg-success" : "bg-muted-foreground/30"
                )} />
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-sm truncate">{operator.name}</p>
                <p className="text-xs text-muted-foreground truncate">{operator.email}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {isOnline
                ? <Badge className="text-xs bg-success/10 text-success border-success/20 hover:bg-success/10">En línea</Badge>
                : <Badge variant="secondary" className="text-xs">Desconectado</Badge>
              }
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Acciones">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onSelect={() => setShowEdit(true)}>
                    <Pencil className="h-4 w-4 mr-2" />
                    Editar sectores
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => setShowDeactivate(true)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Eliminar
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-2">Sectores asignados</p>
          {assignedLoading ? (
            <Skeleton className="h-7 w-48 rounded-md" />
          ) : assignedSectors.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              Sin sectores asignados — solo recibe consultas de "Consultas Generales".
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {assignedSectors.map(s => (
                <Badge key={s.id} variant="secondary" className="text-xs font-normal">
                  {s.nombre}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <EditSectorsDialog
        open={showEdit}
        onOpenChange={setShowEdit}
        operator={operator}
        activeSectors={activeSectors}
        initialAssigned={assignedSectors.map(s => s.id)}
      />

      <DeactivateDialog
        open={showDeactivate}
        onOpenChange={setShowDeactivate}
        operator={operator}
        onDeactivated={onDeleted}
      />
    </>
  );
}

// ── Edit sectors modal ───────────────────────────────────────────────────────

function EditSectorsDialog({
  open, onOpenChange, operator, activeSectors, initialAssigned,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  operator: OperatorUser;
  activeSectors: SectorRow[];
  initialAssigned: string[];
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set(initialAssigned));

  // Re-sync on open (in case assignments changed in background)
  useEffect(() => {
    if (open) setSelected(new Set(initialAssigned));
  }, [open, initialAssigned]);

  const initialSet = useMemo(() => new Set(initialAssigned), [initialAssigned]);
  const dirty = useMemo(() => {
    if (selected.size !== initialSet.size) return true;
    for (const id of selected) if (!initialSet.has(id)) return true;
    return false;
  }, [selected, initialSet]);

  const saveM = useMutation({
    mutationFn: () => api.sectors.assignOperatorSectors(operator.id, Array.from(selected)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operator-sectors", operator.id] });
      toast({ title: `Sectores de ${operator.name} actualizados`, variant: "success" });
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? "Error al guardar";
      toast({ title: detail, variant: "destructive" });
    },
  });

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Editar sectores</DialogTitle>
          <DialogDescription>
            Elegí las áreas que <span className="font-medium text-foreground">{operator.name}</span> puede atender.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          {activeSectors.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No hay sectores activos. Creá sectores primero desde la sección "Sectores".
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {activeSectors.map(sector => {
                const isSelected = selected.has(sector.id);
                return (
                  <button
                    key={sector.id}
                    type="button"
                    onClick={() => toggle(sector.id)}
                    className={cn(
                      "px-3 py-1.5 rounded-lg text-sm border transition-colors",
                      isSelected
                        ? "bg-primary text-primary-foreground border-primary"
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
            <p className="text-xs text-warning mt-3">
              Tenés que asignar al menos un sector. Sin sectores el operador no recibe ninguna consulta.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={() => saveM.mutate()} disabled={!dirty || saveM.isPending || selected.size === 0}>
            {saveM.isPending
              ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              : <Check className="h-4 w-4 mr-1" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Deactivate confirm modal ─────────────────────────────────────────────────

function DeactivateDialog({
  open, onOpenChange, operator, onDeactivated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  operator: OperatorUser;
  onDeactivated: () => void;
}) {
  const deleteM = useMutation({
    mutationFn: () => apiClient.delete(`/admin/operators/${operator.id}`),
    onSuccess: () => {
      toast({ title: `${operator.name} eliminado`, variant: "success" });
      onDeactivated();
      onOpenChange(false);
    },
    onError: () => toast({ title: "Error al eliminar", variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Eliminar operador
          </DialogTitle>
          <DialogDescription className="pt-2">
            <span className="font-medium text-foreground">{operator.name}</span> ya no va a recibir
            conversaciones. Las conversaciones que tenga abiertas vuelven a la cola.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleteM.isPending}>
            Cancelar
          </Button>
          <Button variant="destructive" onClick={() => deleteM.mutate()} disabled={deleteM.isPending}>
            {deleteM.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Eliminar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
