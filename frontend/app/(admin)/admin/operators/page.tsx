"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Plus, Trash2, MoreVertical, Pencil, AlertTriangle, Users, UserPlus, User } from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader, CountChip } from "@/components/layout/page-header";
import { FormSheet } from "@/components/layout/form-sheet";
import { api, apiClient, type SectorRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
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
  // Invitación por email (default): el operador define su propia contraseña
  // desde el enlace — además verifica que el email esté bien escrito.
  const [inviteMode, setInviteMode]       = useState(true);
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

  // Sectores de TODOS los operadores en una sola request (evita el N+1 de una
  // query por card). Cada card recibe su lista por prop desde este mapa.
  const { data: sectorsMap = {}, isLoading: loadingSectorsMap } = useQuery({
    queryKey: ["operators-sectors-map"],
    queryFn: api.sectors.getOperatorsSectorsMap,
    staleTime: 30_000,
  });

  const activeSectors = useMemo(() => sectors.filter(s => s.is_active), [sectors]);
  const defaultSectorId = useMemo(() => activeSectors.find(s => s.is_default)?.id ?? null, [activeSectors]);

  // Cuando se abre el panel, pre-seleccionar el sector default. Si el admin
  // no toca nada, el operador queda con "Consultas Generales".
  useEffect(() => {
    if (showCreate) {
      setCreateSectors(defaultSectorId ? new Set([defaultSectorId]) : new Set());
    }
  }, [showCreate, defaultSectorId]);

  const createM = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post("/admin/operators", {
        name: name.trim(),
        email: email.trim(),
        ...(inviteMode ? {} : { password }),
      });
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
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      if (data?.invitation_sent === true) {
        toast({ title: "Invitación enviada", description: `${data.email} va a recibir un email para definir su contraseña.`, variant: "success" });
      } else if (data?.invitation_sent === false) {
        toast({ title: "Operador creado, pero el email no salió", description: "Pedile que use «¿Olvidaste tu contraseña?» en el login, o editá el usuario para verificar el email.", variant: "destructive" });
      } else {
        toast({ title: "Operador creado", variant: "success" });
      }
      setShowCreate(false);
      setName(""); setEmail(""); setPassword(""); setInviteMode(true);
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

  const onlineCount = operatorsFiltered.filter(o => onlineIds.has(o.id)).length;

  return (
    <PageShell>
      <PageHeader
        title="Operadores"
        badge={!loadingOps ? (
          <CountChip>
            {operatorsFiltered.length} {operatorsFiltered.length === 1 ? "activo" : "activos"}
            {onlineCount > 0 && <span className="text-success"> · {onlineCount} en línea</span>}
          </CountChip>
        ) : undefined}
        description="Creá operadores y asignales los sectores que pueden atender."
        actions={
          <Button onClick={() => setShowCreate(true)} className="shrink-0">
            <Plus className="h-[18px] w-[18px] mr-1.5" /> Nuevo operador
          </Button>
        }
      />

      {/* Grid de operadores — misma anatomía de card que Sectores */}
      {loadingOps || loadingSectors ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-44 rounded-2xl" />)}
        </div>
      ) : operatorsFiltered.length === 0 ? (
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
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {operatorsFiltered.map(op => (
            <OperatorCard
              key={op.id}
              operator={op}
              sectors={sectors}
              assignedSectors={sectorsMap[op.id] ?? []}
              assignedLoading={loadingSectorsMap}
              isOnline={onlineIds.has(op.id)}
              onDeleted={() => qc.invalidateQueries({ queryKey: ["operators"] })}
            />
          ))}
        </div>
      )}

      {/* Panel crear */}
      <FormSheet
        open={showCreate}
        onOpenChange={setShowCreate}
        icon={UserPlus}
        title="Nuevo operador"
        description="Datos de acceso y los sectores que va a atender."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button
              onClick={() => createM.mutate()}
              disabled={
                !name.trim() ||
                !email.trim() ||
                (!inviteMode && password.length < 8) ||
                createSectors.size === 0 ||
                createM.isPending
              }
            >
              {createM.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Crear operador
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="op-name">Nombre</Label>
            <Input id="op-name" placeholder="María García" value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="op-email">Email</Label>
            <Input id="op-email" type="email" placeholder="maria@empresa.com" value={email} onChange={e => setEmail(e.target.value)} />
          </div>
          {/* Credenciales: invitación por email (default) o contraseña manual */}
          <div className="space-y-2">
            <Label>Acceso</Label>
            <div className="space-y-1.5">
              <label className="flex items-start gap-2.5 rounded-lg border p-3 cursor-pointer transition-colors has-[:checked]:border-action/40 has-[:checked]:bg-action/[0.04]">
                <input
                  type="radio" name="op-access" checked={inviteMode}
                  onChange={() => setInviteMode(true)} className="mt-0.5"
                />
                <span className="text-sm">
                  <span className="font-medium">Enviar invitación por email</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    Recibe un enlace para definir su propia contraseña (vence en 72 hs). Recomendado: verifica que el email sea correcto.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 rounded-lg border p-3 cursor-pointer transition-colors has-[:checked]:border-action/40 has-[:checked]:bg-action/[0.04]">
                <input
                  type="radio" name="op-access" checked={!inviteMode}
                  onChange={() => setInviteMode(false)} className="mt-0.5"
                />
                <span className="text-sm flex-1">
                  <span className="font-medium">Definir contraseña ahora</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    Vos se la comunicás al operador por otro medio.
                  </span>
                </span>
              </label>
            </div>
            {!inviteMode && (
              <Input
                id="op-password" type="password" placeholder="Mínimo 8 caracteres"
                value={password} onChange={e => setPassword(e.target.value)}
                className="animate-fade-in"
              />
            )}
          </div>

          <div className="space-y-2 pt-1">
            <Label>Sectores que puede atender</Label>
            {activeSectors.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No hay sectores activos. Creá sectores primero desde la sección "Sectores".
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {activeSectors.map(sector => (
                  <SectorChip
                    key={sector.id}
                    label={sector.nombre}
                    isDefault={sector.is_default}
                    selected={createSectors.has(sector.id)}
                    onToggle={() => toggleCreateSector(sector.id)}
                  />
                ))}
              </div>
            )}
            {createSectors.size === 0 && activeSectors.length > 0 && (
              <p className="text-xs text-warning">
                Seleccioná al menos un sector. Sin sectores el operador no recibe consultas.
              </p>
            )}
          </div>
        </div>
      </FormSheet>
    </PageShell>
  );
}

// ── Card de operador ─────────────────────────────────────────────────────────
// Misma anatomía que la card de Sectores: tile + menú arriba, nombre + pill de
// estado, texto secundario y footer con la info clave. Una sola vía de
// acciones (el menú de 3 puntos) — sin botones que aparecen al hover.

function OperatorCard({
  operator, sectors, assignedSectors, assignedLoading, isOnline, onDeleted,
}: {
  operator: OperatorUser;
  sectors: SectorRow[];
  assignedSectors: Array<{ id: string; nombre: string }>;
  assignedLoading: boolean;
  isOnline: boolean;
  onDeleted: () => void;
}) {
  const activeSectors = sectors.filter(s => s.is_active);
  const [showEditData, setShowEditData]     = useState(false);
  const [showEdit, setShowEdit]             = useState(false);
  const [showDeactivate, setShowDeactivate] = useState(false);

  return (
    <>
      <div className="group flex flex-col rounded-2xl border bg-card p-5 shadow-sm transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 hover:border-action/25">
        {/* Identidad al lado del tile (layout clásico de card de persona) + menú */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-action-gradient-soft">
              <User className="h-5 w-5 text-action" />
            </div>
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <h3 className="font-semibold text-[15px] tracking-tight text-foreground truncate">{operator.name}</h3>
              {isOnline ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/[0.08] px-2 py-0.5 text-[11px] font-semibold text-success shrink-0">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" /> En línea
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-semibold text-muted-foreground shrink-0">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" /> Desconectado
                </span>
              )}
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="h-8 w-8 -mr-1 -mt-0.5 shrink-0 text-muted-foreground" aria-label="Acciones">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={() => setShowEditData(true)}>
                <Pencil className="h-4 w-4 mr-2" />
                Editar datos
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setShowEdit(true)}>
                <Users className="h-4 w-4 mr-2" />
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

        {/* Email — debajo del header, a lo ancho (como la descripción en Sectores) */}
        <p className="text-sm text-muted-foreground mt-3 truncate">{operator.email}</p>

        {/* Footer: sectores asignados */}
        <div className="mt-auto pt-4 border-t border-border/70">
          {assignedLoading ? (
            <Skeleton className="h-5 w-36 rounded-full" />
          ) : assignedSectors.length === 0 ? (
            <p className="text-xs text-warning flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Sin sectores asignados — solo recibe consultas de "Consultas Generales".
            </p>
          ) : (
            <>
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70 mb-1.5">
                Sectores que atiende
              </p>
              <div className="flex flex-wrap gap-1.5">
                {assignedSectors.map(s => (
                  <span
                    key={s.id}
                    className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-xs font-medium text-foreground/70"
                  >
                    {s.nombre}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <EditUserSheet
        open={showEditData}
        onOpenChange={setShowEditData}
        operator={operator}
        onSaved={onDeleted}
      />

      <EditSectorsSheet
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

// ── Panel editar sectores ────────────────────────────────────────────────────

function EditSectorsSheet({
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
      qc.invalidateQueries({ queryKey: ["operators-sectors-map"] });
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
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      icon={Pencil}
      title="Editar sectores"
      description={
        <>Elegí las áreas que <span className="font-medium text-foreground">{operator.name}</span> puede atender.</>
      }
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={() => saveM.mutate()} disabled={!dirty || saveM.isPending || selected.size === 0}>
            {saveM.isPending
              ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              : <Check className="h-4 w-4 mr-1.5" />}
            Guardar cambios
          </Button>
        </>
      }
    >
      {activeSectors.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">
          No hay sectores activos. Creá sectores primero desde la sección "Sectores".
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {activeSectors.map(sector => (
            <SectorChip
              key={sector.id}
              label={sector.nombre}
              isDefault={sector.is_default}
              selected={selected.has(sector.id)}
              onToggle={() => toggle(sector.id)}
            />
          ))}
        </div>
      )}
      {selected.size === 0 && activeSectors.length > 0 && (
        <p className="text-xs text-warning mt-3">
          Tenés que asignar al menos un sector. Sin sectores el operador no recibe ninguna consulta.
        </p>
      )}
    </FormSheet>
  );
}

// ── Panel editar datos del usuario (nombre / email) ──────────────────────────

function EditUserSheet({
  open, onOpenChange, operator, onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  operator: OperatorUser;
  onSaved: () => void;
}) {
  const [name, setName]   = useState(operator.name);
  const [email, setEmail] = useState(operator.email);

  // Re-sync al abrir (por si cambió en background)
  useEffect(() => {
    if (open) { setName(operator.name); setEmail(operator.email); }
  }, [open, operator.name, operator.email]);

  const dirty =
    name.trim() !== operator.name ||
    email.trim().toLowerCase() !== operator.email.toLowerCase();

  const saveM = useMutation({
    mutationFn: async () => {
      const payload: { name?: string; email?: string } = {};
      if (name.trim() !== operator.name) payload.name = name.trim();
      if (email.trim().toLowerCase() !== operator.email.toLowerCase()) payload.email = email.trim();
      await apiClient.patch(`/admin/operators/${operator.id}`, payload);
    },
    onSuccess: () => {
      onSaved();
      toast({ title: "Datos actualizados", variant: "success" });
      onOpenChange(false);
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail;
      toast({ title: typeof detail === "string" ? detail : "No se pudo guardar", variant: "destructive" });
    },
  });

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      icon={Pencil}
      title="Editar datos"
      description={<>Corregí el nombre o el email de <span className="font-medium text-foreground">{operator.name}</span>.</>}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button
            onClick={() => saveM.mutate()}
            disabled={!dirty || !name.trim() || !email.trim() || saveM.isPending}
          >
            {saveM.isPending
              ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              : <Check className="h-4 w-4 mr-1.5" />}
            Guardar cambios
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="edit-name">Nombre</Label>
          <Input id="edit-name" value={name} onChange={e => setName(e.target.value)} autoFocus />
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-email">Email</Label>
          <Input id="edit-email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
        </div>
      </div>
    </FormSheet>
  );
}

// ── Confirmación de eliminación ──────────────────────────────────────────────

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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3 text-left">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <div className="min-w-0 space-y-1.5 pt-0.5">
              <DialogTitle>Eliminar operador</DialogTitle>
              <DialogDescription>
                <span className="font-medium text-foreground">{operator.name}</span> ya no va a recibir
                conversaciones. Las conversaciones que tenga abiertas vuelven a la cola.
              </DialogDescription>
            </div>
          </div>
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

// ── Chip de sector seleccionable (compartido por crear y editar) ─────────────
// Toggle con check + acento de marca. Un solo estilo para los dos paneles.

function SectorChip({
  label, selected, onToggle, isDefault,
}: {
  label: string;
  selected: boolean;
  onToggle: () => void;
  isDefault?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "bg-action/10 border-action/40 text-action"
          : "bg-background border-border text-muted-foreground hover:border-action/40 hover:text-foreground",
      )}
    >
      {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
      {label}
      {isDefault && <span className="opacity-60 text-xs font-normal">· predet.</span>}
    </button>
  );
}
